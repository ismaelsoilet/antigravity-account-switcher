#!/usr/bin/env python3
"""
Antigravity Account Switcher - CLI Core Engine (v2.0)
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
import re
import argparse
from datetime import datetime

EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")

def is_valid_email(val):
    return bool(val and isinstance(val, str) and EMAIL_REGEX.match(val.strip()))

def get_candidate_homes():
    homes = [
        os.path.expanduser("~"),
        "/home/ismaelsoilet",
        "/mnt/c/Users/Ismael"
    ]
    return list(dict.fromkeys([h for h in homes if os.path.exists(h)]))

def get_gemini_dirs():
    dirs = []
    for h in get_candidate_homes():
        g = os.path.join(h, ".gemini")
        dirs.append(g)
    return list(dict.fromkeys(dirs))

def get_token_file_paths():
    gdirs = get_gemini_dirs()
    return {
        "cli_token": list(dict.fromkeys([os.path.join(d, "antigravity-cli", "antigravity-oauth-token") for d in gdirs])),
        "standalone_token": list(dict.fromkeys([os.path.join(d, "jetski-standalone-oauth-token") for d in gdirs])),
        "oauth_creds": list(dict.fromkeys([os.path.join(d, "oauth_creds.json") for d in gdirs]))
    }

def get_db_paths():
    candidates = [
        "/mnt/c/Users/Ismael/AppData/Roaming/Antigravity IDE/User/globalStorage/state.vscdb",
        "/mnt/c/Users/Ismael/AppData/Roaming/Antigravity/User/globalStorage/state.vscdb"
    ]
    return [p for p in candidates if os.path.exists(p)]

def get_profiles_file_paths():
    return [os.path.join(d, "antigravity_profiles.json") for d in get_gemini_dirs()]

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
    Cascading detection of active account email across all databases and token files
    """
    # 1. Check SQLite Databases
    for db_path in get_db_paths():
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cur = conn.cursor()

            # 1a. google.google-antigravity
            cur.execute("SELECT value FROM ItemTable WHERE key = 'google.google-antigravity'")
            row = cur.fetchone()
            if row and row[0]:
                try:
                    data = json.loads(row[0])
                    storage = data.get("antigravity-storage", {})
                    if isinstance(storage, dict):
                        candidates = [
                            storage.get("agy.onboarding.lastLoginUsername"),
                            storage.get("jetski.onboarding.lastLoginUsername"),
                            storage.get("onboarding.lastLoginUsername"),
                            storage.get("lastLoginUsername")
                        ]
                        for cand in candidates:
                            if is_valid_email(cand):
                                conn.close()
                                return cand.strip()

                        for val in storage.values():
                            if is_valid_email(val):
                                conn.close()
                                return str(val).strip()
                except Exception:
                    pass

            # 1b. antigravityAuthStatus
            cur.execute("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'")
            row = cur.fetchone()
            if row and row[0]:
                try:
                    data = json.loads(row[0])
                    em = data.get("email")
                    if is_valid_email(em):
                        conn.close()
                        return em.strip()
                except Exception:
                    pass

            # 1c. google.geminicodeassist
            cur.execute("SELECT value FROM ItemTable WHERE key = 'google.geminicodeassist'")
            row = cur.fetchone()
            if row and row[0]:
                try:
                    data = json.loads(row[0])
                    threads = data.get("geminiCodeAssist.chatThreads", {})
                    if isinstance(threads, dict):
                        for k in threads.keys():
                            if is_valid_email(k):
                                conn.close()
                                return k.strip()
                except Exception:
                    pass

            conn.close()
        except Exception:
            pass

    # 2. Check token files
    files = get_token_file_paths()
    for p in files["cli_token"]:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    em = data.get("id_token_email")
                    if is_valid_email(em):
                        return em.strip()
                    id_tok = data.get("token", {}).get("id_token")
                    if id_tok:
                        payload = decode_jwt_payload(id_tok)
                        if payload and is_valid_email(payload.get("email")):
                            return payload["email"].strip()
            except Exception:
                pass

    for p in files["oauth_creds"]:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    id_tok = data.get("id_token")
                    if id_tok:
                        payload = decode_jwt_payload(id_tok)
                        if payload and is_valid_email(payload.get("email")):
                            return payload["email"].strip()
            except Exception:
                pass

    return ""

