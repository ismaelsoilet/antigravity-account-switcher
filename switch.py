#!/usr/bin/env python3
"""
Antigravity Account Switcher - CLI Core Engine (v1.7.0)

Manages the authentication state shared by Antigravity IDE, Antigravity Desktop
and the Antigravity CLI:

- SQLite databases (state.vscdb)
- CLI OAuth token (antigravity-cli/antigravity-oauth-token)
- Antigravity CdeAuthService token (jetski-standalone-oauth-token)
- Google OAuth credentials (oauth_creds.json)
"""

import argparse
import base64
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

VERSION = "1.7.0"
EMAIL_REGEX = re.compile(r"^[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+$")
FILE_CATEGORIES = ("cliToken", "standaloneToken", "oauthCreds")
FILE_KEY_ALIASES = {
    "cliToken": "cliToken",
    "cli_token": "cliToken",
    "standaloneToken": "standaloneToken",
    "standalone_token": "standaloneToken",
    "oauthCreds": "oauthCreds",
    "oauth_creds": "oauthCreds",
}
DB_AUTH_KEYS = [
    "antigravityUnifiedStateSync.oauthToken",
    "antigravityUnifiedStateSync.userStatus",
    "antigravityUnifiedStateSync.modelCredits",
    "antigravityAuthStatus",
    "google.google-antigravity",
]
DB_SESSION_KEYS = [key for key in DB_AUTH_KEYS if key != "google.google-antigravity"]
FILE_MODE = 0o600

_LAST_WARNINGS = []


def warn(message):
    _LAST_WARNINGS.append(message)
    sys.stderr.write(f"Warning: {message}\n")


def last_warnings():
    return list(_LAST_WARNINGS)


def is_valid_email(value):
    return bool(value and isinstance(value, str) and EMAIL_REGEX.match(value.strip()))


def normalize_email(value):
    return value.strip().lower() if is_valid_email(value) else ""


def _dedupe(values):
    return list(dict.fromkeys(values))


def _is_windows_system_user(name):
    return name.lower() in {"public", "default", "default user", "all users", "desktop.ini"}


_WIN_HOME_CACHE = {"value": None, "at": 0.0}


def _resolve_current_windows_home():
    if os.name != "posix":
        return None
    now = time.monotonic()
    if _WIN_HOME_CACHE["value"] is not None and now - _WIN_HOME_CACHE["at"] < 60:
        return _WIN_HOME_CACHE["value"] or None

    _WIN_HOME_CACHE["at"] = now
    _WIN_HOME_CACHE["value"] = ""
    try:
        raw = subprocess.run(
            ["cmd.exe", "/c", "echo %USERPROFILE%"],
            capture_output=True, text=True, timeout=2,
        ).stdout.strip()
        if not raw:
            return None
        converted = subprocess.run(
            ["wslpath", "-u", raw],
            capture_output=True, text=True, timeout=2,
        ).stdout.strip()
        if converted and os.path.isdir(converted):
            _WIN_HOME_CACHE["value"] = converted
            return converted
    except Exception:
        pass
    return None


def _windows_home_dirs():
    if os.name == "nt":
        return []

    explicit = os.environ.get("ANTIGRAVITY_WIN_HOME")
    if explicit:
        return _dedupe(part for part in explicit.split(os.pathsep) if part)

    current = _resolve_current_windows_home()
    if current:
        return [current]

    roots = []
    if os.name == "posix":
        roots.append("/mnt/c/Users")
    try:
        parent = os.path.dirname(os.path.expanduser("~"))
        if os.path.basename(parent).lower() == "users":
            roots.append(parent)
    except Exception:
        pass

    homes = []
    for root in _dedupe(roots):
        try:
            entries = os.listdir(root)
        except OSError:
            continue
        for name in entries:
            if _is_windows_system_user(name):
                continue
            full = os.path.join(root, name)
            if not os.path.isdir(full):
                continue
            if any(os.path.exists(os.path.join(full, marker)) for marker in
                   (".gemini", ".antigravity-ide", ".antigravity")):
                homes.append(full)
    return _dedupe(homes)


