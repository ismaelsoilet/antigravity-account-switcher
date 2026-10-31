#!/usr/bin/env python3
"""
Antigravity Account Switcher - CLI Core Engine (v1.7.3)

Manages the authentication state shared by Antigravity IDE, Antigravity Desktop
and the Antigravity CLI:

- SQLite databases (state.vscdb)
- CLI OAuth token (antigravity-cli/antigravity-oauth-token)
- Antigravity CdeAuthService token (jetski-standalone-oauth-token)
- Google OAuth credentials (oauth_creds.json)
"""

import argparse
import base64
import contextlib
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

VERSION = "1.7.3"
EMAIL_REGEX = re.compile(r"^[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+$")
FILE_CATEGORIES = ("standaloneToken", "cliToken", "oauthCreds")
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
SWITCH_STATE_FILE = "antigravity_switch_state.json"
SWITCH_LOCK_FILE = ".antigravity-switch.lock"
SWITCH_LOCK_STALE_SECONDS = 15
SWITCH_LOCK_ATTEMPTS = 3
SWITCH_LOCK_RETRY_SECONDS = 0.2
PROFILE_SCHEMA_VERSION = 2

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


def canonical_email(value):
    email = normalize_email(value)
    if not email:
        return ""
    local, _, domain = email.partition("@")
    if domain in ("gmail.com", "googlemail.com"):
        return local.split("+", 1)[0].replace(".", "") + "@gmail.com"
    return email


def unique_strings(values):
    output = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        text = value.strip()
        if text not in output:
            output.append(text)
    return output


def token_fingerprint(token):
    payload = _token_payload(token)
    if not isinstance(payload, dict):
        return ""
    secret = payload.get("refresh_token") if _non_empty(payload.get("refresh_token")) else payload.get("access_token")
    if not _non_empty(secret):
        return ""
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


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


def get_switch_state_paths():
    return _dedupe(os.path.join(d, SWITCH_STATE_FILE) for d in get_gemini_dirs())


def get_lock_paths():
    return _dedupe(os.path.join(d, SWITCH_LOCK_FILE) for d in get_gemini_dirs())


def _acquire_one_lock(lock_path):
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, FILE_MODE)
    except FileExistsError:
        try:
            stale = time.time() - os.path.getmtime(lock_path) > SWITCH_LOCK_STALE_SECONDS
        except OSError:
            stale = True
        if not stale:
            raise RuntimeError(f"Another account switch is in progress ({lock_path}).")
        try:
            os.unlink(lock_path)
        except OSError:
            pass
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, FILE_MODE)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"pid": os.getpid(), "at": time.time()}, handle)


@contextlib.contextmanager
def acquire_switch_lock():
    targets = sorted(get_lock_paths())
    acquired = []
    for attempt in range(SWITCH_LOCK_ATTEMPTS):
        try:
            for lock_path in targets:
                _acquire_one_lock(lock_path)
                acquired.append(lock_path)
            break
        except Exception:
            for lock_path in acquired:
                try:
                    os.unlink(lock_path)
                except OSError:
                    pass
            acquired = []
            if attempt >= SWITCH_LOCK_ATTEMPTS - 1:
                raise
            time.sleep(SWITCH_LOCK_RETRY_SECONDS)
    try:
        yield
    finally:
        for lock_path in reversed(acquired):
            try:
                os.unlink(lock_path)
            except OSError:
                pass


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


def _store_home_label(file_path):
    if file_path.startswith("/mnt/c/") or re.match(r"^[A-Za-z]:[\\/]", file_path):
        return "win"
    if os.name == "nt":
        return "win"
    return "wsl"


def _store_mtime_ms(file_path):
    try:
        return int(os.stat(file_path).st_mtime * 1000)
    except OSError:
        return 0


def read_db_store(db_path):
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1)
        try:
            tokens = {}
            for key in DB_AUTH_KEYS:
                row = conn.execute("SELECT value FROM ItemTable WHERE key = ?", (key,)).fetchone()
                if row:
                    text = _to_text(row[0])
                    if text is not None:
                        tokens[key] = text
        finally:
            conn.close()
    except sqlite3.Error:
        return None

    auth_status_email = ""
    status = _safe_json(tokens.get("antigravityAuthStatus") or "")
    if isinstance(status, dict) and is_valid_email(status.get("email")):
        auth_status_email = normalize_email(status["email"])

    onboarding_emails = []
    google = _safe_json(tokens.get("google.google-antigravity") or "")
    storage = google.get("antigravity-storage") if isinstance(google, dict) else None
    if isinstance(storage, dict):
        for key in (
            "agy.onboarding.lastLoginUsername",
            "jetski.onboarding.lastLoginUsername",
            "onboarding.lastLoginUsername",
            "lastLoginUsername",
        ):
            if is_valid_email(storage.get(key)):
                onboarding_emails.append(normalize_email(storage[key]))

    identity_emails = unique_strings([auth_status_email, *onboarding_emails])
    identity_conflict = len(identity_emails) > 1
    email = "" if identity_conflict else (identity_emails[0] if identity_emails else "")

    try:
        stat = os.stat(db_path)
        size = stat.st_size
    except OSError:
        size = 0
    raw_oauth = tokens.get("antigravityUnifiedStateSync.oauthToken")
    has_oauth = isinstance(raw_oauth, str) and raw_oauth.strip() not in ("", "{}", "null")
    has_identity = bool(tokens.get("antigravityAuthStatus") or tokens.get("google.google-antigravity"))
    return {
        "path": db_path,
        "kind": "database",
        "category": "database",
        "home": _store_home_label(db_path),
        "email": email,
        "authStatusEmail": auth_status_email,
        "identityEmails": identity_emails,
        "identityConflict": identity_conflict,
        "tokens": tokens,
        "mtimeMs": _store_mtime_ms(db_path),
        "size": size,
        "usable": True,
        "hasToken": has_oauth,
        "hasIdentity": has_identity,
        "hasOauthToken": has_oauth,
        "needsEmail": not bool(email),
    }