def load_profiles():
    targets = get_profiles_file_paths()
    for target in targets:
        if os.path.exists(target):
            try:
                with open(target, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                    clean = {}
                    for k, v in raw.items():
                        em = v.get("email") or k
                        if is_valid_email(em):
                            clean[em.strip()] = {
                                "email": em.strip(),
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
    for target in get_profiles_file_paths():
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                f.write(data_str)
        except Exception as e:
            sys.stderr.write(f"Warning: could not write {target}: {e}\n")

def read_current_db_tokens():
    tokens = {}
    auth_keys = [
        "antigravityUnifiedStateSync.oauthToken",
        "antigravityUnifiedStateSync.userStatus",
        "antigravityUnifiedStateSync.modelCredits",
        "antigravityAuthStatus",
        "google.google-antigravity"
    ]
    for db_path in get_db_paths():
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cur = conn.cursor()
            for k in auth_keys:
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
    email = profile.get("email")

    db_tokens = dict(profile.get("db_tokens") or profile.get("tokens", {}))
    # Patch all known email keys in google.google-antigravity
    ag_data = {}
    if db_tokens.get("google.google-antigravity"):
        try:
            ag_data = json.loads(db_tokens["google.google-antigravity"])
        except Exception:
            pass
    if "antigravity-storage" not in ag_data:
        ag_data["antigravity-storage"] = {}
    ag_data["antigravity-storage"]["agy.onboarding.lastLoginUsername"] = email
    ag_data["antigravity-storage"]["jetski.onboarding.lastLoginUsername"] = email
    ag_data["antigravity-storage"]["agy.onboarding.lastLoginIsGcpTos"] = "false"
    ag_data["antigravity-storage"]["jetski.onboarding.lastLoginIsGcpTos"] = "false"
    db_tokens["google.google-antigravity"] = json.dumps(ag_data)

    if "antigravityAuthStatus" not in db_tokens:
        db_tokens["antigravityAuthStatus"] = json.dumps({"email": email, "apiKey": ""})

    write_db_tokens(db_tokens)
    write_file_tokens(profile.get("file_tokens", {}))

def cmd_save(label=None, manual_email=None):
    email = (manual_email and manual_email.strip()) or detect_active_email()
    if not email or not is_valid_email(email):
        print("Error: No active Antigravity session detected across databases and token files.")
        print("You can manually specify an email: python3 switch.py save [label] --email user@example.com")
        return 1

    clean_email = email.strip()
    display_label = label.strip() if label and label.strip() else clean_email.split("@")[0]

    db_tokens = read_current_db_tokens()
    file_tokens = read_current_file_tokens()

    # Ensure google.google-antigravity contains correct email keys
    ag_data = {}
    if db_tokens.get("google.google-antigravity"):
        try:
            ag_data = json.loads(db_tokens["google.google-antigravity"])
        except Exception:
            pass
    if "antigravity-storage" not in ag_data:
        ag_data["antigravity-storage"] = {}
    ag_data["antigravity-storage"]["agy.onboarding.lastLoginUsername"] = clean_email
    ag_data["antigravity-storage"]["jetski.onboarding.lastLoginUsername"] = clean_email
    ag_data["antigravity-storage"]["agy.onboarding.lastLoginIsGcpTos"] = "false"
    ag_data["antigravity-storage"]["jetski.onboarding.lastLoginIsGcpTos"] = "false"
    db_tokens["google.google-antigravity"] = json.dumps(ag_data)

    if "antigravityAuthStatus" not in db_tokens:
        db_tokens["antigravityAuthStatus"] = json.dumps({"email": clean_email, "apiKey": ""})

    if file_tokens.get("cli_token"):
        file_tokens["cli_token"]["id_token_email"] = clean_email

    profiles = load_profiles()
    profiles[clean_email] = {
        "email": clean_email,
        "label": display_label,
        "saved_at": datetime.now().isoformat(),
        "db_tokens": db_tokens,
        "file_tokens": file_tokens,
        "tokens": db_tokens
    }
    save_profiles(profiles)
    write_db_tokens(db_tokens)

    print(f"Account '{clean_email}' saved as '[{display_label}]' successfully!")
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

    auth_keys = [
        "antigravityUnifiedStateSync.oauthToken",
        "antigravityUnifiedStateSync.userStatus",
        "antigravityUnifiedStateSync.modelCredits",
        "antigravityAuthStatus"
    ]

    for db_path in get_db_paths():
        try:
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            for k in auth_keys:
                cur.execute("DELETE FROM ItemTable WHERE key = ?", (k,))
            # Strip username from google.google-antigravity
            cur.execute("SELECT value FROM ItemTable WHERE key = 'google.google-antigravity'")
            row = cur.fetchone()
            if row and row[0]:
                try:
                    data = json.loads(row[0])
                    if "antigravity-storage" in data:
                        data["antigravity-storage"].pop("agy.onboarding.lastLoginUsername", None)
                        data["antigravity-storage"].pop("jetski.onboarding.lastLoginUsername", None)
                        data["antigravity-storage"].pop("agy.onboarding.lastLoginIsGcpTos", None)
                        data["antigravity-storage"].pop("jetski.onboarding.lastLoginIsGcpTos", None)
                        cur.execute("INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('google.google-antigravity', ?)", (json.dumps(data),))
                except Exception:
                    pass
            conn.commit()
            conn.close()
        except Exception:
            pass

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
    save_p.add_argument("--email", default=None, help="Explicit Google email if auto-detection fails")

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
        sys.exit(cmd_save(args.label, args.email))
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
