#!/usr/bin/env python3
"""
Antigravity Account Switcher - Core Engine (v1.3.0)
Deduplicated, email-keyed profile management across Antigravity IDE, 2.0 Desktop, and CLI.
"""

import sys
import os
import json
import sqlite3
import argparse
from datetime import datetime

PROFILES_FILE = os.path.expanduser("~/.gemini/antigravity_profiles.json")
WIN_PROFILES_FILE = "/mnt/c/Users/Ismael/.gemini/antigravity_profiles.json"
ACTIVE_PROFILE_FILE = os.path.expanduser("~/.gemini/antigravity_active_profile.txt")

# Target databases
IDE_DB_WIN = "/mnt/c/Users/Ismael/AppData/Roaming/Antigravity IDE/User/globalStorage/state.vscdb"
APP_DB_WIN = "/mnt/c/Users/Ismael/AppData/Roaming/Antigravity/User/globalStorage/state.vscdb"

AUTH_KEYS = [
    "antigravityUnifiedStateSync.oauthToken",
    "antigravityUnifiedStateSync.userStatus",
    "antigravityUnifiedStateSync.modelCredits",
    "antigravityAuthStatus",
    "google.google-antigravity"
]

def get_db_paths():
    paths = []
    if os.path.exists(IDE_DB_WIN):
        paths.append(IDE_DB_WIN)
    if os.path.exists(APP_DB_WIN):
        paths.append(APP_DB_WIN)
    return paths

def load_profiles():
    target = PROFILES_FILE
    if not os.path.exists(target) and os.path.exists(WIN_PROFILES_FILE):
        target = WIN_PROFILES_FILE

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
                            "tokens": v.get("tokens", {})
                        }
                return clean
        except Exception:
            return {}
    return {}

def save_profiles(profiles):
    for path_target in [PROFILES_FILE, WIN_PROFILES_FILE]:
        try:
            os.makedirs(os.path.dirname(path_target), exist_ok=True)
            with open(path_target, "w", encoding="utf-8") as f:
                json.dump(profiles, f, indent=2, ensure_ascii=False)
        except Exception as e:
            sys.stderr.write(f"Warning: could not write {path_target}: {e}\n")

def extract_email(tokens):
    raw = tokens.get("google.google-antigravity")
    if raw:
        try:
            data = json.loads(raw)
            storage = data.get("antigravity-storage", {})
            if isinstance(storage, dict):
                em = storage.get("jetski.onboarding.lastLoginUsername", "")
                if em and "@" in em:
                    return em
        except Exception:
            pass
    return ""

def read_current_tokens():
    tokens = {}
    db_paths = get_db_paths()
    if not db_paths:
        return tokens

    primary_db = db_paths[0]
    try:
        conn = sqlite3.connect(f"file:{primary_db}?mode=ro", uri=True)
        cur = conn.cursor()
        for k in AUTH_KEYS:
            cur.execute("SELECT value FROM ItemTable WHERE key = ?", (k,))
            row = cur.fetchone()
            if row:
                val = row[0]
                tokens[k] = val if isinstance(val, str) else val.decode("latin1")
        conn.close()
    except Exception as e:
        sys.stderr.write(f"Error reading current tokens: {e}\n")
    return tokens

def write_tokens(tokens):
    db_paths = get_db_paths()
    for db_path in db_paths:
        try:
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            for k, v in tokens.items():
                if v is not None:
                    cur.execute("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", (k, v))
            conn.commit()
            conn.close()
        except Exception as e:
            sys.stderr.write(f"Error writing tokens to {db_path}: {e}\n")

def cmd_save(label=None):
    tokens = read_current_tokens()
    if "antigravityUnifiedStateSync.oauthToken" not in tokens:
        print(f"Error: No active Antigravity session found in {IDE_DB_WIN}")
        return 1

    email = extract_email(tokens)
    if not email:
        email = "unknown_account@antigravity"

    display_label = label.strip() if label and label.strip() else email.split("@")[0]

    profiles = load_profiles()
    profiles[email] = {
        "email": email,
        "label": display_label,
        "saved_at": datetime.now().isoformat(),
        "tokens": tokens
    }
    save_profiles(profiles)
    print(f"Account '{email}' saved with label '{display_label}' successfully!")
    return 0

def find_profile(query, profiles):
    # Match by exact email
    if query in profiles:
        return query, profiles[query]
    # Match by case-insensitive email or label
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

    tokens = profile.get("tokens", {})
    write_tokens(tokens)
    label = profile.get("label") or em
    print(f"Successfully switched to '{label}' ({em}).")
    return 0

def cmd_list(as_json=False):
    profiles = load_profiles()
    current_tokens = read_current_tokens()
    curr_oauth = current_tokens.get("antigravityUnifiedStateSync.oauthToken")
    curr_email = extract_email(current_tokens)

    out_list = []
    for em, data in profiles.items():
        tok = data.get("tokens", {}).get("antigravityUnifiedStateSync.oauthToken")
        is_active = False
        if curr_email:
            is_active = (em.lower() == curr_email.lower())
        elif curr_oauth and tok:
            is_active = (curr_oauth == tok)

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
            print("  (No accounts saved yet. Sign in and run 'agy-switch save [label]')")
        for a in out_list:
            status = " [ACTIVE NOW]" if a["active"] else ""
            print(f"* [{a['label']}] {a['email']}{status} (Saved: {a['saved_at'][:19].replace('T', ' ')})")
    return 0

def cmd_current(as_json=False):
    current_tokens = read_current_tokens()
    email = extract_email(current_tokens)
    curr_oauth = current_tokens.get("antigravityUnifiedStateSync.oauthToken")

    profiles = load_profiles()
    matched_label = ""
    if email and email in profiles:
        matched_label = profiles[email].get("label", "")
    elif curr_oauth:
        for em, p in profiles.items():
            if p.get("tokens", {}).get("antigravityUnifiedStateSync.oauthToken") == curr_oauth:
                matched_label = p.get("label", "")
                break

    label = matched_label or (email.split("@")[0] if email else "Unsaved Session")

    if as_json:
        print(json.dumps({
            "email": email,
            "label": label,
            "is_saved": bool(matched_label)
        }))
    else:
        print(f"[{label}] {email or 'No active email detected'}")
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
    save_p.add_argument("label", nargs="?", default=None, help="Optional friendly label (e.g. Personal, Work)")

    load_p = subparsers.add_parser("load", help="Switch to an account by email or label")
    load_p.add_argument("query", help="Email or profile label to switch to")

    list_p = subparsers.add_parser("list", help="List all saved accounts")
    list_p.add_argument("--json", action="store_true", help="Output JSON")

    curr_p = subparsers.add_parser("current", help="Show currently active account")
    curr_p.add_argument("--json", action="store_true", help="Output JSON")

    del_p = subparsers.add_parser("delete", help="Remove an account from saved storage")
    del_p.add_argument("query", help="Email or profile label to delete")

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
    else:
        cmd_list()

if __name__ == "__main__":
    main()