def read_db_stores():
    return [store for store in (read_db_store(path) for path in get_db_paths()) if store]


def _read_token_store(category, token_path):
    if not os.path.isfile(token_path):
        return None
    try:
        with open(token_path, "r", encoding="utf-8") as handle:
            content = json.load(handle)
    except (OSError, ValueError):
        return None
    if not _has_token_strings(content):
        return None
    email = _extract_email(content)
    return {
        "path": token_path,
        "kind": "file",
        "category": category,
        "home": _store_home_label(token_path),
        "email": email,
        "canonicalEmail": canonical_email(email),
        "fingerprint": token_fingerprint(content),
        "mtimeMs": _store_mtime_ms(token_path),
        "size": os.path.getsize(token_path),
        "usable": _has_usable_tokens(content),
        "hasToken": True,
        "needsEmail": not bool(email),
    }


def _read_file_stores():
    stores = []
    paths = get_token_file_paths()
    for category in FILE_CATEGORIES:
        for token_path in paths[category]:
            store = _read_token_store(category, token_path)
            if store:
                stores.append(store)
    return stores


def _select_primary_store(stores, target_email, preferred_store):
    if not stores:
        return None
    if target_email:
        wanted = canonical_email(target_email)
        for store in stores:
            if canonical_email(store["email"]) == wanted:
                return store
    order = ("cliToken", "standaloneToken", "oauthCreds") if preferred_store == "cliToken" else (
        "standaloneToken", "cliToken", "oauthCreds"
    )
    for category in order:
        for store in stores:
            if store["category"] == category and store["email"]:
                return store
    for store in stores:
        if store["email"]:
            return store
    return stores[0]


def detect_sessions(preferred_store="standaloneToken"):
    db_stores = read_db_stores()
    db_identity_emails = unique_strings([
        email for store in db_stores for email in store.get("identityEmails", [])
    ])
    db_email = db_identity_emails[0] if len(db_identity_emails) == 1 else ""

    file_stores = []
    for store in _read_file_stores():
        if not store["email"] and db_email:
            store = dict(store)
            store["email"] = db_email
            store["canonicalEmail"] = canonical_email(db_email)
            store["needsEmail"] = False
        file_stores.append(store)

    stores = file_stores + db_stores
    usable = [
        store for store in stores
        if store["usable"] and store["hasToken"] and not store.get("identityConflict")
    ]

    identity_entries = []
    for store in stores:
        emails = store.get("identityEmails", []) if store["kind"] == "database" else (
            [store["email"]] if store["email"] else []
        )
        for email in emails:
            identity_entries.append({
                "path": store["path"],
                "category": store["category"],
                "home": store["home"],
                "email": email,
            })

    state = read_switch_state()
    target_email = state.get("targetEmail", "") if isinstance(state, dict) else ""
    primary = _select_primary_store(usable, target_email, preferred_store)

    emails = sorted({entry["email"] for entry in identity_entries})
    conflicts = []
    if len(emails) > 1:
        conflicts.append({
            "type": "multiple-emails",
            "emails": emails,
            "stores": identity_entries,
        })
    for store in stores:
        if store.get("identityConflict"):
            conflicts.append({
                "type": "database-identity-mismatch",
                "path": store["path"],
                "home": store["home"],
                "emails": store.get("identityEmails", []),
            })
    if target_email and any(canonical_email(email) != canonical_email(target_email) for email in emails):
        conflicts.append({
            "type": "target-mismatch",
            "targetEmail": target_email,
            "emails": emails,
            "stores": [
                entry for entry in identity_entries
                if canonical_email(entry["email"]) != canonical_email(target_email)
            ],
        })

    return {
        "is_active": bool(primary and primary["usable"] and primary["email"]),
        "has_token": bool(primary and primary["hasToken"]),
        "needs_email": bool(primary and primary["needsEmail"]),
        "email": primary["email"] if primary else "",
        "canonical_email": canonical_email(primary["email"]) if primary else "",
        "source": primary["path"] if primary else None,
        "category": primary["category"] if primary else None,
        "fingerprint": primary.get("fingerprint", "") if primary else "",
        "mtime_ms": primary["mtimeMs"] if primary else 0,
        "target_email": target_email,
        "stores": [
            {
                "path": store["path"],
                "kind": store["kind"],
                "category": store["category"],
                "home": store["home"],
                "email": store["email"],
                "canonicalEmail": store.get("canonicalEmail", ""),
                "fingerprint": store.get("fingerprint", ""),
                "authStatusEmail": store.get("authStatusEmail", ""),
                "identityEmails": store.get("identityEmails", []),
                "identityConflict": bool(store.get("identityConflict")),
                "mtimeMs": store["mtimeMs"],
                "size": store["size"],
                "usable": store["usable"],
                "hasToken": store["hasToken"],
                "hasIdentity": bool(store.get("hasIdentity")),
                "hasOauthToken": bool(store.get("hasOauthToken")),
                "needsEmail": store["needsEmail"],
            }
            for store in stores
        ],
        "conflicts": conflicts,
    }


def _preferred_store():
    value = os.environ.get("AGY_SWITCH_PREFERRED_STORE", "standaloneToken")
    return "cliToken" if value in ("cliToken", "cli") else "standaloneToken"


