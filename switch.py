#!/usr/bin/env python3
"""
Antigravity Account Switcher - Core Engine
Manages Google Antigravity account profiles across Antigravity IDE, Antigravity 2.0, and CLI.
"""

import sys
import os
import json
import sqlite3
import argparse
from datetime import datetime

PROFILES_FILE = os.path.expanduser("~/.gemini/antigravity_profiles.json")
ACTIVE_PROFILE_FILE = os.path.expanduser("~/.gemini/antigravity_active_profile.txt")

# Target databases
IDE_DB_WIN = "/mnt/c/Users/Ismael/AppData/Roaming/Antigravity IDE/User/globalStorage/state.vscdb"
APP_DB_WIN = "/mnt/c/Users/Ismael/AppData/Roaming/Antigravity/User/globalStorage/state.vscdb"

AUTH_KEYS = [
    "antigravityUnifiedStateSync.oauthToken",
    "antigravityUnifiedStateSync.userStatus",
    "antigravityUnifiedStateSync.modelCredits",
    "antigravityAuthStatus"
]

def get_db_paths():
    paths = []
    if os.path.exists(IDE_DB_WIN):
        paths.append(IDE_DB_WIN)
    if os.path.exists(APP_DB_WIN):
        paths.append(APP_DB_WIN)
    return paths

def load_profiles():
    if os.path.exists(PROFILES_FILE):
        try:
            with open(PROFILES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_profiles(profiles):
    os.makedirs(os.path.dirname(PROFILES_FILE), exist_ok=True)
    with open(PROFILES_FILE, "w", encoding="utf-8") as f:
        json.dump(profiles, f, indent=2, ensure_ascii=False)

def get_active_profile_name():
    if os.path.exists(ACTIVE_PROFILE_FILE):
        try:
            with open(ACTIVE_PROFILE_FILE, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            return None
    return None

def set_active_profile_name(name):
    os.makedirs(os.path.dirname(ACTIVE_PROFILE_FILE), exist_ok=True)
    with open(ACTIVE_PROFILE_FILE, "w", encoding="utf-8") as f:
        f.write(name)

def read_current_tokens():
    tokens = {}
    db_paths = get_db_paths()
    if not db_paths:
        return tokens
    
    # Read from the primary IDE DB
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

def cmd_save(name):
    tokens = read_current_tokens()
    if "antigravityUnifiedStateSync.oauthToken" not in tokens:
        print(f"Error: No active Antigravity session found in {IDE_DB_WIN}")
        return 1
    
    profiles = load_profiles()
    profiles[name] = {
        "name": name,
        "saved_at": datetime.now().isoformat(),
        "tokens": tokens
    }
    save_profiles(profiles)
    set_active_profile_name(name)
    print(f"Profile '{name}' saved successfully!")
    return 0

def cmd_load(name):
    profiles = load_profiles()
    if name not in profiles:
        print(f"Error: Profile '{name}' not found. Available: {list(profiles.keys())}")
        return 1
    
    profile = profiles[name]
    tokens = profile.get("tokens", {})
    write_tokens(tokens)
    set_active_profile_name(name)
    print(f"Switched active account to '{name}'.")
    return 0

def cmd_list(as_json=False):
    profiles = load_profiles()
    active = get_active_profile_name()
    current_tokens = read_current_tokens()
    curr_oauth = current_tokens.get("antigravityUnifiedStateSync.oauthToken")

    out_list = []
    for name, data in profiles.items():
        is_active = (name == active)
        token = data.get("tokens", {}).get("antigravityUnifiedStateSync.oauthToken")
        if curr_oauth and token and curr_oauth == token:
            is_active = True
        
        out_list.append({
            "name": name,
            "active": is_active,
            "saved_at": data.get("saved_at", "")
        })

    if as_json:
        print(json.dumps({"profiles": out_list, "active": active}))
    else:
        print("=== Antigravity Saved Profiles ===")
        if not out_list:
            print("  (No profiles saved yet. Use 'switch.py save <name>' to save current session.)")
        for p in out_list:
            status = " [ACTIVE]" if p["active"] else ""
            print(f"* {p['name']}{status} (Saved: {p['saved_at'][:19]})")
    return 0

def cmd_delete(name):
    profiles = load_profiles()
    if name in profiles:
        del profiles[name]
        save_profiles(profiles)
        active = get_active_profile_name()
        if active == name:
            set_active_profile_name("")
        print(f"Profile '{name}' deleted.")
        return 0
    else:
        print(f"Profile '{name}' not found.")
        return 1

def main():
    parser = argparse.ArgumentParser(description="Antigravity Account Switcher")
    subparsers = parser.add_subparsers(dest="command")

    save_p = subparsers.add_parser("save", help="Save current active session")
    save_p.add_argument("name", help="Profile name (e.g. personal, work)")

    load_p = subparsers.add_parser("load", help="Load/switch to a profile")
    load_p.add_argument("name", help="Profile name to switch to")

    list_p = subparsers.add_parser("list", help="List all saved profiles")
    list_p.add_argument("--json", action="store_true", help="Output in JSON format")

    del_p = subparsers.add_parser("delete", help="Delete a saved profile")
    del_p.add_argument("name", help="Profile name to delete")

    current_p = subparsers.add_parser("current", help="Get active profile")

    args = parser.parse_args()

    if args.command == "save":
        sys.exit(cmd_save(args.name))
    elif args.command == "load":
        sys.exit(cmd_load(args.name))
    elif args.command == "list":
        sys.exit(cmd_list(as_json=args.json))
    elif args.command == "delete":
        sys.exit(cmd_delete(args.name))
    elif args.command == "current":
        active = get_active_profile_name() or "Unknown"
        print(active)
    else:
        cmd_list()

if __name__ == "__main__":
    main()
