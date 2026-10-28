#!/usr/bin/env python3
"""
Antigravity Account Switcher - CLI Core Engine (v1.4.0)
Multi-store authentication management across:
- SQLite databases (state.vscdb)
- Standalone CLI OAuth token (antigravity-oauth-token)
- Antigravity CdeAuthService token (jetski-standalone-oauth-token)
- Google OAuth credentials (oauth_creds.json)
"""

import sys
import os
import json
import sqlite3
import base64
import argparse
from datetime import datetime

# Profile storage targets
PROFILES_FILE = os.path.expanduser("~/.gemini/antigravity_profiles.json")
WIN_PROFILES_FILE = "/mnt/c/Users/Ismael/.gemini/antigravity_profiles.json"

# SQLite DB targets
IDE_DB_WIN = "/mnt/c/Users/Ismael/AppData/Roaming/Antigravity IDE/User/globalStorage/state.vscdb"
APP_DB_WIN = "/mnt/c/Users/Ismael/AppData/Roaming/Antigravity/User/globalStorage/state.vscdb"

DB_AUTH_KEYS = [
    "antigravityUnifiedStateSync.oauthToken",
    "antigravityUnifiedStateSync.userStatus",
    "antigravityUnifiedStateSync.modelCredits",
    "antigravityAuthStatus",
    "google.google-antigravity"
]

def get_gemini_dirs():
    dirs = [
        os.path.expanduser("~/.gemini"),
        "/home/ismaelsoilet/.gemini",
        "/mnt/c/Users/Ismael/.gemini"
    ]
    return list(dict.fromkeys([d for d in dirs if d]))

def get_token_file_paths():
    gdirs = get_gemini_dirs()
    return {
        "cli_token": list(dict.fromkeys([os.path.join(d, "antigravity-cli", "antigravity-oauth-token") for d in gdirs])),
        "standalone_token": list(dict.fromkeys([os.path.join(d, "jetski-standalone-oauth-token") for d in gdirs])),
        "oauth_creds": list(dict.fromkeys([os.path.join(d, "oauth_creds.json") for d in gdirs]))
    }

def get_db_paths():
    paths = []
    if os.path.exists(IDE_DB_WIN):
        paths.append(IDE_DB_WIN)
    if os.path.exists(APP_DB_WIN):
        paths.append(APP_DB_WIN)
    return paths

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

def detect_active_email():
    """
    Cascading detection of active account email across all token files and databases
    """
    files = get_token_file_paths()

    # 1. Check antigravity-oauth-token
    for p in files["cli_token"]:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    em = data.get("id_token_email")
                    if em and "@" in em:
                        return em.strip()
                    id_tok = data.get("token", {}).get("id_token")
                    if id_tok:
                        payload = decode_jwt_payload(id_tok)
                        if payload and payload.get("email"):
                            return payload["email"].strip()
            except Exception:
                pass

    # 2. Check oauth_creds.json
    for p in files["oauth_creds"]:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    id_tok = data.get("id_token")
                    if id_tok:
                        payload = decode_jwt_payload(id_tok)
                        if payload and payload.get("email"):
                            return payload["email"].strip()
            except Exception:
                pass

    # 3. Check SQLite Databases
    for db_path in get_db_paths():
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cur = conn.cursor()

            # 3a. antigravityAuthStatus
            cur.execute("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'")
            row = cur.fetchone()
            if row and row[0]:
                try:
                    data = json.loads(row[0])
                    em = data.get("email")
                    if em and "@" in em:
                        conn.close()
                        return em.strip()
                except Exception:
                    pass

            # 3b. google.google-antigravity
            cur.execute("SELECT value FROM ItemTable WHERE key = 'google.google-antigravity'")
            row = cur.fetchone()
            if row and row[0]:
                try:
                    data = json.loads(row[0])
                    em = data.get("antigravity-storage", {}).get("jetski.onboarding.lastLoginUsername")
                    if em and "@" in em:
                        conn.close()
                        return em.strip()
                except Exception:
                    pass

            conn.close()
        except Exception:
            pass

    return ""