def detect_active_session():
    return detect_sessions(_preferred_store())


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

    aliases = [
        normalize_email(alias) for alias in raw.get("aliases", [])
        if is_valid_email(alias)
    ] if isinstance(raw.get("aliases"), list) else []
    fingerprints = {}
    if isinstance(raw.get("fingerprints"), dict):
        for key, value in raw["fingerprints"].items():
            canonical = FILE_KEY_ALIASES.get(key)
            if canonical and isinstance(value, str) and value.strip():
                fingerprints[canonical] = value.strip()

    entry = dict(raw)
    entry.update({
        "email": email,
        "label": label,
        "saved_at": raw.get("saved_at") if isinstance(raw.get("saved_at"), str) else "",
        "aliases": unique_strings(aliases),
        "fingerprints": fingerprints,
        "account_id": raw.get("account_id") if isinstance(raw.get("account_id"), str) else "",
        "db_tokens": db_tokens,
        "file_tokens": file_tokens,
        "tokens": db_tokens,
    })
    return entry


def profile_identity_set(profile):
    identities = set()
    if profile.get("email"):
        identities.add("email:" + canonical_email(profile["email"]))
    for alias in profile.get("aliases", []):
        if is_valid_email(alias):
            identities.add("email:" + canonical_email(alias))
    for fingerprint in (profile.get("fingerprints") or {}).values():
        if fingerprint:
            identities.add("fp:" + fingerprint)
    if profile.get("account_id"):
        identities.add("id:" + profile["account_id"])
    return identities


def find_profile_by_identity(profiles, entry):
    wanted = profile_identity_set(entry)
    if not wanted:
        return None
    for profile in profiles.values():
        if wanted & profile_identity_set(profile):
            return profile
    return None


def merge_profile_entries(existing, incoming):
    newer = incoming if (incoming.get("saved_at") or "") >= (existing.get("saved_at") or "") else existing
    older = existing if newer is incoming else incoming
    aliases = unique_strings([
        *(existing.get("aliases") or []),
        *(incoming.get("aliases") or []),
        existing.get("email", ""),
        incoming.get("email", ""),
    ])
    primary_email = normalize_email(existing.get("email", ""))
    aliases = [
        alias for alias in aliases
        if normalize_email(alias) != primary_email
    ]
    merged = dict(older)
    merged.update(newer)
    merged.update({
        "email": existing.get("email", ""),
        "label": existing.get("label") or incoming.get("label"),
        "aliases": aliases,
        "fingerprints": {
            **(existing.get("fingerprints") or {}),
            **(incoming.get("fingerprints") or {}),
        },
        "account_id": existing.get("account_id") or incoming.get("account_id"),
        "db_tokens": newer.get("db_tokens") or older.get("db_tokens") or {},
        "db_tokens_by_path": newer.get("db_tokens_by_path") or older.get("db_tokens_by_path"),
        "file_tokens": newer.get("file_tokens") or older.get("file_tokens") or {},
        "tokens": newer.get("tokens") or older.get("tokens") or {},
        "complete": newer.get("complete") if "complete" in newer else older.get("complete"),
        "saved_at": newer.get("saved_at") or older.get("saved_at") or "",
    })
    return merged


def normalize_profiles_map(profiles):
    by_email = {}
    if not isinstance(profiles, dict):
        return by_email
    for key, value in profiles.items():
        entry = normalize_profile_entry(value, key)
        if not entry:
            continue
        previous = by_email.get(entry["email"])
        if previous is None or (entry["saved_at"] and (not previous["saved_at"] or entry["saved_at"] >= previous["saved_at"])):
            by_email[entry["email"]] = entry

    output = {}
    ordered = sorted(by_email.values(), key=lambda profile: profile.get("saved_at") or "", reverse=True)
    for profile in ordered:
        existing = find_profile_by_identity(output, profile)
        if existing and normalize_email(existing["email"]) != normalize_email(profile["email"]):
            output[existing["email"]] = merge_profile_entries(existing, profile)
        else:
            output[profile["email"]] = profile
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


def read_switch_state():
    for state_path in get_switch_state_paths():
        try:
            with open(state_path, "r", encoding="utf-8") as handle:
                parsed = json.load(handle)
            if isinstance(parsed, dict):
                return parsed
        except (OSError, ValueError):
            continue
    return {}


def write_switch_state(state):
    data = json.dumps(state, indent=2)
    written = []
    failed = []
    for state_path in get_switch_state_paths():
        try:
            _atomic_write(state_path, data, FILE_MODE)
            written.append(state_path)
        except Exception as error:
            failed.append(f"{state_path}: {error}")
    if failed:
        warn("Could not persist the switch state: " + " | ".join(failed))
    return {"written": written, "failed": failed}


def clear_switch_state():
    failed = []
    for state_path in get_switch_state_paths():
        try:
            if os.path.exists(state_path):
                os.unlink(state_path)
        except OSError as error:
            failed.append(f"{state_path}: {error}")
    return {"failed": failed}


def get_store_snapshot():
    files = []
    paths = get_token_file_paths()
    for category in FILE_CATEGORIES:
        for token_path in paths[category]:
            if not os.path.exists(token_path):
                files.append({
                    "path": token_path,
                    "category": category,
                    "exists": False,
                    "email": "",
                    "sha256": "",
                    "mtimeMs": 0,
                })
                continue
            try:
                with open(token_path, "r", encoding="utf-8") as handle:
                    content = handle.read()
            except OSError:
                content = ""
            parsed = _safe_json(content)
            files.append({
                "path": token_path,
                "category": category,
                "exists": True,
                "email": _extract_email(parsed) if isinstance(parsed, dict) else "",
                "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "mtimeMs": _store_mtime_ms(token_path),
            })
    databases = [
        {
            "path": store["path"],
            "email": store["email"],
            "identityEmails": store.get("identityEmails", []),
            "identityConflict": bool(store.get("identityConflict")),
            "hasOauthToken": bool(store.get("hasOauthToken")),
            "mtimeMs": store["mtimeMs"],
        }
        for store in read_db_stores()
    ]
    return {"files": files, "databases": databases}


