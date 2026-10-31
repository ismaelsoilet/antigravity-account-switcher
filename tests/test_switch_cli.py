#!/usr/bin/env python3
"""Hermetic tests for the Antigravity Account Switcher CLI."""

import contextlib
import io
import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import switch  # noqa: E402


def make_token(email, access="access-token", refresh="refresh-token", expiry="2099-01-01T00:00:00Z"):
    return {
        "token": {
            "access_token": access,
            "refresh_token": refresh,
            "token_type": "Bearer",
            "expiry": expiry,
        },
        "auth_method": "consumer",
        "id_token_email": email,
    }


class TestSwitchCLI(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="agy_cli_test_")
        self.home = os.path.join(self.root, "home")
        self.home2 = os.path.join(self.root, "home2")
        self.db_path = os.path.join(self.root, "db", "state.vscdb")
        os.makedirs(self.home, exist_ok=True)
        os.makedirs(self.home2, exist_ok=True)
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

        self.previous_home = os.environ.get("AGY_SWITCH_HOME")
        self.previous_db = os.environ.get("AGY_SWITCH_DB_PATHS")
        os.environ["AGY_SWITCH_HOME"] = self.home
        os.environ["AGY_SWITCH_DB_PATHS"] = self.db_path

        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
        conn.commit()
        conn.close()
        switch.last_warnings()
        switch._LAST_WARNINGS.clear()

    def tearDown(self):
        if self.previous_home is None:
            os.environ.pop("AGY_SWITCH_HOME", None)
        else:
            os.environ["AGY_SWITCH_HOME"] = self.previous_home
        if self.previous_db is None:
            os.environ.pop("AGY_SWITCH_DB_PATHS", None)
        else:
            os.environ["AGY_SWITCH_DB_PATHS"] = self.previous_db
        shutil.rmtree(self.root, ignore_errors=True)

    def token_path(self, category):
        return switch.get_token_file_paths()[category][0]

    def write_token(self, category, data):
        target = self.token_path(category)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(data, handle)

    def set_db_rows(self, rows):
        conn = sqlite3.connect(self.db_path)
        conn.execute("DELETE FROM ItemTable")
        conn.executemany(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
            list(rows.items()),
        )
        conn.commit()
        conn.close()

    def read_db_value(self, key):
        conn = sqlite3.connect(self.db_path)
        row = conn.execute("SELECT value FROM ItemTable WHERE key = ?", (key,)).fetchone()
        conn.close()
        return row[0] if row else None

    def test_signed_out_without_token_files(self):
        session = switch.detect_active_session()
        self.assertFalse(session["is_active"])
        self.assertFalse(session["has_token"])
        self.assertEqual(session["email"], "")
        self.assertIsNone(session["source"])

    def test_detects_cli_token_and_normalizes_email(self):
        self.write_token("cliToken", make_token("Mixed.Case@Example.com"))
        session = switch.detect_active_session()
        self.assertTrue(session["is_active"])
        self.assertEqual(session["email"], "mixed.case@example.com")
        self.assertEqual(session["category"], "cliToken")

    def test_prefers_standalone_token_over_conflicting_cli_token(self):
        self.write_token("cliToken", make_token("stale-cli@example.com", "cli-access", "cli-refresh"))
        self.write_token("standaloneToken", make_token("ide@example.com", "ide-access", "ide-refresh"))
        session = switch.detect_active_session()
        self.assertTrue(session["is_active"])
        self.assertEqual(session["email"], "ide@example.com")
        self.assertEqual(session["category"], "standaloneToken")

    def test_snapshot_refuses_to_save_while_stores_disagree(self):
        self.write_token("cliToken", make_token("stale-cli@example.com", "cli-access", "cli-refresh"))
        self.write_token("standaloneToken", make_token("ide@example.com", "ide-access", "ide-refresh"))
        with self.assertRaisesRegex(RuntimeError, "stores disagree"):
            switch.snapshot_active_account("IDE")

    def test_read_current_file_tokens_filters_other_accounts(self):
        self.write_token("cliToken", make_token("stale-cli@example.com", "cli-access", "cli-refresh"))
        self.write_token("standaloneToken", make_token("ide@example.com", "ide-access", "ide-refresh"))
        file_tokens = switch.read_current_file_tokens("ide@example.com")
        self.assertEqual(file_tokens["cliToken"]["token"]["access_token"], "ide-access")
        self.assertEqual(file_tokens["standaloneToken"]["token"]["access_token"], "ide-access")
        self.assertEqual(file_tokens["cliToken"]["id_token_email"], "ide@example.com")

    def test_expired_access_token_requires_refresh_token(self):
        self.write_token("cliToken", make_token("expired@example.com", "expired", "", "2020-01-01T00:00:00Z"))
        self.assertFalse(switch.detect_active_session()["is_active"])

        self.write_token("cliToken", make_token("refreshable@example.com", "expired", "refresh", "2020-01-01T00:00:00Z"))
        session = switch.detect_active_session()
        self.assertTrue(session["is_active"])
        self.assertEqual(session["email"], "refreshable@example.com")

    def test_snapshot_is_canonical_and_private(self):
        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "work@company.com", "apiKey": "key"}),
            "google.google-antigravity": json.dumps({
                "antigravity-storage": {
                    "agy.onboarding.lastLoginUsername": "work@company.com",
                    "otherSetting": "preserved",
                }
            }),
        })
        self.write_token("cliToken", make_token("work@company.com"))

        entry = switch.snapshot_active_account("Work")
        self.assertEqual(entry["email"], "work@company.com")
        self.assertEqual(entry["label"], "Work")
        self.assertIn("cliToken", entry["file_tokens"])
        self.assertIn("standaloneToken", entry["file_tokens"])
        self.assertEqual(entry["file_tokens"]["standaloneToken"]["token"]["refresh_token"], "refresh-token")

        profiles = switch.load_profiles()
        self.assertIn("work@company.com", profiles)
        self.assertEqual(profiles["work@company.com"]["label"], "Work")

        profile_path = os.path.join(self.home, ".gemini", "antigravity_profiles.json")
        self.assertEqual(stat.S_IMODE(os.stat(profile_path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.token_path("cliToken")).st_mode), 0o600)

    def test_manual_email_must_match_the_active_session(self):
        with self.assertRaisesRegex(RuntimeError, "No active Antigravity session"):
            switch.snapshot_active_account("Ghost", "ghost@example.com")

        self.write_token("cliToken", make_token("real@example.com"))
        with self.assertRaisesRegex(RuntimeError, "active session belongs"):
            switch.snapshot_active_account("Ghost", "ghost@example.com")

    def test_snake_case_profile_is_migrated_and_restored(self):
        profile_path = os.path.join(self.home, ".gemini", "antigravity_profiles.json")
        os.makedirs(os.path.dirname(profile_path), exist_ok=True)
        with open(profile_path, "w", encoding="utf-8") as handle:
            json.dump({
                "legacy@example.com": {
                    "email": "legacy@example.com",
                    "name": "Legacy",
                    "saved_at": "2026-01-01T00:00:00Z",
                    "tokens": {},
                    "file_tokens": {
                        "cli_token": make_token("legacy@example.com", "legacy-access", "legacy-refresh"),
                        "standalone_token": None,
                        "oauth_creds": None,
                    },
                }
            }, handle)

        profiles = switch.load_profiles()
        entry = profiles["legacy@example.com"]
        self.assertEqual(entry["label"], "Legacy")
        self.assertEqual(entry["file_tokens"]["cliToken"]["token"]["access_token"], "legacy-access")
        self.assertEqual(entry["file_tokens"]["standaloneToken"]["token"]["refresh_token"], "legacy-refresh")

        switch.restore_profile(entry)
        with open(self.token_path("cliToken"), "r", encoding="utf-8") as handle:
            cli = json.load(handle)
        with open(self.token_path("standaloneToken"), "r", encoding="utf-8") as handle:
            standalone = json.load(handle)
        self.assertEqual(cli["id_token_email"], "legacy@example.com")
        self.assertEqual(standalone["token"]["access_token"], "legacy-access")

    def test_restore_replaces_stale_cli_token_from_standalone_only_profile(self):
        self.write_token("cliToken", make_token("old@example.com", "old", "old-refresh"))
        self.write_token("standaloneToken", make_token("old@example.com", "old", "old-refresh"))

        switch.save_profiles({
            "new@example.com": {
                "email": "new@example.com",
                "label": "New",
                "db_tokens": {},
                "file_tokens": {
                    "cliToken": None,
                    "standaloneToken": make_token("new@example.com", "new", "new-refresh"),
                    "oauthCreds": None,
                },
            }
        })
        switch.restore_profile(switch.load_profiles()["new@example.com"])

        with open(self.token_path("cliToken"), "r", encoding="utf-8") as handle:
            cli = json.load(handle)
        self.assertEqual(cli["token"]["access_token"], "new")
        self.assertEqual(cli["id_token_email"], "new@example.com")
        self.assertEqual(switch.detect_active_session()["email"], "new@example.com")

    def test_restore_removes_token_categories_absent_from_profile(self):
        self.write_token("cliToken", make_token("old@example.com"))
        self.write_token("standaloneToken", make_token("old@example.com"))

        switch.restore_profile({
            "email": "oauth@example.com",
            "db_tokens": {},
            "file_tokens": {
                "oauthCreds": {
                    "access_token": "oauth-access",
                    "refresh_token": "oauth-refresh",
                    "id_token_email": "oauth@example.com",
                }
            },
        })

        self.assertFalse(os.path.exists(self.token_path("cliToken")))
        self.assertFalse(os.path.exists(self.token_path("standaloneToken")))
        self.assertEqual(switch.detect_active_session()["email"], "oauth@example.com")

    def test_restore_preserves_database_keys_absent_from_profile(self):
        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "a@example.com", "apiKey": "a-key"}),
            "google.google-antigravity": json.dumps({
                "antigravity-storage": {
                    "agy.onboarding.lastLoginUsername": "a@example.com",
                    "otherSetting": "from-a",
                }
            }),
            "antigravityUnifiedStateSync.userStatus": json.dumps({"plan": "a"}),
        })
        self.write_token("cliToken", make_token("a@example.com"))
        saved = switch.snapshot_active_account("A", "a@example.com")
        self.assertTrue(saved["complete"])

        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "b@example.com", "apiKey": "b-key"}),
            "google.google-antigravity": json.dumps({
                "antigravity-storage": {
                    "agy.onboarding.lastLoginUsername": "b@example.com",
                    "otherSetting": "from-b",
                }
            }),
            "antigravityUnifiedStateSync.oauthToken": json.dumps({"token": "stale-b"}),
        })

        switch.restore_profile(saved)

        status = json.loads(self.read_db_value("antigravityAuthStatus"))
        google = json.loads(self.read_db_value("google.google-antigravity"))
        self.assertEqual(status["email"], "a@example.com")
        self.assertEqual(google["antigravity-storage"]["agy.onboarding.lastLoginUsername"], "a@example.com")
        self.assertEqual(google["antigravity-storage"]["otherSetting"], "from-a")
        self.assertEqual(json.loads(self.read_db_value("antigravityUnifiedStateSync.oauthToken"))["token"], "stale-b")

    def test_snapshot_marks_complete_and_restores_full_database(self):
        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "full@example.com", "apiKey": "full-key"}),
            "google.google-antigravity": json.dumps({
                "antigravity-storage": {"agy.onboarding.lastLoginUsername": "full@example.com"}
            }),
            "antigravityUnifiedStateSync.oauthToken": json.dumps({"token": "full-oauth"}),
            "antigravityUnifiedStateSync.userStatus": json.dumps({"plan": "full"}),
            "antigravityUnifiedStateSync.modelCredits": json.dumps({"credits": 42}),
        })
        self.write_token("cliToken", make_token("full@example.com"))
        saved = switch.snapshot_active_account("Full", "full@example.com")

        self.assertTrue(saved["complete"])
        self.assertIn(self.db_path, saved["db_tokens_by_path"])
        self.assertEqual(
            json.loads(saved["db_tokens_by_path"][self.db_path]["antigravityUnifiedStateSync.oauthToken"])["token"],
            "full-oauth",
        )

        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "other@example.com"}),
            "antigravityUnifiedStateSync.oauthToken": json.dumps({"token": "other-oauth"}),
            "antigravityUnifiedStateSync.userStatus": json.dumps({"plan": "other"}),
            "antigravityUnifiedStateSync.modelCredits": json.dumps({"credits": 1}),
        })

        switch.restore_profile(saved)

        self.assertEqual(json.loads(self.read_db_value("antigravityAuthStatus"))["email"], "full@example.com")
        self.assertEqual(json.loads(self.read_db_value("antigravityUnifiedStateSync.oauthToken"))["token"], "full-oauth")
        self.assertEqual(json.loads(self.read_db_value("antigravityUnifiedStateSync.userStatus"))["plan"], "full")
        self.assertEqual(json.loads(self.read_db_value("antigravityUnifiedStateSync.modelCredits"))["credits"], 42)

    def test_detects_conflicting_homes_and_keeps_desired_account(self):
        os.environ["AGY_SWITCH_HOME"] = f"{self.home}{os.pathsep}{self.home2}"
        self.write_token("standaloneToken", make_token("wsl@example.com", "wsl", "wsl-refresh"))
        standalone_paths = switch.get_token_file_paths()["standaloneToken"]
        self.assertEqual(len(standalone_paths), 2)
        os.makedirs(os.path.dirname(standalone_paths[1]), exist_ok=True)
        with open(standalone_paths[1], "w", encoding="utf-8") as handle:
            json.dump(make_token("win@example.com", "win", "win-refresh"), handle)

        session = switch.detect_sessions()
        self.assertEqual(session["email"], "wsl@example.com")
        self.assertTrue(any(conflict["type"] == "multiple-emails" for conflict in session["conflicts"]))

        switch.write_switch_state({"targetEmail": "win@example.com"})
        stable = switch.detect_sessions()
        self.assertEqual(stable["email"], "win@example.com")
        self.assertTrue(any(conflict["type"] == "target-mismatch" for conflict in stable["conflicts"]))

    def test_switch_lock_blocks_concurrent_switches(self):
        with switch.acquire_switch_lock():
            with self.assertRaises(RuntimeError):
                with switch.acquire_switch_lock():
                    pass
        with switch.acquire_switch_lock():
            pass

    def test_db_identity_alone_is_not_a_session(self):
        self.set_db_rows({"antigravityAuthStatus": json.dumps({"email": "dbonly@example.com", "apiKey": ""})})
        session = switch.detect_active_session()
        self.assertFalse(session["is_active"])
        self.assertFalse(session["has_token"])
        self.assertEqual(session["email"], "")
        self.assertTrue(any(store["kind"] == "database" and store["email"] == "dbonly@example.com" for store in session["stores"]))
        self.assertEqual(session["conflicts"], [])

    def test_current_is_not_active_without_email(self):
        self.write_token("cliToken", {"token": {"access_token": "access", "refresh_token": "refresh"}})
        session = switch.detect_active_session()
        self.assertFalse(session["is_active"])
        self.assertTrue(session["has_token"])

    def test_current_json_is_not_active_for_db_identity_only(self):
        self.set_db_rows({"antigravityAuthStatus": json.dumps({"email": "dbonly@example.com", "apiKey": ""})})
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertEqual(switch.cmd_current(as_json=True), 0)
        payload = json.loads(buffer.getvalue())
        self.assertFalse(payload["is_active"])
        self.assertEqual(payload["email"], "")

    def test_non_token_database_value_is_not_a_session(self):
        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "legacy@example.com", "apiKey": ""}),
            "antigravityUnifiedStateSync.oauthToken": "{}",
        })
        session = switch.detect_active_session()
        self.assertFalse(session["is_active"])
        self.assertFalse(session["has_token"])

        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "legacy@example.com", "apiKey": ""}),
            "antigravityUnifiedStateSync.oauthToken": "serialized-proto-blob",
        })
        session = switch.detect_active_session()
        self.assertTrue(session["is_active"])
        self.assertTrue(session["has_token"])
        self.assertEqual(session["category"], "database")

    def test_diff_against_switch_state_classifies_refresh_conflict_missing(self):
        self.write_token("standaloneToken", make_token("same@example.com", "v1", "r1"))
        switch.write_switch_state({
            "targetEmail": "same@example.com",
            "files": switch.get_store_snapshot()["files"],
            "databases": [],
        })

        self.write_token("standaloneToken", make_token("same@example.com", "v2", "r2"))
        diff = switch.diff_against_switch_state(switch.read_switch_state())
        self.assertEqual(diff["conflicts"], [])
        self.assertTrue(any(item["path"] == self.token_path("standaloneToken") for item in diff["refreshes"]))

        self.write_token("standaloneToken", make_token("other@example.com", "v3", "r3"))
        diff = switch.diff_against_switch_state(switch.read_switch_state())
        self.assertTrue(any(item["kind"] == "file" and item["email"] == "other@example.com" for item in diff["conflicts"]))

        os.unlink(self.token_path("standaloneToken"))
        diff = switch.diff_against_switch_state(switch.read_switch_state())
        self.assertTrue(any(item["path"] == self.token_path("standaloneToken") for item in diff["missing"]))

    def test_diff_reports_missing_database(self):
        missing_db = os.path.join(self.root, "gone", "state.vscdb")
        switch.write_switch_state({
            "targetEmail": "missing@example.com",
            "files": [],
            "databases": [{"path": missing_db, "email": "missing@example.com"}],
        })
        diff = switch.diff_against_switch_state(switch.read_switch_state())
        self.assertTrue(any(item["kind"] == "database" and item["path"] == missing_db for item in diff["missing"]))

    def test_cmd_load_refuses_incomplete_profile(self):
        switch.save_profiles({
            "incomplete@example.com": {
                "email": "incomplete@example.com",
                "label": "Incomplete",
                "complete": False,
                "db_tokens": {},
                "file_tokens": {"standaloneToken": make_token("incomplete@example.com")},
            }
        })
        self.assertEqual(switch.cmd_load("incomplete@example.com"), 1)

    def test_restore_skips_database_without_itemtable(self):
        empty_db = os.path.join(self.root, "empty-db", "state.vscdb")
        os.makedirs(os.path.dirname(empty_db), exist_ok=True)
        with open(empty_db, "w", encoding="utf-8"):
            pass
        os.environ["AGY_SWITCH_DB_PATHS"] = f"{self.db_path}{os.pathsep}{empty_db}"

        result = switch.restore_profile({
            "email": "skip@example.com",
            "complete": True,
            "db_tokens": {
                "antigravityAuthStatus": json.dumps({"email": "skip@example.com", "apiKey": ""})
            },
            "file_tokens": {
                "standaloneToken": make_token("skip@example.com")
            },
        })

        self.assertTrue(result["verification"]["ok"])
        self.assertTrue(any(empty_db in path for path in result["db"].get("skippedPaths", [])))

    def test_restore_reports_divergent_second_database(self):
        second_db = os.path.join(self.root, "db2", "state.vscdb")
        os.makedirs(os.path.dirname(second_db), exist_ok=True)
        conn = sqlite3.connect(second_db)
        conn.execute("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
        conn.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
            ("antigravityAuthStatus", json.dumps({"email": "other@example.com"})),
        )
        conn.commit()
        conn.close()
        os.environ["AGY_SWITCH_DB_PATHS"] = f"{self.db_path}{os.pathsep}{second_db}"

        self.set_db_rows({"antigravityAuthStatus": json.dumps({"email": "target@example.com"})})
        self.write_token("cliToken", make_token("target@example.com"))

        with self.assertRaisesRegex(RuntimeError, "Switch verification failed"):
            switch.restore_profile({
                "email": "target@example.com",
                "complete": False,
                "db_tokens": {},
                "file_tokens": {"cliToken": make_token("target@example.com")},
            })

    def test_snapshot_keeps_incomplete_warning(self):
        self.write_token("cliToken", make_token("warn@example.com"))
        entry = switch.snapshot_active_account("Warn", "warn@example.com")
        self.assertFalse(entry["complete"])
        self.assertTrue(any("database" in warning for warning in switch.last_warnings()))

    def test_restore_rolls_back_files_when_database_write_fails(self):
        self.write_token("cliToken", make_token("old@example.com", "old-access", "old-refresh"))
        os.chmod(self.db_path, 0o444)

        try:
            with self.assertRaisesRegex(RuntimeError, "Could not write the Antigravity database"):
                switch.restore_profile({
                    "email": "new@example.com",
                    "complete": False,
                    "db_tokens": {
                        "antigravityAuthStatus": json.dumps({"email": "new@example.com", "apiKey": ""})
                    },
                    "file_tokens": {
                        "cliToken": make_token("new@example.com", "new-access", "new-refresh")
                    },
                })
        finally:
            os.chmod(self.db_path, 0o600)

        with open(self.token_path("cliToken"), "r", encoding="utf-8") as handle:
            cli = json.load(handle)
        self.assertEqual(cli["id_token_email"], "old@example.com")
        self.assertEqual(cli["token"]["access_token"], "old-access")

    def test_restore_writes_token_files_to_both_homes(self):
        os.environ["AGY_SWITCH_HOME"] = f"{self.home}{os.pathsep}{self.home2}"
        switch.restore_profile({
            "email": "both@example.com",
            "complete": False,
            "db_tokens": {},
            "file_tokens": {
                "standaloneToken": make_token("both@example.com", "both-access", "both-refresh")
            },
        })

        standalone_paths = switch.get_token_file_paths()["standaloneToken"]
        self.assertEqual(len(standalone_paths), 2)
        for standalone_path in standalone_paths:
            with open(standalone_path, "r", encoding="utf-8") as handle:
                token = json.load(handle)
            self.assertEqual(token["id_token_email"], "both@example.com")
            self.assertEqual(token["token"]["access_token"], "both-access")

    def test_reset_backs_up_and_empties_vault(self):
        self.write_token("cliToken", make_token("reset@example.com"))
        switch.snapshot_active_account("Reset", "reset@example.com")
        self.assertEqual(switch.cmd_reset(True), 0)
        self.assertEqual(switch.load_profiles(), {})
        backups = [
            name for name in os.listdir(os.path.join(self.home, ".gemini"))
            if name.endswith(f".pre-{switch.VERSION}.bak")
        ]
        self.assertTrue(backups)

    def test_corrupt_vault_is_backed_up_before_overwrite(self):
        self.write_token("cliToken", make_token("recover@example.com"))
        profile_path = os.path.join(self.home, ".gemini", "antigravity_profiles.json")
        with open(profile_path, "w", encoding="utf-8") as handle:
            handle.write("this is not json")

        self.assertEqual(switch.load_profiles(), {})
        self.assertTrue(switch.last_warnings())

        switch.snapshot_active_account("Recovered", "recover@example.com")
        backups = [name for name in os.listdir(os.path.dirname(profile_path)) if ".corrupt-" in name]
        self.assertEqual(len(backups), 1)
        with open(os.path.join(os.path.dirname(profile_path), backups[0]), "r", encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "this is not json")
        self.assertIn("recover@example.com", switch.load_profiles())

    def test_empty_vault_does_not_fall_through_to_second_copy(self):
        profile_one = os.path.join(self.home, ".gemini", "antigravity_profiles.json")
        profile_two = os.path.join(self.home2, ".gemini", "antigravity_profiles.json")
        os.makedirs(os.path.dirname(profile_one), exist_ok=True)
        os.makedirs(os.path.dirname(profile_two), exist_ok=True)
        with open(profile_one, "w", encoding="utf-8") as handle:
            handle.write("{}")
        with open(profile_two, "w", encoding="utf-8") as handle:
            json.dump({
                "stale@example.com": {
                    "email": "stale@example.com",
                    "label": "Stale",
                    "db_tokens": {},
                    "file_tokens": {"cliToken": make_token("stale@example.com")},
                }
            }, handle)

        os.environ["AGY_SWITCH_HOME"] = f"{self.home}{os.pathsep}{self.home2}"
        self.assertEqual(switch.load_profiles(), {})

    def test_clear_removes_tokens_and_session_keys(self):
        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "clear@example.com", "apiKey": ""}),
            "google.google-antigravity": json.dumps({
                "antigravity-storage": {
                    "agy.onboarding.lastLoginUsername": "clear@example.com",
                    "keepMe": "yes",
                }
            }),
            "antigravityUnifiedStateSync.modelCredits": json.dumps({"credits": 10}),
        })
        self.write_token("cliToken", make_token("clear@example.com"))
        self.write_token("standaloneToken", make_token("clear@example.com"))

        switch.clear_session_tokens()

        self.assertFalse(os.path.exists(self.token_path("cliToken")))
        self.assertFalse(os.path.exists(self.token_path("standaloneToken")))
        self.assertIsNone(self.read_db_value("antigravityAuthStatus"))
        self.assertIsNone(self.read_db_value("antigravityUnifiedStateSync.modelCredits"))
        google = json.loads(self.read_db_value("google.google-antigravity"))
        self.assertNotIn("agy.onboarding.lastLoginUsername", google["antigravity-storage"])
        self.assertEqual(google["antigravity-storage"]["keepMe"], "yes")

    def test_canonical_email_aliases(self):
        self.assertEqual(switch.canonical_email("User.Name+work@googlemail.com"), "username@gmail.com")
        self.assertEqual(switch.canonical_email("User.Name@example.com"), "user.name@example.com")

    def test_database_identity_mismatch_is_reported_and_save_refused(self):
        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "auth@example.com"}),
            "google.google-antigravity": json.dumps({
                "antigravity-storage": {"agy.onboarding.lastLoginUsername": "onboard@example.com"}
            }),
        })
        self.write_token("cliToken", make_token("auth@example.com"))

        session = switch.detect_active_session()
        self.assertTrue(any(conflict["type"] == "database-identity-mismatch" for conflict in session["conflicts"]))
        with self.assertRaisesRegex(RuntimeError, "conflicting identities|stores disagree"):
            switch.snapshot_active_account("Mixed", "auth@example.com")

    def test_load_profiles_merges_gmail_aliases(self):
        profile_path = os.path.join(self.home, ".gemini", "antigravity_profiles.json")
        os.makedirs(os.path.dirname(profile_path), exist_ok=True)
        with open(profile_path, "w", encoding="utf-8") as handle:
            json.dump({
                "user@gmail.com": {
                    "email": "user@gmail.com",
                    "label": "Primary",
                    "saved_at": "2026-01-02T00:00:00Z",
                    "db_tokens": {},
                    "file_tokens": {"cliToken": make_token("user@gmail.com")},
                },
                "user+work@gmail.com": {
                    "email": "user+work@gmail.com",
                    "label": "Work",
                    "saved_at": "2026-01-01T00:00:00Z",
                    "db_tokens": {},
                    "file_tokens": {"cliToken": make_token("user+work@gmail.com")},
                },
            }, handle)

        profiles = switch.load_profiles()
        self.assertEqual(list(profiles.keys()), ["user@gmail.com"])
        self.assertIn("user+work@gmail.com", profiles["user@gmail.com"]["aliases"])

    def test_load_profiles_merges_shared_fingerprint(self):
        first = make_token("one@example.com", "a1", "same-refresh")
        second = make_token("two@example.com", "a2", "same-refresh")
        fingerprint = switch.token_fingerprint(first)
        profile_path = os.path.join(self.home, ".gemini", "antigravity_profiles.json")
        os.makedirs(os.path.dirname(profile_path), exist_ok=True)
        with open(profile_path, "w", encoding="utf-8") as handle:
            json.dump({
                "one@example.com": {
                    "email": "one@example.com",
                    "label": "One",
                    "saved_at": "2026-01-02T00:00:00Z",
                    "db_tokens": {},
                    "file_tokens": {"standaloneToken": first},
                    "fingerprints": {"standaloneToken": fingerprint},
                },
                "two@example.com": {
                    "email": "two@example.com",
                    "label": "Two",
                    "saved_at": "2026-01-01T00:00:00Z",
                    "db_tokens": {},
                    "file_tokens": {"standaloneToken": second},
                    "fingerprints": {"standaloneToken": fingerprint},
                },
            }, handle)

        profiles = switch.load_profiles()
        self.assertEqual(list(profiles.keys()), ["one@example.com"])
        self.assertIn("two@example.com", profiles["one@example.com"]["aliases"])

    def test_snapshot_makes_duplicate_labels_unique(self):
        self.write_token("cliToken", make_token("first@example.com"))
        first = switch.snapshot_active_account("Work", "first@example.com")
        self.assertEqual(first["label"], "Work")

        self.write_token("cliToken", make_token("second@example.com", "access-2", "refresh-2"))
        second = switch.snapshot_active_account("Work", "second@example.com")
        self.assertEqual(second["label"], "Work 2")

    def test_snapshot_rejects_email_contradicting_database(self):
        self.set_db_rows({"antigravityAuthStatus": json.dumps({"email": "db@example.com"})})
        self.write_token("cliToken", {"token": {"access_token": "a", "refresh_token": "r"}})

        with self.assertRaisesRegex(RuntimeError, "belongs to db@example.com"):
            switch.snapshot_active_account("Ghost", "ghost@example.com")
        entry = switch.snapshot_active_account("Db", "db@example.com")
        self.assertEqual(entry["email"], "db@example.com")

    def test_find_profile_matches_alias(self):
        profiles = {
            "user@gmail.com": {
                "email": "user@gmail.com",
                "label": "Primary",
                "aliases": ["user+work@gmail.com"],
            },
        }
        email, _ = switch.find_profile("user+work@gmail.com", profiles)
        self.assertEqual(email, "user@gmail.com")

    def test_adopt_login_session_applies_fresh_login_to_all_stores(self):
        self.write_token("cliToken", make_token("old@example.com", "old-a", "old-r"))
        self.write_token("standaloneToken", make_token("new@example.com", "new-a", "new-r"))
        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "old@example.com"}),
            "google.google-antigravity": json.dumps({
                "antigravity-storage": {"agy.onboarding.lastLoginUsername": "old@example.com"}
            }),
        })

        result = switch.adopt_login_session("new@example.com", "New")
        self.assertEqual(result["entry"]["email"], "new@example.com")

        for category in ("cliToken", "standaloneToken"):
            for token_path in switch.get_token_file_paths()[category]:
                with open(token_path, "r", encoding="utf-8") as handle:
                    token = json.load(handle)
                self.assertEqual(token["id_token_email"], "new@example.com")

        self.assertEqual(json.loads(self.read_db_value("antigravityAuthStatus"))["email"], "new@example.com")
        session = switch.detect_active_session()
        self.assertEqual(session["conflicts"], [])
        self.assertIn("new@example.com", switch.load_profiles())

    def test_cmd_adopt_switches_every_store(self):
        self.write_token("cliToken", make_token("old@example.com", "old-a", "old-r"))
        self.write_token("standaloneToken", make_token("new@example.com", "new-a", "new-r"))
        self.set_db_rows({"antigravityAuthStatus": json.dumps({"email": "old@example.com"})})

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertEqual(switch.cmd_adopt("new@example.com", "New"), 0)
        self.assertIn("new@example.com", buffer.getvalue())
        self.assertEqual(json.loads(self.read_db_value("antigravityAuthStatus"))["email"], "new@example.com")

    def test_restore_refreshes_legacy_profile_metadata(self):
        self.set_db_rows({
            "antigravityAuthStatus": json.dumps({"email": "legacy@example.com"}),
            "google.google-antigravity": json.dumps({
                "antigravity-storage": {"agy.onboarding.lastLoginUsername": "legacy@example.com"}
            }),
        })
        self.write_token("cliToken", make_token("legacy@example.com"))
        profile_path = os.path.join(self.home, ".gemini", "antigravity_profiles.json")
        with open(profile_path, "w", encoding="utf-8") as handle:
            json.dump({
                "legacy@example.com": {
                    "email": "legacy@example.com",
                    "label": "Legacy",
                    "saved_at": "2026-01-01T00:00:00Z",
                    "db_tokens": {},
                    "file_tokens": {"cliToken": make_token("legacy@example.com")},
                }
            }, handle)

        entry = switch.load_profiles()["legacy@example.com"]
        switch.restore_profile(entry)

        refreshed = switch.load_profiles()["legacy@example.com"]
        self.assertTrue(refreshed["fingerprints"].get("cliToken"))
        self.assertTrue(refreshed["account_id"])
        self.assertIn(self.db_path, refreshed["db_tokens_by_path"])
        self.assertTrue(refreshed["complete"])

    def test_find_profile_rejects_ambiguous_labels(self):
        profiles = {
            "one@example.com": {"email": "one@example.com", "label": "Work"},
            "two@example.com": {"email": "two@example.com", "label": "Work"},
        }
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            switch.find_profile("Work", profiles)
        email, _ = switch.find_profile("ONE@example.com", profiles)
        self.assertEqual(email, "one@example.com")


if __name__ == "__main__":
    unittest.main()
