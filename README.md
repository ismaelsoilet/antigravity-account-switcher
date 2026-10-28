# Antigravity Account Switcher

> **Visual Account Switcher & Profile Manager for Google Antigravity (IDE, Desktop 2.0, and CLI)**

[![GitHub license](https://img.shields.io/github/license/ismaelsoilet/antigravity-account-switcher)](https://github.com/ismaelsoilet/antigravity-account-switcher)
[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](https://github.com/ismaelsoilet/antigravity-account-switcher)

An embedded extension and CLI utility that allows developers to seamlessly save, manage, and toggle between multiple Google accounts on the same computer without continuous browser re-authentication.

---

## 🌟 What's New & Key Features

* **Live Account Indicator in Status Bar:**  
  Directly displays your active profile and Google email at the bottom of Antigravity IDE:
  ```
  $(account) [Primary] onmultimidiaservice@gmail.com
  ```
  *Hovering displays account metadata, user details, and synchronization status.*

* **Safeguarded Account Switching with Confirmation Dialog:**  
  Prevents accidental switches during active work. Selecting a profile opens a modal confirmation with a reload alert. Upon confirmation, Antigravity IDE immediately applies the session and reloads.

* **Streamlined New Account Flow with Auto-Reload:**  
  When adding a new Google account:
  1. Displays an explanatory confirmation dialog.
  2. Opens Google OAuth in your browser.
  3. Detects successful sign-in automatically, prompts you to label the profile, and reloads Antigravity IDE with the new session active.

* **Unified Master Controller:**  
  Switching an account in the IDE automatically updates:
  * **Antigravity IDE** *(active immediately after reload)*
  * **Antigravity 2.0 Desktop App** *(active on restart)*
  * **Terminal CLI (`agy`)** *(active immediately)*

* **Dedicated CLI (`agy-switch`):**  
  Full terminal control for power users and CI/CD environments.

---

## 💡 Why Did Google Unify Accounts?

In recent updates, Google introduced **Unified State Sync (USS)** (`antigravityUnifiedStateSync`).

1. **Eliminating Fragmented Logins:** Previously, you had to authenticate separately across the IDE, Desktop 2.0, and CLI.
2. **Unified Quota & Model Tiers:** Model credit allocations (`antigravityUnifiedStateSync.modelCredits`), autocomplete speed, and settings sync across all tools in real-time.
3. **Single Local Daemon:** Under the hood, all surfaces now communicate with a single local Language Server / agent host (`agy --hub`) pointing to `~/.gemini/antigravity`.

### Are AI Chats and Sessions Synced Too?
* **Yes!** All conversation history is stored locally in `~/.gemini/antigravity/conversation_summaries.db` and the `conversations/` and `brain/` directories.
* Both Antigravity 2.0 and Antigravity IDE share access to these conversation threads and brain artifacts.
* **UI Filtering Differences:**
  * **In Antigravity IDE:** The sidebar chat list automatically filters sessions to only show conversations associated with the currently open workspace folder (`workspace_uris`).
  * **In Antigravity 2.0 Desktop:** The left sidebar displays conversations globally across all your projects and workspaces.
* **Cross-App Continuation:** You can start a conversation in the IDE, let the turn finish, and continue it in Antigravity 2.0 or via `agy -c` in your terminal.

---

## 🛠️ Usage Guide

### A. From Antigravity IDE (Visual UI)

1. Look at the bottom-right status bar in Antigravity IDE:  
   Click **`Antigravity: [Profile] email@...`**.
2. **Switching Accounts:**
   * Select a saved profile.
   * A confirmation dialog appears explaining that the window will reload.
   * Click **`Switch & Reload`**.
3. **Adding a New Account:**
   * Click the status bar → **`Sign In to New Google Account...`**.
   * Confirm the dialog → Browser opens for Google OAuth.
   * Complete sign-in in browser → The IDE detects completion, asks you for a profile name, and reloads!
4. **Snapshotting Current Account:**
   * Click the status bar → **`Snapshot Current Session as Profile...`** → Enter a label (e.g. `Personal`, `Work`, `ClientA`).

---

### B. From the Terminal (`agy-switch` CLI)

```bash
# List all saved profiles and see which is active
agy-switch list

# Output active profile information
agy-switch current

# Save the currently active session as a named profile
agy-switch save "Work"

# Switch active account across all surfaces
agy-switch load "Personal"

# Delete a profile from vault
agy-switch delete "OldAccount"
```

---

## 📦 Installation & Sync

Run the installer from the repo:
```bash
./install.sh
```

Then reload Antigravity IDE (`Ctrl + Shift + P` → `Developer: Reload Window`).