def diff_against_switch_state(state):
    target_email = state.get("targetEmail", "") if isinstance(state, dict) else ""
    if not target_email:
        return {"targetEmail": "", "refreshes": [], "conflicts": [], "missing": []}

    snapshot = get_store_snapshot()
    expected = {file["path"]: file for file in state.get("files", []) if isinstance(file, dict)}
    refreshes = []
    conflicts = []
    missing = []

    target_canonical = canonical_email(target_email)

    for file in snapshot["files"]:
        previous = expected.get(file["path"])
        if not previous or not previous.get("exists"):
            if file["exists"] and file["email"] and canonical_email(file["email"]) != target_canonical:
                conflicts.append({
                    "kind": "file",
                    "path": file["path"],
                    "category": file["category"],
                    "email": file["email"],
                    "expectedEmail": target_email,
                })
            continue
        if not file["exists"]:
            missing.append({"kind": "file", "path": file["path"], "category": file["category"]})
            continue
        if file["email"] and canonical_email(file["email"]) != target_canonical:
            conflicts.append({
                "kind": "file",
                "path": file["path"],
                "category": file["category"],
                "email": file["email"],
                "expectedEmail": target_email,
            })
            continue
        if file["sha256"] != previous.get("sha256"):
            refreshes.append({
                "kind": "file",
                "path": file["path"],
                "category": file["category"],
                "email": file["email"],
                "expectedEmail": target_email,
            })

    for database in snapshot["databases"]:
        current_emails = database.get("identityEmails") or ([database["email"]] if database["email"] else [])
        if len(current_emails) > 1 or any(canonical_email(email) != target_canonical for email in current_emails):
            conflicts.append({
                "kind": "database",
                "path": database["path"],
                "email": ", ".join(current_emails),
                "emails": current_emails,
                "expectedEmail": target_email,
            })

    for expected_database in state.get("databases", []):
        if not any(database["path"] == expected_database["path"] for database in snapshot["databases"]):
            missing.append({"kind": "database", "path": expected_database["path"]})

    return {
        "targetEmail": target_email,
        "refreshes": refreshes,
        "conflicts": conflicts,
        "missing": missing,
    }


def build_switch_state(entry, verification):
    snapshot = get_store_snapshot()
    return {
        "version": 1,
        "targetEmail": entry["email"],
        "targetLabel": entry.get("label") or entry["email"].split("@")[0],
        "appliedAt": datetime.now(timezone.utc).isoformat(),
        "pid": os.getpid(),
        "platform": sys.platform,
        "complete": bool(entry.get("complete")),
        "files": snapshot["files"],
        "databases": snapshot["databases"],
        "verification": {
            "ok": bool(verification.get("ok")),
            "files": verification.get("files", []),
            "missingFiles": verification.get("missingFiles", []),
            "databases": verification.get("dbs", []),
        },
    }


def read_current_db_tokens():
    tokens = {}
    for store in read_db_stores():
        for key in DB_AUTH_KEYS:
            if key in tokens:
                continue
            value = store["tokens"].get(key)
            if value is not None:
                tokens[key] = value
    return tokens


def read_current_file_tokens(active_email=None):
    paths = get_token_file_paths()
    result = {category: None for category in FILE_CATEGORIES}
    wanted_email = normalize_email(active_email) if active_email else ""

    for category in FILE_CATEGORIES:
        for token_path in paths[category]:
            if not os.path.exists(token_path):
                continue
            try:
                with open(token_path, "r", encoding="utf-8") as handle:
                    parsed = json.load(handle)
                if not isinstance(parsed, dict) or not _has_token_strings(parsed):
                    continue
                token_email = _extract_email(parsed)
                if wanted_email and token_email and token_email != wanted_email:
                    continue
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


def write_db_tokens(db_tokens, replace_session_keys=False, delete_keys=None, db_paths=None):
    paths = list(db_paths) if db_paths is not None else get_db_paths()
    if not paths:
        return {"skipped": True, "written": [], "failed": []}

    keys_to_delete = DB_SESSION_KEYS if replace_session_keys else [
        key for key in (delete_keys or []) if key in DB_SESSION_KEYS
    ]

    written = []
    failed = []
    skipped = []
    for db_path in paths:
        conn = None
        try:
            conn = sqlite3.connect(db_path, timeout=5)
            conn.execute("BEGIN IMMEDIATE")
            for key in keys_to_delete:
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
            if "no such table" in str(error).lower() and "itemtable" in str(error).lower():
                skipped.append(f"{db_path}: missing ItemTable")
            else:
                failed.append(f"{db_path}: {error}")
        finally:
            if conn:
                conn.close()

    if not written and not failed:
        return {"skipped": True, "written": [], "failed": [], "skipped": skipped}
    if not written:
        raise RuntimeError("Could not write the Antigravity database. " + " | ".join(failed))
    if failed:
        raise RuntimeError("Antigravity database was only partially written. " + " | ".join(failed))
    return {"skipped": False, "written": written, "failed": failed, "skipped": skipped}


def write_db_snapshot(db_path, tokens):
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        conn.execute("BEGIN IMMEDIATE")
        for key in DB_AUTH_KEYS:
            value = tokens.get(key)
            if value is None:
                conn.execute("DELETE FROM ItemTable WHERE key = ?", (key,))
            else:
                conn.execute(
                    "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
                    (key, value),
                )
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        raise
    finally:
        conn.close()


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


def normalize_db_tokens_by_path(raw):
    output = {}
    if not isinstance(raw, dict):
        return output
    for db_path, tokens in raw.items():
        if not isinstance(tokens, dict):
            continue
        normalized = normalize_db_tokens(tokens)
        if normalized:
            output[db_path] = normalized
    return output


def merge_db_tokens_by_path(by_path):
    output = {}
    for tokens in by_path.values():
        for key, value in tokens.items():
            output.setdefault(key, value)
    return output


