#!/usr/bin/env python3
"""Hermetic tests for the Antigravity Account Switcher CLI."""

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

    def test_snapshot_drops_tokens_from_other_accounts(self):
        self.write_token("cliToken", make_token("stale-cli@example.com", "cli-access", "cli-refresh"))
        self.write_token("standaloneToken", make_token("ide@example.com", "ide-access", "ide-refresh"))
        entry = switch.snapshot_active_account("IDE")
        self.assertEqual(entry["email"], "ide@example.com")
        self.assertEqual(entry["file_tokens"]["cliToken"]["token"]["access_token"], "ide-access")
        self.assertEqual(entry["file_tokens"]["standaloneToken"]["token"]["access_token"], "ide-access")
        profiles = switch.load_profiles()
        self.assertEqual(
            profiles["ide@example.com"]["file_tokens"]["cliToken"]["token"]["access_token"],
            "ide-access",
        )

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

    def test_restore_clears_stale_database_keys(self):
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
        self.assertIsNone(self.read_db_value("antigravityUnifiedStateSync.oauthToken"))

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