def load_profiles():
    targets = [PROFILES_FILE, WIN_PROFILES_FILE]
    for target in targets:
        if os.path.exists(target):
            try:
                with open(target, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                    clean = {}
                    for k, v in raw.items():
                        em = v.get("email") or k
                        if "@" in em:
                            clean[em] = {
                                "email": em,
                                "label": v.get("label") or v.get("name") or em.split("@")[0],
                                "saved_at": v.get("saved_at", ""),
                                "db_tokens": v.get("db_tokens") or v.get("tokens", {}),
                                "file_tokens": v.get("file_tokens", {}),
                                "tokens": v.get("tokens") or v.get("db_tokens", {})
                            }
                    if clean:
                        return clean
            except Exception:
                pass
    return {}

def save_profiles(profiles):
    data_str = json.dumps(profiles, indent=2, ensure_ascii=False)
    for target in [PROFILES_FILE, WIN_PROFILES_FILE]:
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                f.write(data_str)
        except Exception as e:
            sys.stderr.write(f"Warning: could not write {target}: {e}\n")

def read_current_db_tokens():
    tokens = {}
    for db_path in get_db_paths():
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cur = conn.cursor()
            for k in DB_AUTH_KEYS:
                if k not in tokens:
                    cur.execute("SELECT value FROM ItemTable WHERE key = ?", (k,))
                    row = cur.fetchone()
                    if row:
                        val = row[0]
                        tokens[k] = val if isinstance(val, str) else val.decode("latin1")
            conn.close()
        except Exception:
            pass
    return tokens

def read_current_file_tokens():
    files = get_token_file_paths()
    res = {
        "cli_token": None,
        "standalone_token": None,
        "oauth_creds": None
    }
    for p in files["cli_token"]:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    res["cli_token"] = json.load(f)
                    break
            except Exception:
                pass

    for p in files["standalone_token"]:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    res["standalone_token"] = json.load(f)
                    break
            except Exception:
                pass

    for p in files["oauth_creds"]:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    res["oauth_creds"] = json.load(f)
                    break
            except Exception:
                pass

    # Ensure standalone format compatibility
    if not res["standalone_token"] and res["cli_token"] and "token" in res["cli_token"]:
        tok = res["cli_token"]["token"]
        res["standalone_token"] = {
            "token": {
                "access_token": tok.get("access_token"),
                "expiry": tok.get("expiry")
            }
        }

    return res

def write_db_tokens(db_tokens):
    if not db_tokens:
        return
    for db_path in get_db_paths():
        try:
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            for k, v in db_tokens.items():
                if v is not None:
                    cur.execute("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", (k, str(v)))
            conn.commit()
            conn.close()
        except Exception as e:
            sys.stderr.write(f"Error writing to {db_path}: {e}\n")

def write_file_tokens(file_tokens):
    if not file_tokens:
        return
    paths = get_token_file_paths()

    # 1. CLI Token
    cli_tok = file_tokens.get("cli_token")
    if cli_tok:
        content = json.dumps(cli_tok, indent=2)
        for p in paths["cli_token"]:
            try:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(content)
            except Exception:
                pass

    # 2. Standalone Token
    standalone_tok = file_tokens.get("standalone_token")
    if not standalone_tok and cli_tok and "token" in cli_tok:
        tok = cli_tok["token"]
        standalone_tok = {
            "token": {
                "access_token": tok.get("access_token"),
                "expiry": tok.get("expiry")
            }
        }

    if standalone_tok:
        content = json.dumps(standalone_tok, indent=2)
        for p in paths["standalone_token"]:
            try:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(content)
            except Exception:
                pass

    # 3. OAuth Creds
    oauth_creds = file_tokens.get("oauth_creds")
    if oauth_creds:
        content = json.dumps(oauth_creds, indent=2)
        for p in paths["oauth_creds"]:
            try:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(content)
            except Exception:
                pass

def restore_profile(profile):
    if not profile:
        raise ValueError("Cannot restore empty profile")
    db_tokens = profile.get("db_tokens") or profile.get("tokens", {})
    file_tokens = profile.get("file_tokens", {})
    write_db_tokens(db_tokens)
    write_file_tokens(file_tokens)

def cmd_save(label=None):
    email = detect_active_email()
    if not email:
        print("Error: No active Antigravity session detected across token files and databases.")
        return 1

    display_label = label.strip() if label and label.strip() else email.split("@")[0]
    db_tokens = read_current_db_tokens()
    file_tokens = read_current_file_tokens()

    profiles = load_profiles()
    profiles[email] = {
        "email": email,
        "label": display_label,
        "saved_at": datetime.now().isoformat(),
        "db_tokens": db_tokens,
        "file_tokens": file_tokens,
        "tokens": db_tokens
    }
    save_profiles(profiles)
    print(f"Account '{email}' saved as '[{display_label}]' successfully!")
    return 0

def find_profile(query, profiles):
    if query in profiles:
        return query, profiles[query]
    q_low = query.lower()
    for em, data in profiles.items():
        if em.lower() == q_low or data.get("label", "").lower() == q_low:
            return em, data
    return None, None

def cmd_load(query):
    profiles = load_profiles()
    em, profile = find_profile(query, profiles)
    if not profile:
        print(f"Error: Account matching '{query}' not found. Saved: {list(profiles.keys())}")
        return 1

    restore_profile(profile)
    label = profile.get("label") or em
    print(f"Successfully switched to '{label}' ({em}). Reload Antigravity IDE window to activate.")
    return 0

def cmd_list(as_json=False):
    profiles = load_profiles()
    curr_email = detect_active_email()

    out_list = []
    for em, data in profiles.items():
        is_active = bool(curr_email and em.lower() == curr_email.lower())
        out_list.append({
            "email": em,
            "label": data.get("label") or em.split("@")[0],
            "active": is_active,
            "saved_at": data.get("saved_at", "")
        })

    if as_json:
        result = {
            "accounts": out_list,
            "current_email": curr_email,
            "current_active_found": any(a["active"] for a in out_list)
        }
        print(json.dumps(result))
    else:
        print("=== Antigravity Accounts Vault ===")
        if not out_list:
            print("  (No accounts saved yet. Sign in and run 'python3 switch.py save [label]')")
        for a in out_list:
            status = " [ACTIVE NOW]" if a["active"] else ""
            print(f"* [{a['label']}] {a['email']}{status} (Saved: {a['saved_at'][:19].replace('T', ' ')})")
    return 0

def cmd_current(as_json=False):
    email = detect_active_email()
    profiles = load_profiles()
    matched_label = ""
    if email and email in profiles:
        matched_label = profiles[email].get("label", "")

    label = matched_label or (email.split("@")[0] if email else "No Account")

    if as_json:
        print(json.dumps({
            "is_active": bool(email),
            "email": email,
            "label": label,
            "is_saved": bool(matched_label)
        }))
    else:
        if email:
            print(f"[{label}] {email}")
        else:
            print("[No Account] (Signed Out)")
    return 0

def cmd_clear():
    save_profiles({})

    # 1. Clear DB keys
    for db_path in get_db_paths():
        try:
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            for k in DB_AUTH_KEYS:
                if k != "google.google-antigravity":
                    cur.execute("DELETE FROM ItemTable WHERE key = ?", (k,))
            # Strip username from google.google-antigravity
            cur.execute("SELECT value FROM ItemTable WHERE key = 'google.google-antigravity'")
            row = cur.fetchone()
            if row and row[0]:
                try:
                    data = json.loads(row[0])
                    if "antigravity-storage" in data:
                        data["antigravity-storage"].pop("jetski.onboarding.lastLoginUsername", None)
                        data["antigravity-storage"].pop("jetski.onboarding.lastLoginIsGcpTos", None)
                        cur.execute("INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('google.google-antigravity', ?)", (json.dumps(data),))
                except Exception:
                    pass
            conn.commit()
            conn.close()
        except Exception:
            pass

    # 2. Clear token files
    paths = get_token_file_paths()
    for cat in ["cli_token", "standalone_token", "oauth_creds"]:
        for p in paths[cat]:
            try:
                if os.path.exists(p):
                    os.unlink(p)
            except Exception:
                pass

    print("All profiles and active sessions cleared successfully!")
    return 0

def cmd_delete(query):
    profiles = load_profiles()
    em, profile = find_profile(query, profiles)
    if not em:
        print(f"Error: Account '{query}' not found.")
        return 1

    del profiles[em]
    save_profiles(profiles)
    print(f"Account '{em}' removed from saved vault.")
    return 0

def main():
    parser = argparse.ArgumentParser(description="Antigravity Account Switcher")
    subparsers = parser.add_subparsers(dest="command")

    save_p = subparsers.add_parser("save", help="Snapshot current active account")
    save_p.add_argument("label", nargs="?", default=None, help="Friendly label")

    load_p = subparsers.add_parser("load", help="Switch to an account by email or label")
    load_p.add_argument("query", help="Email or label to switch to")

    list_p = subparsers.add_parser("list", help="List all saved accounts")
    list_p.add_argument("--json", action="store_true", help="Output JSON")

    curr_p = subparsers.add_parser("current", help="Show currently active account")
    curr_p.add_argument("--json", action="store_true", help="Output JSON")

    del_p = subparsers.add_parser("delete", help="Remove an account from vault")
    del_p.add_argument("query", help="Email or label to delete")

    clear_p = subparsers.add_parser("clear", help="Clear all profiles and sessions")

    args = parser.parse_args()

    if args.command == "save":
        sys.exit(cmd_save(args.label))
    elif args.command == "load":
        sys.exit(cmd_load(args.query))
    elif args.command == "list":
        sys.exit(cmd_list(as_json=args.json))
    elif args.command == "current":
        sys.exit(cmd_current(as_json=args.json))
    elif args.command == "delete":
        sys.exit(cmd_delete(args.query))
    elif args.command == "clear":
        sys.exit(cmd_clear())
    else:
        cmd_list()

if __name__ == "__main__":
    main()