def capture_current_state():
    files = {}
    paths = get_token_file_paths()
    for category in FILE_CATEGORIES:
        for token_path in paths[category]:
            if not os.path.exists(token_path):
                files[token_path] = {"exists": False}
                continue
            try:
                with open(token_path, "r", encoding="utf-8") as handle:
                    content = handle.read()
                files[token_path] = {
                    "exists": True,
                    "content": content,
                    "mode": os.stat(token_path).st_mode & 0o777,
                }
            except OSError:
                files[token_path] = {"exists": None}

    databases = {
        store["path"]: {key: store["tokens"].get(key) for key in DB_AUTH_KEYS}
        for store in read_db_stores()
    }
    return {"files": files, "databases": databases}


def restore_captured_state(captured):
    failed = []
    for file_path, value in captured.get("files", {}).items():
        try:
            if value.get("exists") is True:
                _atomic_write(file_path, value.get("content", ""), value.get("mode") or FILE_MODE)
            elif value.get("exists") is False and os.path.exists(file_path):
                os.unlink(file_path)
        except OSError as error:
            failed.append(f"{file_path}: {error}")
    for db_path, tokens in captured.get("databases", {}).items():
        try:
            write_db_snapshot(db_path, tokens)
        except sqlite3.Error as error:
            failed.append(f"{db_path}: {error}")
    if failed:
        warn("Rollback was incomplete: " + " | ".join(failed))
    return {"failed": failed}


def verify_restore(entry):
    email = entry["email"]
    wanted = canonical_email(email)
    files = [
        {
            "path": store["path"],
            "category": store["category"],
            "email": store["email"],
            "matches": canonical_email(store["email"]) == wanted,
        }
        for store in _read_file_stores()
    ]

    missing_files = []
    paths = get_token_file_paths()
    for category in FILE_CATEGORIES:
        if not entry.get("file_tokens") or not entry["file_tokens"].get(category):
            continue
        for token_path in paths[category]:
            if not os.path.exists(token_path):
                missing_files.append({"path": token_path, "category": category})

    dbs = []
    for store in read_db_stores():
        identity_emails = store.get("identityEmails", [])
        dbs.append({
            "path": store["path"],
            "email": store["email"],
            "identityEmails": identity_emails,
            "hasOauthToken": bool(store.get("hasOauthToken")),
            "matches": len(identity_emails) == 0
                or (len(identity_emails) == 1 and canonical_email(identity_emails[0]) == wanted),
        })

    files_ok = all((not file["email"]) or file["matches"] for file in files) and not missing_files
    dbs_ok = all(database["matches"] for database in dbs)
    return {
        "ok": files_ok and dbs_ok,
        "files": files,
        "missingFiles": missing_files,
        "dbs": dbs,
    }


def write_profile_db_tokens(entry, email):
    db_paths = get_db_paths()
    if not db_paths:
        return {"skipped": True, "written": [], "failed": [], "reason": "no Antigravity database found"}

    by_path = normalize_db_tokens_by_path(entry.get("db_tokens_by_path") or {})
    merged = normalize_db_tokens(entry.get("db_tokens") or {})
    if not by_path and not merged:
        return {"skipped": True, "written": [], "failed": [], "reason": "profile has no database tokens"}

    written = []
    failed = []
    skipped_paths = []
    for db_path in db_paths:
        tokens = by_path.get(db_path, merged)
        if not tokens:
            continue
        current = read_db_store(db_path)
        if not current:
            skipped_paths.append(f"{db_path}: unreadable database or missing ItemTable")
            continue
        prepared = _build_db_tokens_for_restore(tokens, current["tokens"], email)
        try:
            result = write_db_tokens(prepared, db_paths=[db_path])
            written.extend(result["written"])
            skipped_paths.extend(result.get("skipped", []))
        except Exception as error:
            failed.append(str(error))

    if not written and failed:
        raise RuntimeError("Could not write the Antigravity database. " + " | ".join(failed))
    if failed:
        raise RuntimeError("Antigravity database was only partially written. " + " | ".join(failed))
    return {
        "skipped": not written and bool(skipped_paths),
        "written": written,
        "failed": failed,
        "skippedPaths": skipped_paths,
    }


def make_unique_label(profiles, email, requested_label):
    candidate = requested_label.strip() if isinstance(requested_label, str) and requested_label.strip() else email.split("@")[0]
    taken = {
        (profile.get("label") or "").strip().lower()
        for profile in profiles.values()
        if canonical_email(profile.get("email", "")) != canonical_email(email)
    }
    taken.discard("")
    if candidate.lower() not in taken:
        return candidate
    index = 2
    while f"{candidate} {index}".lower() in taken:
        index += 1
    return f"{candidate} {index}"


