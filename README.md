# Antigravity Account Switcher

> **Visual Account Switcher & Profile Manager for Google Antigravity (IDE, Desktop 2.0, and CLI)**

[![GitHub license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.7.1-blue.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20WSL%20%7C%20Linux-lightgrey.svg)]()

An embedded extension and CLI utility that allows developers to seamlessly save, manage, and toggle between multiple Google accounts on the same computer without continuous browser re-authentication or session conflicts.

---

## 🌟 Key Features

* **Visual Status Bar Indicator:**  
  Directly displays your active profile and Google email at the bottom of Antigravity IDE:
  ```text
  $(account) [Work] work@company.com
  ```
  When signed out or without active credentials, displays:
  ```text
  $(account) [No Account] Sign In
  ```
  *Hovering displays account metadata, profile label, vault storage status, and synchronization info.*

* **Safeguarded Account Switching with Confirmation Dialog:**  
  Prevents accidental switches during active work. Selecting a profile opens a modal confirmation with a reload alert. Upon confirmation, Antigravity IDE immediately applies the session and reloads.

* **Streamlined New Account Flow with Auto-Reload:**  
  When adding a new Google account:
  1. Displays an explanatory confirmation dialog.
  2. Opens Google OAuth in your default browser.
  3. Waits for authentication, offers **Save Profile & Reload**, and reloads only after the new token is detected.

* **Strict Session Gating (Zero Phantom Accounts):**  
  Validates that a token is usable (a non-expired access token or a refresh token) and never infers a session from historical SQLite onboarding keys. Manual registration only works while a real OAuth token exists and the email matches the token owner.

* **Deterministic Switching (No Stale Sessions):**  
  Before restoring a profile, the switcher clears auth keys and token files that are not part of that profile, so the IDE, Desktop and CLI cannot keep authenticating as the previous account.

* **Canonical Vault Format:**  
  Profiles saved by the CLI (`switch.py`) and the extension (`tokenManager.js`) use the same normalized format. Legacy `cli_token` / `standalone_token` / `oauth_creds` keys are migrated automatically.

* **Local Vault Hardening:**  
  The vault and token files are written atomically with `0600` permissions. The previous vault is preserved as `antigravity_profiles.json.bak`, and corrupt vaults are preserved as `.corrupt-<timestamp>.json` instead of being silently discarded.

* **Built-in Diagnostics:**  
  Run **Antigravity: Show Account Switcher Diagnostics** or `agy-switch diagnostics` to print detected database paths, token paths, runtime support and vault warnings.

* **Dual-Host Support (Windows & WSL Remote Workspaces):**  
  Configured with `"extensionKind": ["ui", "workspace"]` to function smoothly whether working on local Windows folders or remote WSL (`wsl+ubuntu`) workspaces.

* **Unified Master Controller:**  
  Switching an account in the IDE automatically synchronizes across all surfaces:
  * **Antigravity IDE** *(active immediately after reload)*
  * **Antigravity 2.0 Desktop App** *(active on restart)*
  * **Terminal CLI (`agy`)** *(active immediately)*

* **Dedicated CLI (`agy-switch`):**  
  Full terminal control for power users, scripts, and terminal workflows.

---

## 💡 Architecture & How It Works

### Unified State Sync (USS)
Google Antigravity utilizes **Unified State Sync (USS)** (`antigravityUnifiedStateSync`) across its desktop surfaces:
1. **Unified Authentication:** Credentials, model quotas (`antigravityUnifiedStateSync.modelCredits`), and preferences are stored in the application's global storage database (`state.vscdb`).
2. **Shared Local Daemon:** Antigravity IDE, Antigravity 2.0 Desktop, and the CLI share a local language server daemon.
3. **Session Vault:** The switcher stores profiles in `antigravity_profiles.json`, keyed by Google email and protected by owner-only permissions (`0600`). Writes are atomic and keep a `.bak` of the previous vault. The vault is **not encrypted**; it relies on filesystem permissions. When switching, the extension replaces the SQLite auth keys and OAuth token files, removes any stale store that does not belong to the target profile, and then reloads the window.

### Conversation & Chat Sync
* Conversation history is stored in local SQLite databases (`conversation_summaries.db`).
* **In Antigravity IDE:** The sidebar chat list automatically scopes conversations to the currently active workspace directory (`workspace_uris`).
* **In Antigravity 2.0 Desktop:** The left sidebar displays conversations globally across all projects.

---

## 🛠️ Usage Guide

### A. From Antigravity IDE (Visual UI)

1. **Status Bar Menu:**  
   Click the account item in the bottom-right status bar:
   ```text
   $(account) [Work] work@company.com
   ```

