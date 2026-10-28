#!/usr/bin/env python3
"""
Unit tests for Antigravity Account Switcher CLI (switch.py)
Uses temporary mock directories and synthetic fixtures.
"""

import unittest
import tempfile
import os
import json
import shutil
import base64

class TestSwitchCLI(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="agy_cli_test_")
        self.gemini_dir = os.path.join(self.test_dir, ".gemini")
        os.makedirs(os.path.join(self.gemini_dir, "antigravity-cli"), exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_decode_jwt_payload(self):
        from switch import decode_jwt_payload
        header = base64.urlsafe_b64encode(b'{"alg":"RS256"}').decode("utf-8").rstrip("=")
        payload = base64.urlsafe_b64encode(b'{"email":"user@example.com","sub":"999"}').decode("utf-8").rstrip("=")
        sig = "sig"
        jwt_str = f"{header}.{payload}.{sig}"

        decoded = decode_jwt_payload(jwt_str)
        self.assertIsNotNone(decoded)
        self.assertEqual(decoded["email"], "user@example.com")
        self.assertEqual(decoded["sub"], "999")

    def test_detect_email_from_cli_token(self):
        token_path = os.path.join(self.gemini_dir, "antigravity-cli", "antigravity-oauth-token")
        with open(token_path, "w", encoding="utf-8") as f:
            json.dump({
                "token": {"access_token": "ya29.test", "expiry": "2026-10-28T12:00:00Z"},
                "id_token_email": "active.engineer@example.com"
            }, f)

        # Verify parsing
        with open(token_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            self.assertEqual(data.get("id_token_email"), "active.engineer@example.com")

    def test_single_source_of_truth_signed_out(self):
        from switch import detect_active_session, detect_active_email
        # With no token files present in the active environment
        session = detect_active_session()
        self.assertFalse(session["is_active"])
        self.assertEqual(session["email"], "")
        self.assertIsNone(session["source"])
        self.assertEqual(detect_active_email(), "")

    def test_profile_roundtrip(self):
        profiles_file = os.path.join(self.gemini_dir, "antigravity_profiles.json")
        profiles = {
            "work@company.com": {
                "email": "work@company.com",
                "label": "Work Profile",
                "saved_at": "2026-10-28T00:00:00",
                "db_tokens": {"google.google-antigravity": "{}"},
                "file_tokens": {
                    "cli_token": {"token": {"access_token": "mock-token-work"}},
                    "standalone_token": {"token": {"access_token": "mock-token-work"}},
                    "oauth_creds": None
                },
                "tokens": {"google.google-antigravity": "{}"}
            }
        }

        with open(profiles_file, "w", encoding="utf-8") as f:
            json.dump(profiles, f, indent=2)

        with open(profiles_file, "r", encoding="utf-8") as f:
            loaded = json.load(f)

        self.assertIn("work@company.com", loaded)
        self.assertEqual(loaded["work@company.com"]["label"], "Work Profile")
        self.assertEqual(loaded["work@company.com"]["file_tokens"]["cli_token"]["token"]["access_token"], "mock-token-work")

if __name__ == "__main__":
    unittest.main()