def snapshot_active_account(custom_label=None, manual_email=None):
    with acquire_switch_lock():
        session = detect_active_session()
        if not session["has_token"]:
            raise RuntimeError("No active Antigravity session was detected. Sign in first.")

        requested_email = normalize_email(manual_email) if manual_email else ""
        if manual_email and not requested_email:
            raise RuntimeError("The provided email address is not valid.")

        blocking = [
            conflict for conflict in session.get("conflicts", [])
            if conflict["type"] in ("multiple-emails", "database-identity-mismatch")
        ]
        if blocking:
            detail = " | ".join(
                f"{conflict.get('path')}: {' vs '.join(conflict.get('emails', []))}"
                if conflict["type"] == "database-identity-mismatch"
                else "emails: " + " vs ".join(conflict.get("emails", []))
                for conflict in blocking
            )
            raise RuntimeError(
                f"The Antigravity stores disagree about the active account ({detail}). "
                "Resolve the conflict before saving a profile."
            )

        evidence_emails = unique_strings([
            email
            for store in session.get("stores", [])
            for email in (store.get("identityEmails", []) if store["kind"] == "database" else [store.get("email")])
        ])
        email = requested_email or session["email"]
        if not email:
            raise RuntimeError(
                "An active session was found, but its email could not be determined. "
                "Sign in again or provide the email explicitly."
            )

        profiles = load_profiles()
        if requested_email:
            wanted = canonical_email(requested_email)
            evidence_match = any(canonical_email(candidate) == wanted for candidate in evidence_emails)
            existing_identity = find_profile_by_identity(profiles, {"email": requested_email})
            if not evidence_match and not existing_identity and evidence_emails:
                raise RuntimeError(
                    f"The active session belongs to {', '.join(evidence_emails)}, not {requested_email}."
                )

        db_stores = read_db_stores()
        conflicting_dbs = [store for store in db_stores if store.get("identityConflict")]
        if conflicting_dbs:
            detail = " | ".join(
                f"{store['path']}: {' vs '.join(store.get('identityEmails', []))}"
                for store in conflicting_dbs
            )
            raise RuntimeError(
                f"The Antigravity database contains conflicting identities ({detail}). "
                "Sign in again before saving a profile."
            )

        matching = [
            store for store in db_stores
            if any(canonical_email(candidate) == canonical_email(email) for candidate in store.get("identityEmails", []))
        ]
        if db_stores and not matching:
            warn("No database matched the active email; the profile was saved without database identity. Sign in live and save it again.")
        selected = matching
        db_tokens_by_path = {}
        for store in selected:
            tokens = normalize_db_tokens(store["tokens"])
            _patch_db_identity(tokens, email)
            if tokens:
                db_tokens_by_path[store["path"]] = tokens
        db_tokens = merge_db_tokens_by_path(db_tokens_by_path)
        has_db_identity = any(
            tokens.get("antigravityAuthStatus") or tokens.get("google.google-antigravity")
            for tokens in db_tokens_by_path.values()
        )
        if db_stores and not has_db_identity:
            warn("Profile saved without an Antigravity database identity (antigravityAuthStatus); sign in live and save it again before switching.")

        file_tokens = read_current_file_tokens(email)
        if not any(file_tokens.values()):
            raise RuntimeError("No OAuth token files were found for the active session.")
        _patch_token_email(file_tokens, email)
        complete = bool(any(file_tokens.values())) and (not db_stores or has_db_identity)

        fingerprints = {}
        for category in FILE_CATEGORIES:
            token = file_tokens.get(category)
            if not token:
                continue
            fingerprint = token_fingerprint(token)
            if fingerprint:
                fingerprints[category] = fingerprint
        account_id = (
            fingerprints.get("standaloneToken")
            or fingerprints.get("cliToken")
            or fingerprints.get("oauthCreds")
            or canonical_email(email)
        )

        for category in FILE_CATEGORIES:
            for token_path in get_token_file_paths()[category]:
                try:
                    if os.path.exists(token_path):
                        os.chmod(token_path, FILE_MODE)
                except OSError:
                    pass

        previous = profiles.get(email, {})
        raw_label = custom_label.strip() if isinstance(custom_label, str) and custom_label.strip() else (
            previous.get("label") or email.split("@")[0]
        )
        aliases = [
            alias for alias in unique_strings([*(previous.get("aliases") or []), email])
            if normalize_email(alias) != normalize_email(email)
        ]
        entry = dict(previous)
        entry.update({
            "schema": PROFILE_SCHEMA_VERSION,
            "email": email,
            "label": make_unique_label(profiles, email, raw_label),
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "complete": complete,
            "aliases": aliases,
            "account_id": previous.get("account_id") or account_id,
            "fingerprints": {**(previous.get("fingerprints") or {}), **fingerprints},
            "db_tokens": db_tokens,
            "db_tokens_by_path": db_tokens_by_path,
            "file_tokens": file_tokens,
            "tokens": db_tokens,
        })

        existing = find_profile_by_identity(profiles, entry)
        if existing and normalize_email(existing["email"]) != normalize_email(email):
            entry = merge_profile_entries(existing, entry)
            profiles[existing["email"]] = entry
            profiles.pop(email, None)
            warn(f"Merged {email} into the existing profile {existing['email']} because they share the same identity.")
        else:
            profiles[email] = entry
        save_profiles(profiles)

        for db_path, tokens in db_tokens_by_path.items():
            try:
                write_db_tokens(tokens, db_paths=[db_path])
            except Exception as error:
                warn(f"Could not persist the database identity for {db_path}: {error}")

        return entry


def refresh_profile_metadata(entry, verification):
    if not verification.get("ok"):
        return None
    profiles = load_profiles()
    existing = find_profile_by_identity(profiles, {"email": entry["email"]})
    if not existing:
        return None

    email = entry["email"]
    wanted = canonical_email(email)
    file_tokens = read_current_file_tokens(email)
    if not any(file_tokens.values()):
        return None
    _patch_token_email(file_tokens, email)

    db_tokens_by_path = {}
    for store in read_db_stores():
        if not any(canonical_email(candidate) == wanted for candidate in store.get("identityEmails", [])):
            continue
        tokens = normalize_db_tokens(store["tokens"])
        _patch_db_identity(tokens, email)
        if tokens:
            db_tokens_by_path[store["path"]] = tokens
    db_tokens = merge_db_tokens_by_path(db_tokens_by_path)

    fingerprints = {}
    for category in FILE_CATEGORIES:
        token = file_tokens.get(category)
        if not token:
            continue
        fingerprint = token_fingerprint(token)
        if fingerprint:
            fingerprints[category] = fingerprint
    account_id = (
        fingerprints.get("standaloneToken")
        or fingerprints.get("cliToken")
        or fingerprints.get("oauthCreds")
        or canonical_email(email)
    )
    complete = not get_db_paths() or bool(db_tokens_by_path)

    refreshed = dict(existing)
    refreshed.update({
        "schema": PROFILE_SCHEMA_VERSION,
        "email": existing["email"],
        "complete": complete,
        "fingerprints": {**(existing.get("fingerprints") or {}), **fingerprints},
        "account_id": existing.get("account_id") or account_id,
        "db_tokens": db_tokens,
        "db_tokens_by_path": db_tokens_by_path,
        "file_tokens": file_tokens,
        "tokens": db_tokens,
    })
    profiles[existing["email"]] = refreshed
    try:
        save_profiles(profiles)
    except Exception as error:
        warn(f"Could not refresh the profile metadata: {error}")
    return refreshed


