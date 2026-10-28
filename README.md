# Antigravity Account Switcher

> **Visual Account Switcher & Profile Manager for Google Antigravity (IDE, Desktop 2.0, and CLI)**

[![GitHub license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.4.0-blue.svg)](package.json)
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
  3. Detects authentication completion automatically, prompts you to label the profile, and reloads Antigravity IDE with the new session active.

* **Strict Session Gating (Zero Phantom Accounts):**  
  Accurately validates active OAuth tokens before extracting account identities. Never displays stale or historical accounts when logged out.

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
3. **Session Vault:** The switcher maintains an isolated, encrypted profile vault (`antigravity_profiles.json`) containing token sets keyed strictly by Google email. When switching, it atomically updates the local SQLite storage tables and notifies the language server client.

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
```

---

## 📦 Installation

### Method 1: Using the Automated Installer (Recommended)

From the cloned repository directory:

```bash
./install.sh
```

This automatically:
1. Copies the extension to Windows Antigravity IDE (`.antigravity-ide/extensions`).
2. Copies the extension to the WSL Remote Server (`.antigravity-server/extensions`).
3. Sets up the `agy-switch` executable shortcut in `~/.local/bin`.

Then reload Antigravity IDE (`Ctrl + Shift + P` → `Developer: Reload Window`).

### Method 2: Installing the VSIX Package Directly

1. In Antigravity IDE, open the Command Palette (`Ctrl + Shift + P`).
2. Type and select **`Extensions: Install from VSIX...`**.
3. Select `antigravity-account-switcher-1.4.0.vsix` located in the repository folder.
4. Reload the window when prompted.

---

## 📄 License

This project is open-sourced under the [MIT License](LICENSE).