2. **Switching Accounts:**
   * Select any saved profile from the list (e.g., `[Personal] personal@example.com`).
   * Confirm the prompt: **`Switch & Reload`**.
   * The window reloads with the selected account active across all surfaces.

3. **Connecting a New Account:**
   * Click **`Connect / Sign In to Google Account...`**.
   * Complete Google Sign-In in your browser.
   * The IDE detects authentication completion, prompts you for a friendly profile label, and reloads.

4. **Saving an Active Account:**
   * Click **`Save Active Account...`** to store the current session into the vault under a custom label (e.g., `Work`, `Personal`, `Contractor`).

5. **Logging Out:**
   * Click **`Log Out Current Account...`** to disconnect the session without deleting your saved profiles.

6. **Resetting Data:**  
   * Click **`Reset / Clear All Switcher Data...`** to perform a clean factory reset of the vault and session data.

7. **Diagnostics:**  
   * Click **`Show Diagnostics`** to print paths, runtime support and vault warnings to the "Antigravity Account Switcher" output channel.

---

### B. From the Terminal (`agy-switch` CLI)

```bash
# List all saved profiles and highlight the active account
agy-switch list

# Display the currently active session
agy-switch current

# Save the currently active session as a named profile
agy-switch save "Work"

# Switch active account by email or friendly label
agy-switch load "Personal"
# or
agy-switch load "work@company.com"

# Remove a specific profile from the vault
agy-switch delete "OldProfile"

# Factory reset: clear all profiles and active session tokens
agy-switch clear

# Inspect paths, runtime support and vault warnings
agy-switch diagnostics

# Print the CLI version
agy-switch --version
```

`agy-switch save` only snapshots a real active session. If the token has no embedded email, pass `--email user@example.com`; an email that does not match the active token is rejected.

---

## 📦 Installation

### Method 1: Using the Automated Installer (Recommended)

From the cloned repository directory:

```bash
./install.sh
```

The installer auto-detects the Windows home (or honours `ANTIGRAVITY_WIN_HOME`), installs into the Windows IDE and WSL server extension folders, removes duplicate/older copies of this extension, and installs the CLI as a real file in `~/.local/bin/agy-switch`.

Preview every action first:

```bash
./install.sh --dry-run
```

The directory copy is the actual installation. If you also want the server CLI to register the VSIX, add `--register-vsix` (some Antigravity server builds crash after registering; the copy still works).

Then reload Antigravity IDE (`Ctrl + Shift + P` → `Developer: Reload Window`).

### Method 2: Installing the VSIX Package Directly

1. In Antigravity IDE, open the Command Palette (`Ctrl + Shift + P`).
2. Type and select **`Extensions: Install from VSIX...`**.
3. Select `antigravity-account-switcher-1.7.1.vsix` located in the repository folder.
4. Reload the window when prompted.

To rebuild the VSIX from source:

```bash
npm run package
```

---

## 🔐 Security & Data

* The vault is **not encrypted**. It is protected by filesystem permissions (`0600`) and must never be committed to Git; the repository `.gitignore` already excludes it.
* The vault stores OAuth access and refresh tokens for every saved account, plus the Antigravity auth status. Treat `~/.gemini/antigravity_profiles.json` as a secret.
* Before each save, the previous vault is copied to `antigravity_profiles.json.bak`. A corrupt vault is preserved as `antigravity_profiles.json.corrupt-<timestamp>.json` instead of being silently discarded.
* Switching accounts removes token files and database auth keys that are not present in the target profile. This prevents a stale session from surviving a switch.
* On Windows/WSL, permission enforcement is best-effort. Do not share the Windows user profile with untrusted local users.

---

## 🧪 Testing

```bash
npm test
```

The suite is hermetic: it uses temporary homes and temporary SQLite databases, and never touches your real Antigravity session. The Node tests require `node:sqlite` (Node 22.13+ or Antigravity's bundled runtime); the Python tests use the standard library only.

---

## 🩺 Troubleshooting

* **Status bar says "Email not detected":** a token exists but has no email claim. Use **Register Email for Active Session** (only accepted when it matches the active token) or sign in again.
* **Database sync unavailable:** the host does not expose `node:sqlite`. Antigravity 1.107+ does; older or embedded hosts may not. Use **Show Diagnostics** to confirm.
* **A switch reports a failure:** the extension does not reload silently on errors. Check the "Antigravity Account Switcher" output channel; when a write fails, the previous session is left intact.
* **Recovering a profile:** if a vault was corrupt, inspect the generated `.corrupt-*.json` backup before importing it manually.
* **The CLI cannot find the databases:** run `agy-switch diagnostics`. On non-WSL Linux/macOS, database paths are discovered only where Antigravity actually stores `state.vscdb`; file-token switching still works.

---

## 📄 License

This project is open-sourced under the [MIT License](LICENSE).