def restore_profile(profile):
    entry = normalize_profile_entry(profile, profile.get("email") if isinstance(profile, dict) else None)
    if not entry:
        raise RuntimeError("Invalid or incomplete profile.")

    with acquire_switch_lock():
        captured = capture_current_state()
        try:
            file_result = write_file_tokens(entry["file_tokens"], entry["email"])
            db_result = write_profile_db_tokens(entry, entry["email"])
            verification = verify_restore(entry)
            if not verification["ok"]:
                diverged = [
                    f"{file['path']}={file['email']}"
                    for file in verification["files"] if file["email"] and not file["matches"]
                ] + [
                    f"{database['path']}={' vs '.join(database.get('identityEmails', []))}"
                    for database in verification["dbs"] if not database["matches"]
                ] + [
                    f"{missing['path']}=missing"
                    for missing in verification["missingFiles"]
                ]
                raise RuntimeError(
                    "Switch verification failed after writing. "
                    + (" | ".join(diverged) if diverged else "stores did not converge")
                )

            write_switch_state(build_switch_state(entry, verification))
            refreshed_profile = refresh_profile_metadata(entry, verification)
            return {
                "email": entry["email"],
                "db": db_result,
                "files": file_result,
                "verification": verification,
                "complete": bool(entry.get("complete")),
                "profile": refreshed_profile,
            }
        except Exception as error:
            rollback = restore_captured_state(captured)
            if rollback["failed"]:
                raise RuntimeError(f"{error} (rollback incomplete: {' | '.join(rollback['failed'])})")
            raise


def build_login_profile(email, label=None):
    wanted = canonical_email(email)
    stores = [
        store for store in _read_file_stores()
        if canonical_email(store.get("email", "")) == wanted
    ]
    if not stores:
        raise RuntimeError(f"No token file was found for {email}. Sign in first.")
    store = max(stores, key=lambda item: item.get("mtimeMs", 0))
    try:
        with open(store["path"], "r", encoding="utf-8") as handle:
            parsed = json.load(handle)
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Could not read the fresh login token: {error}")
    if not _has_token_strings(parsed):
        raise RuntimeError("The fresh login token is not usable.")
    email = normalize_email(email) or _extract_email(parsed)
    if not email:
        raise RuntimeError("Could not determine the email of the fresh login.")

    file_tokens = normalize_file_tokens({store["category"]: parsed})
    _patch_token_email(file_tokens, email)

    profiles = load_profiles()
    db_tokens_by_path = {}
    for db_store in read_db_stores():
        tokens = normalize_db_tokens(db_store["tokens"])
        _patch_db_identity(tokens, email)
        if tokens:
            db_tokens_by_path[db_store["path"]] = tokens
    db_tokens = merge_db_tokens_by_path(db_tokens_by_path)
    has_db_identity = any(
        tokens.get("antigravityAuthStatus") or tokens.get("google.google-antigravity")
        for tokens in db_tokens_by_path.values()
    )
    complete = not get_db_paths() or has_db_identity

    fingerprints = {}
    for category in FILE_CATEGORIES:
        token = file_tokens.get(category)
        if not token:
            continue
        fingerprint = token_fingerprint(token)
        if fingerprint:
            fingerprints[category] = fingerprint
    account_id = (
        fingerprints.get("standaloneToken")
        or fingerprints.get("cliToken")
        or fingerprints.get("oauthCreds")
        or canonical_email(email)
    )
    raw_label = label.strip() if isinstance(label, str) and label.strip() else email.split("@")[0]

    return {
        "schema": PROFILE_SCHEMA_VERSION,
        "email": email,
        "label": make_unique_label(profiles, email, raw_label),
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "complete": complete,
        "aliases": [],
        "account_id": account_id,
        "fingerprints": fingerprints,
        "db_tokens": db_tokens,
        "db_tokens_by_path": db_tokens_by_path,
        "file_tokens": file_tokens,
        "tokens": db_tokens,
    }


def adopt_login_session(email, label=None):
    entry = build_login_profile(email, label)
    result = restore_profile(entry)

    with acquire_switch_lock():
        profiles = load_profiles()
        existing = find_profile_by_identity(profiles, entry)
        if existing and normalize_email(existing["email"]) != normalize_email(entry["email"]):
            saved = merge_profile_entries(existing, entry)
            profiles[existing["email"]] = saved
            profiles.pop(entry["email"], None)
        else:
            saved = dict(entry)
            profiles[entry["email"]] = saved
        save_profiles(profiles)
    return {"entry": saved, "result": result}


def clear_session_tokens():
    with acquire_switch_lock():
        return _clear_session_tokens_unlocked()


def _clear_session_tokens_unlocked():
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

    for failure in clear_switch_state()["failed"]:
        failed.append(failure)

    if failed:
        raise RuntimeError("Could not clear every session store. " + " | ".join(failed))


def get_diagnostics():
    profiles = load_profiles()
    warnings = last_warnings()
    session = detect_active_session()
    state = read_switch_state()
    return {
        "version": VERSION,
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "sqliteAvailable": True,
        "dbPaths": get_db_paths(),
        "tokenPaths": get_token_file_paths(),
        "profilePaths": get_profiles_file_paths(),
        "activeSession": session,
        "stores": session.get("stores", []),
        "conflicts": session.get("conflicts", []),
        "switchState": state,
        "storeDiff": diff_against_switch_state(state),
        "savedProfiles": sorted(profiles.keys()),
        "profileCompleteness": {
            email: {
                "complete": bool(profile.get("complete")),
                "saved_at": profile.get("saved_at", ""),
                "aliases": profile.get("aliases", []),
                "account_id": profile.get("account_id", ""),
                "fingerprints": sorted((profile.get("fingerprints") or {}).keys()),
                "dbPaths": sorted((profile.get("db_tokens_by_path") or {}).keys()),
            }
            for email, profile in profiles.items()
        },
        "vaultWarnings": warnings,
    }


