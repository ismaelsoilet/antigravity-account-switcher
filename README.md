# Antigravity Account Switcher

> **Visual Account & Profile Switcher for Google Antigravity (IDE, Desktop 2.0, and CLI)**

An embedded extension and CLI utility that allows developers to seamlessly save, manage, and toggle between multiple Google accounts on the same computer without constant browser re-authentication.

---

## 💡 Why Google Unified Accounts & What Gets Synced

In recent updates, Google introduced **Unified State Sync (USS)** (`antigravityUnifiedStateSync`).

### Why Google Did This:
1. **Eliminating Fragmented Logins:** Previously, developers had to authenticate separately on Antigravity IDE (VS Code fork), Antigravity 2.0 (Electron desktop companion), and the CLI (`agy`).
2. **Unified Quota & Model Tiers:** Model credit allocations, custom speeds, and feature flags were siloed. With USS, credit status and settings (`uss-tabPreferences`) sync in real-time.
3. **Single Local Daemon:** Under the hood, all surfaces now communicate with a single local Language Server / agent host (`agy --hub`) pointing to `--app_data_dir=antigravity`.

### Are AI Chats and Sessions Synced Too?
* **Yes!** All conversation history is stored locally in `~/.gemini/antigravity/conversation_summaries.db` (and `~/.gemini/antigravity/conversations/`).
* Both Antigravity 2.0 and Antigravity IDE share access to these conversation threads and brain artifacts.
* **The only difference:**
  * **In the IDE:** The sidebar filters conversations to show those belonging to the currently open workspace folder.
  * **In Antigravity 2.0:** Conversations are listed globally across all projects.
* **Scope:** All synchronization is **local** to your machine (it does not leak to personal cloud sync across different machines unless explicitly using Google Cloud Code Assist workspace sync).

---

## 🚀 Features

* **Visual Status Bar Item:** Always visible in Antigravity IDE's bottom bar:
  `$(account) Antigravity: [Primary] ▾`
* **1-Click QuickPick Menu:** Click to toggle between saved accounts with instant reload.
* **Unified Master Controller:** Switching an account in the IDE automatically updates Antigravity 2.0 and the terminal CLI (`agy`).
* **Profile Vault:** Saves sessions cleanly in `~/.gemini/antigravity_profiles.json`.
* **Zero Dependencies:** Pure lightweight Node.js + Python standard library.

---

## 🛠️ Usage

### From Antigravity IDE (Visual UI)
1. Look at the bottom-right status bar in Antigravity IDE:
   Click **`Antigravity: [Profile Name]`**.
2. **To Save an Account:**
   * Log into your desired Google account.
   * Click the status bar → **`Save Current Session as Profile...`** → Enter name (e.g. `Personal` or `Work`).
3. **To Switch Accounts:**
   * Click the status bar → Select the target profile.
   * Click **`Reload Now`** to instantly apply the new session.
4. **To Add a Second Account:**
   * Click the status bar → **`Sign In to New Google Account...`**.
   * Finish the browser OAuth prompt.
   * Click the status bar → **`Save Current Session as Profile...`** (e.g. `Work`).

### From the Terminal (`agy-switch` CLI)
```bash
# List all saved profiles and see which is active
agy-switch list

# Save current session
agy-switch save "Work"

# Switch active account
agy-switch load "Personal"

# View current active profile
agy-switch current

# Delete a profile
agy-switch delete "OldAccount"
```

---

## 📦 Installation

Run the installer script:
```bash
./install.sh
```
Then restart or reload Antigravity IDE (`Ctrl + Shift + P` → `Developer: Reload Window`).