def get_candidate_homes():
    explicit = os.environ.get("AGY_SWITCH_HOME")
    if explicit:
        return _dedupe(part.strip() for part in explicit.split(os.pathsep) if part.strip())

    homes = []
    for home in (os.path.expanduser("~"), os.environ.get("HOME"), os.environ.get("USERPROFILE")):
        if home:
            homes.append(home)
    homes.extend(_windows_home_dirs())

    valid = []
    for home in _dedupe(homes):
        try:
            if os.path.isdir(home):
                valid.append(os.path.abspath(home))
        except OSError:
            pass
    return _dedupe(valid)


def get_gemini_dirs():
    return _dedupe(os.path.join(home, ".gemini") for home in get_candidate_homes())


def get_token_file_paths():
    gemini_dirs = get_gemini_dirs()
    return {
        "cliToken": _dedupe(os.path.join(d, "antigravity-cli", "antigravity-oauth-token") for d in gemini_dirs),
        "standaloneToken": _dedupe(os.path.join(d, "jetski-standalone-oauth-token") for d in gemini_dirs),
        "oauthCreds": _dedupe(os.path.join(d, "oauth_creds.json") for d in gemini_dirs),
    }


def get_db_paths():
    explicit = os.environ.get("AGY_SWITCH_DB_PATHS")
    if explicit:
        return _dedupe(part.strip() for part in explicit.split(os.pathsep) if part.strip())

    candidates = []
    for home in get_candidate_homes():
        candidates.extend([
            os.path.join(home, "AppData", "Roaming", "Antigravity IDE", "User", "globalStorage", "state.vscdb"),
            os.path.join(home, "AppData", "Roaming", "Antigravity", "User", "globalStorage", "state.vscdb"),
            os.path.join(home, ".config", "Antigravity IDE", "User", "globalStorage", "state.vscdb"),
            os.path.join(home, ".config", "Antigravity", "User", "globalStorage", "state.vscdb"),
            os.path.join(home, "Library", "Application Support", "Antigravity IDE", "User", "globalStorage", "state.vscdb"),
            os.path.join(home, "Library", "Application Support", "Antigravity", "User", "globalStorage", "state.vscdb"),
        ])
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.extend([
            os.path.join(appdata, "Antigravity IDE", "User", "globalStorage", "state.vscdb"),
            os.path.join(appdata, "Antigravity", "User", "globalStorage", "state.vscdb"),
        ])

    return _dedupe(path for path in candidates if os.path.exists(path))


def get_profiles_file_paths():
    return _dedupe(os.path.join(d, "antigravity_profiles.json") for d in get_gemini_dirs())


def decode_jwt_payload(jwt_str):
    if not jwt_str or not isinstance(jwt_str, str):
        return None
    parts = jwt_str.split(".")
    if len(parts) < 2:
        return None
    try:
        b64 = parts[1]
        b64 += "=" * (-len(b64) % 4)
        return json.loads(base64.urlsafe_b64decode(b64.encode("utf-8")))
    except Exception:
        return None


def _token_payload(content):
    if not isinstance(content, dict):
        return None
    token = content.get("token")
    return token if isinstance(token, dict) else content


def _non_empty(value):
    return isinstance(value, str) and bool(value.strip())