def find_profile(query, profiles):
    if not query:
        return None, None
    wanted = query.strip().lower()
    wanted_canonical = canonical_email(query)

    for email, data in profiles.items():
        if email.lower() == wanted or canonical_email(email) == wanted_canonical:
            return email, data
        for alias in data.get("aliases", []):
            if canonical_email(alias) == wanted_canonical:
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

    suffix = "" if entry.get("complete") else (
        " (incomplete: no database oauthToken captured; sign in live and save it again)"
    )
    print(f"Account '{entry['email']}' saved as '[{entry['label']}]' successfully!{suffix}")
    return 0


def cmd_reset(confirmed=False):
    if not confirmed:
        print("Refusing to reset the vault without --yes.")
        return 1
    with acquire_switch_lock():
        for profile_path in get_profiles_file_paths():
            if not os.path.exists(profile_path):
                continue
            backup_path = f"{profile_path}.pre-{VERSION}.bak"
            try:
                shutil.copy2(profile_path, backup_path)
            except OSError as error:
                warn(f"Could not back up {profile_path}: {error}")
        save_profiles({})
        clear_switch_state()
    print(f"Profile vault reset. Backups use the .pre-{VERSION}.bak suffix.")
    return 0


def cmd_adopt(query, label=None):
    profiles = load_profiles()
    email = normalize_email(query)
    if not email:
        try:
            matched_email, _ = find_profile(query, profiles)
        except ValueError as error:
            print(f"Error: {error}")
            return 1
        if matched_email:
            email = matched_email
    if not email:
        print(f"Error: No account matching '{query}' was found.")
        return 1

    try:
        result = adopt_login_session(email, label)
    except Exception as error:
        print(f"Error: {error}")
        return 1

    entry = result["entry"]
    print(f"Switched all surfaces to '[{entry['label']}]' ({entry['email']}). Reload the Antigravity IDE window.")
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
    if profile.get("complete") is False:
        print(
            "Error: this profile is incomplete (saved without the Antigravity database identity). "
            "Sign in live and run 'agy-switch save' again before switching."
        )
        return 1

    try:
        result = restore_profile(profile)
    except Exception as error:
        print(f"Error: {error}")
        return 1

    label = profile.get("label") or email
    verified = result.get("verification", {}).get("ok", False)
    print(f"Switched to '[{label}]' ({email}); verified={str(verified).lower()}. Reload the Antigravity IDE window to apply it.")
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
            "complete": data.get("complete") is not False,
            "aliases": data.get("aliases", []),
            "saved_at": data.get("saved_at", ""),
        })

    if as_json:
        print(json.dumps({
            "accounts": accounts,
            "current_email": current_email,
            "current_active_found": any(account["active"] for account in accounts),
            "token_present": session["has_token"],
            "needs_email": session["needs_email"],
            "conflicts": session.get("conflicts", []),
        }))
    else:
        print("=== Antigravity Accounts Vault ===")
        if not accounts:
            print("  (No accounts saved yet. Sign in and run 'agy-switch save [label]')")
        for account in accounts:
            status = " [ACTIVE NOW]" if account["active"] else ""
            incomplete = " [INCOMPLETE]" if not account["complete"] else ""
            saved = account["saved_at"][:19].replace("T", " ")
            print(f"* [{account['label']}] {account['email']}{status}{incomplete} (Saved: {saved})")
        if session["has_token"] and session["needs_email"]:
            print("  ! An active session exists, but its email could not be determined.")
        if session.get("conflicts"):
            print("  ! Store conflict detected; run 'agy-switch diagnostics --json' for details.")
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
            "is_active": session["is_active"],
            "email": email,
            "label": label,
            "is_saved": bool(matched),
            "needs_email": session["needs_email"],
            "source": session["source"],
            "conflicts": session.get("conflicts", []),
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
    with acquire_switch_lock():
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
        with acquire_switch_lock():
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

    adopt_parser = subparsers.add_parser("adopt", help="Apply the newest token for an account to every store")
    adopt_parser.add_argument("query", help="Email or saved label of the account to adopt")
    adopt_parser.add_argument("--label", default=None, help="Friendly label for the adopted profile")

    list_parser = subparsers.add_parser("list", help="List all saved accounts")
    list_parser.add_argument("--json", action="store_true", help="Output JSON")

    current_parser = subparsers.add_parser("current", help="Show the currently active account")
    current_parser.add_argument("--json", action="store_true", help="Output JSON")

    delete_parser = subparsers.add_parser("delete", help="Remove an account from the vault")
    delete_parser.add_argument("query", help="Email or label to delete")

    subparsers.add_parser("logout", help="Log out the active session and clear tokens")
    subparsers.add_parser("clear", help="Clear all profiles and sessions")

    reset_parser = subparsers.add_parser("reset", help="Back up and empty the profile vault")
    reset_parser.add_argument("--yes", action="store_true", help="Confirm the vault reset")

    diagnostics_parser = subparsers.add_parser("diagnostics", help="Show token and database paths")
    diagnostics_parser.add_argument("--json", action="store_true", help="Output JSON")

    args = parser.parse_args()

    if args.command == "save":
        sys.exit(cmd_save(args.label, args.email))
    if args.command == "load":
        sys.exit(cmd_load(args.query))
    if args.command == "adopt":
        sys.exit(cmd_adopt(args.query, args.label))
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
    if args.command == "reset":
        sys.exit(cmd_reset(args.yes))
    if args.command == "diagnostics":
        sys.exit(cmd_diagnostics(as_json=args.json))

    cmd_list()


if __name__ == "__main__":
    main()