def _parse_expiry(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        stamp = value / 1000 if value > 1e12 else value
        try:
            return datetime.fromtimestamp(stamp, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
            return _parse_expiry(number)
        except ValueError:
            pass
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _is_access_token_expired(content):
    payload = _token_payload(content)
    if not payload:
        return False
    expiry = _parse_expiry(payload.get("expiry") or payload.get("expires_at") or payload.get("expiresAt"))
    if expiry is None:
        return False
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    return expiry <= datetime.now(timezone.utc)


def _has_token_strings(content):
    payload = _token_payload(content)
    if not payload:
        return False
    return _non_empty(payload.get("access_token")) or _non_empty(payload.get("refresh_token"))


def _has_usable_tokens(content):
    payload = _token_payload(content)
    if not payload:
        return False
    if _non_empty(payload.get("refresh_token")):
        return True
    if not _non_empty(payload.get("access_token")):
        return False
    return not _is_access_token_expired(content)


def _extract_email(content):
    if not isinstance(content, dict):
        return ""
    for key in ("id_token_email", "email"):
        if is_valid_email(content.get(key)):
            return normalize_email(content.get(key))

    payload = _token_payload(content)
    if payload and payload.get("id_token"):
        decoded = decode_jwt_payload(payload["id_token"])
        if decoded and is_valid_email(decoded.get("email")):
            return normalize_email(decoded["email"])
    if content.get("id_token"):
        decoded = decode_jwt_payload(content["id_token"])
        if decoded and is_valid_email(decoded.get("email")):
            return normalize_email(decoded["email"])
    return ""


def _to_text(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _safe_json(text):
    try:
        return json.loads(text)
    except Exception:
        return None


def _email_from_dbs():
    for db_path in get_db_paths():
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
            try:
                row = conn.execute(
                    "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'"
                ).fetchone()
                if row and row[0]:
                    parsed = _safe_json(_to_text(row[0]))
                    if isinstance(parsed, dict) and is_valid_email(parsed.get("email")):
                        return normalize_email(parsed["email"])
            finally:
                conn.close()
        except sqlite3.Error:
            pass
    return ""


def detect_active_session():
    file_paths = get_token_file_paths()

    for category in FILE_CATEGORIES:
        for token_path in file_paths[category]:
            if not os.path.exists(token_path):
                continue
            try:
                with open(token_path, "r", encoding="utf-8") as handle:
                    content = json.load(handle)
            except (OSError, ValueError):
                continue
            if not _has_token_strings(content) or not _has_usable_tokens(content):
                continue

            email = _extract_email(content) or _email_from_dbs()
            return {
                "is_active": True,
                "has_token": True,
                "needs_email": not bool(email),
                "email": email,
                "source": token_path,
                "category": category,
            }

    return {
        "is_active": False,
        "has_token": False,
        "needs_email": False,
        "email": "",
        "source": None,
        "category": None,
    }


def detect_active_email():
    return detect_active_session()["email"]


def normalize_file_tokens(raw):
    output = {category: None for category in FILE_CATEGORIES}
    if not isinstance(raw, dict):
        return output

    for key, value in raw.items():
        canonical = FILE_KEY_ALIASES.get(key)
        if not canonical:
            continue
        token = value
        if isinstance(token, str):
            token = _safe_json(token)
        if not isinstance(token, dict) or not _has_token_strings(token):
            continue
        output[canonical] = json.loads(json.dumps(token))

    if not output["standaloneToken"] and output["cliToken"]:
        output["standaloneToken"] = json.loads(json.dumps(output["cliToken"]))
    if not output["cliToken"] and output["standaloneToken"]:
        output["cliToken"] = json.loads(json.dumps(output["standaloneToken"]))
    return output


def normalize_db_tokens(raw):
    output = {}
    if not isinstance(raw, dict):
        return output
    for key, value in raw.items():
        text = _to_text(value)
        if text is not None:
            output[key] = text
    return output


def normalize_profile_entry(raw, fallback_key=None):
    if not isinstance(raw, dict):
        return None
    email = normalize_email(raw.get("email") or fallback_key)
    if not email:
        return None

    db_tokens = normalize_db_tokens(raw.get("db_tokens") or raw.get("tokens") or {})
    file_tokens = normalize_file_tokens(raw.get("file_tokens") or {})
    label = raw.get("label") or raw.get("name") or email.split("@")[0]
    label = label.strip() if isinstance(label, str) and label.strip() else email.split("@")[0]

    entry = dict(raw)
    entry.update({
        "email": email,
        "label": label,
        "saved_at": raw.get("saved_at") if isinstance(raw.get("saved_at"), str) else "",
        "db_tokens": db_tokens,
        "file_tokens": file_tokens,
        "tokens": db_tokens,
    })
    return entry


def normalize_profiles_map(profiles):
    output = {}
    if not isinstance(profiles, dict):
        return output
    for key, value in profiles.items():
        entry = normalize_profile_entry(value, key)
        if not entry:
            continue
        previous = output.get(entry["email"])
        if previous is None or (entry["saved_at"] and (not previous["saved_at"] or entry["saved_at"] >= previous["saved_at"])):
            output[entry["email"]] = entry
    return output


def _atomic_write(file_path, content, mode=FILE_MODE):
    directory = os.path.dirname(file_path)
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(
        dir=directory,
        prefix=f".{os.path.basename(file_path)}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        os.chmod(temp_path, mode)
        os.replace(temp_path, file_path)
        try:
            os.chmod(file_path, mode)
        except OSError:
            pass
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _backup_existing_vault(file_path):
    if not os.path.exists(file_path):
        return
    try:
        with open(file_path, "r", encoding="utf-8") as handle:
            content = handle.read()
    except OSError:
        return

    valid = _safe_json(content) is not None
    if valid:
        backup_path = f"{file_path}.bak"
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
        backup_path = f"{file_path}.corrupt-{stamp}.json"
    _atomic_write(backup_path, content, FILE_MODE)


def save_profiles(profiles):
    normalized = normalize_profiles_map(profiles)
    data = json.dumps(normalized, indent=2, ensure_ascii=False)
    targets = get_profiles_file_paths()
    if not targets:
        raise RuntimeError("No Antigravity vault path is available.")

    written = []
    failed = []
    for target in targets:
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            _backup_existing_vault(target)
            _atomic_write(target, data, FILE_MODE)
            written.append(target)
        except Exception as error:
            failed.append(f"{target}: {error}")

    if not written:
        raise RuntimeError("Could not write the profile vault. " + " | ".join(failed))
    if failed:
        raise RuntimeError("Profile vault was only partially written. " + " | ".join(failed))
    return written


def load_profiles():
    _LAST_WARNINGS.clear()
    for profile_path in get_profiles_file_paths():
        if not os.path.exists(profile_path):
            continue
        try:
            with open(profile_path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, ValueError) as error:
            warn(f"Vault is not readable ({profile_path}): {error}")
            continue
        if not isinstance(raw, dict):
            warn(f"Vault has an unexpected format: {profile_path}")
            continue
        return normalize_profiles_map(raw)
    return {}


def read_current_db_tokens():
    tokens = {}
    for db_path in get_db_paths():
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
            try:
                for key in DB_AUTH_KEYS:
                    if key in tokens:
                        continue
                    row = conn.execute("SELECT value FROM ItemTable WHERE key = ?", (key,)).fetchone()
                    if row:
                        text = _to_text(row[0])
                        if text is not None:
                            tokens[key] = text
            finally:
                conn.close()
        except sqlite3.Error:
            pass
    return tokens


def read_current_file_tokens():
    paths = get_token_file_paths()
    result = {category: None for category in FILE_CATEGORIES}

    for category in FILE_CATEGORIES:
        for token_path in paths[category]:
            if not os.path.exists(token_path):
                continue
            try:
                with open(token_path, "r", encoding="utf-8") as handle:
                    parsed = json.load(handle)
                if isinstance(parsed, dict) and _has_token_strings(parsed):
                    result[category] = parsed
                    break
            except (OSError, ValueError):
                continue

    if not result["standaloneToken"] and result["cliToken"]:
        result["standaloneToken"] = json.loads(json.dumps(result["cliToken"]))
    if not result["cliToken"] and result["standaloneToken"]:
        result["cliToken"] = json.loads(json.dumps(result["standaloneToken"]))
    return result


def _patch_token_email(file_tokens, email):
    for category in ("cliToken", "standaloneToken"):
        token = file_tokens.get(category)
        if isinstance(token, dict):
            token["id_token_email"] = email


def _patch_db_identity(db_tokens, email):
    if not email:
        return db_tokens

    ag_data = {}
    if db_tokens.get("google.google-antigravity"):
        parsed = _safe_json(db_tokens["google.google-antigravity"])
        if isinstance(parsed, dict):
            ag_data = parsed
    storage = ag_data.get("antigravity-storage")
    if not isinstance(storage, dict):
        storage = {}
        ag_data["antigravity-storage"] = storage
    storage["agy.onboarding.lastLoginUsername"] = email
    storage["jetski.onboarding.lastLoginUsername"] = email
    storage["agy.onboarding.lastLoginIsGcpTos"] = "false"
    storage["jetski.onboarding.lastLoginIsGcpTos"] = "false"
    db_tokens["google.google-antigravity"] = json.dumps(ag_data)

    status = {}
    if db_tokens.get("antigravityAuthStatus"):
        parsed = _safe_json(db_tokens["antigravityAuthStatus"])
        if isinstance(parsed, dict):
            status = parsed
    status["email"] = email
    if not isinstance(status.get("apiKey"), str):
        status["apiKey"] = ""
    db_tokens["antigravityAuthStatus"] = json.dumps(status)
    return db_tokens


def _build_db_tokens_for_restore(profile_tokens, current_tokens, email):
    output = dict(profile_tokens)

    ag_data = {}
    ag_raw = profile_tokens.get("google.google-antigravity", current_tokens.get("google.google-antigravity"))
    if ag_raw:
        parsed = _safe_json(ag_raw)
        if isinstance(parsed, dict):
            ag_data = parsed
    storage = ag_data.get("antigravity-storage")
    if not isinstance(storage, dict):
        storage = {}
        ag_data["antigravity-storage"] = storage
    storage["agy.onboarding.lastLoginUsername"] = email
    storage["jetski.onboarding.lastLoginUsername"] = email
    storage["agy.onboarding.lastLoginIsGcpTos"] = "false"
    storage["jetski.onboarding.lastLoginIsGcpTos"] = "false"
    output["google.google-antigravity"] = json.dumps(ag_data)

    status = {}
    if profile_tokens.get("antigravityAuthStatus"):
        parsed = _safe_json(profile_tokens["antigravityAuthStatus"])
        if isinstance(parsed, dict):
            status = parsed
    status["email"] = email
    if not isinstance(status.get("apiKey"), str):
        status["apiKey"] = ""
    output["antigravityAuthStatus"] = json.dumps(status)
    return output


def write_db_tokens(db_tokens, replace_session_keys=False):
    paths = get_db_paths()
    if not paths:
        return {"skipped": True, "written": []}

    written = []
    failed = []
    for db_path in paths:
        conn = None
        try:
            conn = sqlite3.connect(db_path, timeout=5)
            conn.execute("BEGIN IMMEDIATE")
            if replace_session_keys:
                for key in DB_SESSION_KEYS:
                    conn.execute("DELETE FROM ItemTable WHERE key = ?", (key,))
            conn.executemany(
                "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
                [(key, value) for key, value in db_tokens.items() if value is not None],
            )
            conn.commit()
            written.append(db_path)
        except sqlite3.Error as error:
            try:
                if conn:
                    conn.rollback()
            except sqlite3.Error:
                pass
            failed.append(f"{db_path}: {error}")
        finally:
            if conn:
                conn.close()

    if not written:
        raise RuntimeError("Could not write the Antigravity database. " + " | ".join(failed))
    if failed:
        raise RuntimeError("Antigravity database was only partially written. " + " | ".join(failed))
    return {"skipped": False, "written": written}


def write_file_tokens(file_tokens, email):
    normalized = normalize_file_tokens(file_tokens)
    if email:
        _patch_token_email(normalized, email)

    paths = get_token_file_paths()
    written = []
    removed = []
    failed = []

    for category in FILE_CATEGORIES:
        token = normalized[category]
        targets = paths[category]

        if not token:
            for target in targets:
                try:
                    if os.path.exists(target):
                        os.unlink(target)
                        removed.append(target)
                except OSError as error:
                    failed.append(f"{target}: {error}")
            continue

        content = json.dumps(token, indent=2)
        for target in targets:
            try:
                _atomic_write(target, content, FILE_MODE)
                written.append(target)
            except Exception as error:
                failed.append(f"{target}: {error}")

    if failed:
        raise RuntimeError("Could not update OAuth token files. " + " | ".join(failed))
    return {"written": written, "removed": removed}


def snapshot_active_account(custom_label=None, manual_email=None):
    session = detect_active_session()
    if not session["has_token"]:
        raise RuntimeError("No active Antigravity session was detected. Sign in first.")

    requested_email = normalize_email(manual_email) if manual_email else ""
    if manual_email and not requested_email:
        raise RuntimeError("The provided email address is not valid.")
    if requested_email and session["email"] and requested_email != session["email"]:
        raise RuntimeError(
            f"The active session belongs to {session['email']}. "
            f"Sign in as {requested_email} before saving that profile."
        )

    email = requested_email or session["email"]
    if not email:
        raise RuntimeError(
            "An active session was found, but its email could not be determined. "
            "Sign in again or provide the email explicitly."
        )

    db_tokens = read_current_db_tokens()
    if db_tokens:
        _patch_db_identity(db_tokens, email)
    else:
        warn("No authentication keys were found in the Antigravity database; saving file tokens only.")

    file_tokens = read_current_file_tokens()
    if not any(file_tokens.values()):
        raise RuntimeError("No OAuth token files were found for the active session.")
    _patch_token_email(file_tokens, email)

    for category in FILE_CATEGORIES:
        for token_path in get_token_file_paths()[category]:
            try:
                if os.path.exists(token_path):
                    os.chmod(token_path, FILE_MODE)
            except OSError:
                pass

    profiles = load_profiles()
    previous = profiles.get(email, {})
    label = custom_label.strip() if isinstance(custom_label, str) and custom_label.strip() else (
        previous.get("label") or email.split("@")[0]
    )
    entry = dict(previous)
    entry.update({
        "email": email,
        "label": label,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "db_tokens": db_tokens,
        "file_tokens": file_tokens,
        "tokens": db_tokens,
    })
    profiles[email] = entry
    save_profiles(profiles)

    if db_tokens:
        try:
            write_db_tokens(db_tokens)
        except Exception as error:
            warn(f"Could not persist the database identity: {error}")

    return entry


def restore_profile(profile):
    entry = normalize_profile_entry(profile, profile.get("email") if isinstance(profile, dict) else None)
    if not entry:
        raise RuntimeError("Invalid or incomplete profile.")

    email = entry["email"]
    db_tokens = normalize_db_tokens(entry["db_tokens"])
    db_result = {"skipped": True, "written": []}
    if db_tokens:
        current_tokens = read_current_db_tokens()
        prepared = _build_db_tokens_for_restore(db_tokens, current_tokens, email)
        db_result = write_db_tokens(prepared, replace_session_keys=True)
        if db_result.get("skipped"):
            warn("No Antigravity database was found; only the token files were updated.")
    else:
        warn("Profile has no database tokens; the Antigravity database was left unchanged.")

    if not any(entry["file_tokens"].values()):
        warn("Profile has no OAuth token files; local token files will be removed.")

    file_result = write_file_tokens(entry["file_tokens"], email)
    return {"email": email, "db": db_result, "files": file_result}


def clear_session_tokens():
    failed = []

    for db_path in get_db_paths():
        conn = None
        try:
            conn = sqlite3.connect(db_path, timeout=5)
            conn.execute("BEGIN IMMEDIATE")
            for key in DB_SESSION_KEYS:
                conn.execute("DELETE FROM ItemTable WHERE key = ?", (key,))
            row = conn.execute(
                "SELECT value FROM ItemTable WHERE key = 'google.google-antigravity'"
            ).fetchone()
            if row and row[0]:
                parsed = _safe_json(_to_text(row[0]))
                if isinstance(parsed, dict) and isinstance(parsed.get("antigravity-storage"), dict):
                    storage = parsed["antigravity-storage"]
                    for key in (
                        "agy.onboarding.lastLoginUsername",
                        "jetski.onboarding.lastLoginUsername",
                        "onboarding.lastLoginUsername",
                        "lastLoginUsername",
                        "agy.onboarding.lastLoginIsGcpTos",
                        "jetski.onboarding.lastLoginIsGcpTos",
                    ):
                        storage.pop(key, None)
                    conn.execute(
                        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
                        ("google.google-antigravity", json.dumps(parsed)),
                    )
            conn.commit()
        except sqlite3.Error as error:
            try:
                if conn:
                    conn.rollback()
            except sqlite3.Error:
                pass
            failed.append(f"{db_path}: {error}")
        finally:
            if conn:
                conn.close()

    paths = get_token_file_paths()
    for category in FILE_CATEGORIES:
        for token_path in paths[category]:
            try:
                if os.path.exists(token_path):
                    os.unlink(token_path)
            except OSError as error:
                failed.append(f"{token_path}: {error}")

    if failed:
        raise RuntimeError("Could not clear every session store. " + " | ".join(failed))


def get_diagnostics():
    profiles = load_profiles()
    warnings = last_warnings()
    return {
        "version": VERSION,
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "sqliteAvailable": True,
        "dbPaths": get_db_paths(),
        "tokenPaths": get_token_file_paths(),
        "profilePaths": get_profiles_file_paths(),
        "activeSession": detect_active_session(),
        "savedProfiles": sorted(profiles.keys()),
        "vaultWarnings": warnings,
    }


def find_profile(query, profiles):
    if not query:
        return None, None
    wanted = query.strip().lower()

    for email, data in profiles.items():
        if email.lower() == wanted:
            return email, data

    matches = [
        (email, data) for email, data in profiles.items()
        if str(data.get("label", "")).strip().lower() == wanted
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError(
            f"Label '{query}' is ambiguous. Use the email instead: "
            + ", ".join(email for email, _ in matches)
        )
    return None, None


def cmd_save(label=None, manual_email=None):
    try:
        entry = snapshot_active_account(label, manual_email)
    except Exception as error:
        print(f"Error: {error}")
        return 1

    print(f"Account '{entry['email']}' saved as '[{entry['label']}]' successfully!")
    return 0


def cmd_load(query):
    profiles = load_profiles()
    try:
        email, profile = find_profile(query, profiles)
    except ValueError as error:
        print(f"Error: {error}")
        return 1

    if not profile:
        print(f"Error: Account matching '{query}' not found. Saved: {list(profiles.keys())}")
        return 1

    try:
        restore_profile(profile)
    except Exception as error:
        print(f"Error: {error}")
        return 1

    label = profile.get("label") or email
    print(f"Switched to '[{label}]' ({email}). Reload the Antigravity IDE window to apply it.")
    return 0


def cmd_list(as_json=False):
    profiles = load_profiles()
    session = detect_active_session()
    current_email = session["email"]

    accounts = []
    for email, data in profiles.items():
        is_active = bool(current_email and email.lower() == current_email.lower())
        accounts.append({
            "email": email,
            "label": data.get("label") or email.split("@")[0],
            "active": is_active,
            "saved_at": data.get("saved_at", ""),
        })

    if as_json:
        print(json.dumps({
            "accounts": accounts,
            "current_email": current_email,
            "current_active_found": any(account["active"] for account in accounts),
            "token_present": session["has_token"],
            "needs_email": session["needs_email"],
        }))
    else:
        print("=== Antigravity Accounts Vault ===")
        if not accounts:
            print("  (No accounts saved yet. Sign in and run 'agy-switch save [label]')")
        for account in accounts:
            status = " [ACTIVE NOW]" if account["active"] else ""
            saved = account["saved_at"][:19].replace("T", " ")
            print(f"* [{account['label']}] {account['email']}{status} (Saved: {saved})")
        if session["has_token"] and session["needs_email"]:
            print("  ! An active session exists, but its email could not be determined.")
    return 0


def cmd_current(as_json=False):
    session = detect_active_session()
    email = session["email"]
    profiles = load_profiles()
    matched = profiles.get(email) if email else None
    label = matched.get("label") if matched else (
        email.split("@")[0] if email else ("Account" if session["has_token"] else "No Account")
    )

    if as_json:
        print(json.dumps({
            "is_active": session["has_token"],
            "email": email,
            "label": label,
            "is_saved": bool(matched),
            "needs_email": session["needs_email"],
            "source": session["source"],
        }))
    else:
        if email:
            print(f"[{label}] {email}")
        elif session["has_token"]:
            print("[Account] Active session detected, but the email could not be determined.")
        else:
            print("[No Account] (Signed Out)")
    return 0


def cmd_delete(query):
    profiles = load_profiles()
    try:
        email, _ = find_profile(query, profiles)
    except ValueError as error:
        print(f"Error: {error}")
        return 1

    if not email:
        print(f"Error: Account '{query}' not found.")
        return 1

    del profiles[email]
    try:
        save_profiles(profiles)
    except Exception as error:
        print(f"Error: {error}")
        return 1
    print(f"Account '{email}' removed from the saved vault.")
    return 0


def cmd_logout():
    try:
        clear_session_tokens()
    except Exception as error:
        print(f"Error: {error}")
        return 1
    print("Logged out of the Antigravity session. Tokens removed.")
    return 0


def cmd_clear():
    try:
        save_profiles({})
        clear_session_tokens()
    except Exception as error:
        print(f"Error: {error}")
        return 1
    print("All profiles and active sessions were cleared successfully!")
    return 0


def cmd_diagnostics(as_json=False):
    diagnostics = get_diagnostics()
    if as_json:
        print(json.dumps(diagnostics, indent=2))
    else:
        print(f"Version: {diagnostics['version']}")
        print(f"Platform: {diagnostics['platform']} | Python: {diagnostics['python']}")
        print("Database paths:")
        for path in diagnostics["dbPaths"] or ["  (none found)"]:
            print(f"  {path}")
        print("Profile paths:")
        for path in diagnostics["profilePaths"]:
            print(f"  {path}")
        print("Active session:")
        print(f"  {json.dumps(diagnostics['activeSession'])}")
        print(f"Saved profiles: {diagnostics['savedProfiles']}")
        if diagnostics["vaultWarnings"]:
            print("Warnings:")
            for warning in diagnostics["vaultWarnings"]:
                print(f"  - {warning}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Antigravity Account Switcher")
    parser.add_argument("--version", action="version", version=f"agy-switch {VERSION}")
    subparsers = parser.add_subparsers(dest="command")

    save_parser = subparsers.add_parser("save", help="Snapshot the current active account")
    save_parser.add_argument("label", nargs="?", default=None, help="Friendly label")
    save_parser.add_argument("--email", default=None, help="Explicit Google email when auto-detection fails")

    load_parser = subparsers.add_parser("load", help="Switch to an account by email or label")
    load_parser.add_argument("query", help="Email or label to switch to")

    list_parser = subparsers.add_parser("list", help="List all saved accounts")
    list_parser.add_argument("--json", action="store_true", help="Output JSON")

    current_parser = subparsers.add_parser("current", help="Show the currently active account")
    current_parser.add_argument("--json", action="store_true", help="Output JSON")

    delete_parser = subparsers.add_parser("delete", help="Remove an account from the vault")
    delete_parser.add_argument("query", help="Email or label to delete")

    subparsers.add_parser("logout", help="Log out the active session and clear tokens")
    subparsers.add_parser("clear", help="Clear all profiles and sessions")

    diagnostics_parser = subparsers.add_parser("diagnostics", help="Show token and database paths")
    diagnostics_parser.add_argument("--json", action="store_true", help="Output JSON")

    args = parser.parse_args()

    if args.command == "save":
        sys.exit(cmd_save(args.label, args.email))
    if args.command == "load":
        sys.exit(cmd_load(args.query))
    if args.command == "list":
        sys.exit(cmd_list(as_json=args.json))
    if args.command == "current":
        sys.exit(cmd_current(as_json=args.json))
    if args.command == "delete":
        sys.exit(cmd_delete(args.query))
    if args.command == "logout":
        sys.exit(cmd_logout())
    if args.command == "clear":
        sys.exit(cmd_clear())
    if args.command == "diagnostics":
        sys.exit(cmd_diagnostics(as_json=args.json))

    cmd_list()


if __name__ == "__main__":
    main()
