# Changelog

All notable changes to Antigravity Account Switcher are documented here.
The project follows a pragmatic semantic versioning scheme: patch releases harden
switching and identity handling, minor releases add workflows or storage formats.

## 1.8.0-alpha.1 — 2026-10-31

### Added

- Custom 128×128 extension icon (`assets/icon.png`), declared through the
  `icon` field in `package.json` and included in the VSIX.
- **Read-only keyring detection:** `agy-switch diagnostics` and the Doctor now
  read the Windows Credential Manager entry `gemini:antigravity` (service
  `gemini`, account `antigravity`) and report email, token-presence booleans and
  blob length. Token values are never printed.
- Doctor warning `keyring-mismatch` when the keyring email differs from the
  active file/database account.
- [docs/MASTER-PLAN.md](docs/MASTER-PLAN.md): isolation verdict, evidence,
  keyring architecture and the 1.8/1.9 roadmap.

### Changed

- `install.sh` copies `assets/`, `README.md` and `CHANGELOG.md` into directory
  installs, matching the VSIX contents.
- README shows the icon and documents the keyring limitation.

### Known limitation

- This alpha **detects** the keyring but does **not write** it yet. A switch can
  still leave the Windows CLI/app on the old keyring account. Keyring
  snapshot/restore/verify is the next 1.8.0 milestone.

### Tests

- 45 JavaScript tests and 48 Python tests passing.

## 1.7.4 — 2026-10-31

### Added

- **Reliability Doctor:** `agy-switch doctor` and `agy-switch doctor --json`, plus
  the **Antigravity: Run Account Switcher Doctor** command and menu item.
- Detects main Antigravity surfaces (`desktop-wsl`, `ide-wsl`, `desktop-win`,
  `ide-win`, `agent-hub`, `cli`), their PIDs and start times, and marks surfaces
  whose main process started **before the last successful switch**.
- Reports duplicate main surfaces, store conflicts, group/other-readable WSL
  token/vault files, and includes the report in diagnostics.
- GitHub Actions **CI** on Ubuntu and Windows, and a **Release** workflow that
  packages the VSIX and publishes a GitHub release on `v*` tags.
- Specification: [docs/SPEC-1.7.4.md](docs/SPEC-1.7.4.md).

### Fixed

- Doctor ignores Windows `--type=` helpers and WSL `bootstrap-fork`,
  extension-host, file-watcher and pty processes, so it reports only real
  surfaces.
- Duplicate warnings are limited to the main surfaces; multiple agent hubs or CLI
  sessions are not treated as duplicate instances.
- Tests are Windows-compatible: chmod-dependent rollback and mode assertions are
  skipped where Windows semantics differ.

### Tests

- 43 JavaScript tests and 46 Python tests at release.

## 1.7.3 — 2026-10-31

### Added

- **`agy-switch adopt <email|label>`** and the **Use newest login** menu action:
  apply the newest token for an account to all four token files and both
  `state.vscdb` databases, then save/refresh the profile.
- **`switchToLoginSession` / `adopt_login_session`**: the sign-in flow now performs
  a full switch instead of blocking because other stores still hold the old
  account. The user confirms with **Switch All & Reload**.
- **Profile identity model**: `account_id`, per-category refresh-token
  fingerprints, canonical Gmail comparison (`user+tag@`, dots) and `aliases`.
  Profiles sharing a canonical email or fingerprint are merged automatically.
- **Conflict UX**: **Reapply target profile** menu item; save/register errors are
  modal and list the divergent store (for example
  `IDE/Desktop token (WSL)=soilet@example.com`).
- **Profile self-heal**: a successful switch refreshes the profile's
  `fingerprints`, `account_id`, `db_tokens_by_path` and `complete` flags, so
  legacy profiles repair themselves the first time they are applied.
- Unique labels: a duplicate label is auto-suffixed (`Work 2`).
- Tests for canonical email, fingerprint merging, duplicate labels, manual-email
  evidence, database identity mismatch, empty databases, divergent databases,
  fresh-login adoption and profile self-heal.

### Fixed

- A database with `antigravityAuthStatus.email` different from
  `lastLoginUsername` / `jetski.onboarding.lastLoginUsername` is now reported as
  `database-identity-mismatch`; saving and switching are blocked until repaired.
- A sign-in to a new account no longer fails with
  “The Antigravity stores disagree…”. The login is treated as a deliberate
  account change and written to every store after confirmation.
- Manual registration can no longer invent an email when the token or database
  already identifies another account.
- Profiles are no longer duplicated for Gmail aliases or the same refresh token.
- The status bar no longer treats a database identity alone as a signed-in
  session; a real token file or legacy `antigravityUnifiedStateSync.oauthToken`
  is required.
- Incremental token refreshes with the same email are ignored; only a different
  email or a deleted store produces a conflict.
- A table-less/empty `state.vscdb` is skipped instead of aborting the switch.
- Restoring a profile no longer deletes database auth keys that the profile does
  not contain.
- Version, README, installer and CLI are aligned on 1.7.3.

### Changed

- `restoreProfile` verifies every store and refreshes the matching profile
  metadata after a successful switch.
- The CLI `current --json` reports `is_active` from the real session state;
  `list` marks incomplete/legacy profiles; `load` refuses `complete: false`
  profiles.
- `AGY_SWITCH_PREFERRED_STORE=cliToken` (or `standaloneToken`) selects the
  preferred surface for the CLI.

### Security

- Refresh-token fingerprints are SHA-256 hashes; raw tokens are never written to
  the vault metadata or diagnostics.
- The vault and token files remain `0600` with atomic writes, `.bak` backups and
  corrupt-vault preservation.

## 1.7.2 — 2026-10-30

### Added

- Per-store detection with explicit conflicts (`multiple-emails`,
  `target-mismatch`, `database-identity-mismatch`).
- Cross-process switch lock and `antigravity_switch_state.json` expected hashes.
- Atomic switch with capture, verification and rollback; database keys absent
  from the profile are preserved.
- 5-second polling for `/mnt/c` (WSL) and suppression of self-writes.
- CLI `reset --yes`, per-database diagnostics and `preferredStore` /
  `pollIntervalMs` settings.
- VSIX 1.7.2 and 28 JS + 26 Python tests at release.

### Fixed

- Account oscillation when IDE, Desktop 2.0 and CLI were open on different
  accounts.
- Status bar flipping between accounts; same-email hourly refreshes are ignored.
- Partial database writes aborting a switch without updating token files.
- Stale profile metadata (fingerprints/DB paths) when switching.
- Empty/table-less databases blocking all switches.

## 1.7.1 — 2026-10-29

### Changed

- Prefer the IDE/Desktop `standaloneToken` over the CLI token when both exist.
- Snapshot drops token files that belong to another account and synthesizes the
  missing token category.
- Tests for standalone precedence and cross-account token filtering.

## 1.7.0 — 2026-10-29

### Added

- Unified OAuth vault format shared by the extension and the CLI.
- Atomic vault/token writes with `0600`, `.bak` and corrupt-vault preservation.
- Login flow that waits for the new token and offers save + reload.
- Diagnostics command and output channel.
- Dynamic Windows/WSL/macOS path discovery; installer rewrite with `--dry-run`.

### Changed

- Token snapshot/restore is per category; legacy snake_case profiles migrate.
- Stale database auth keys are cleared inside a transaction with a busy timeout.

## 1.6.0 — 2026-10-28

- Strict active-session gating to prevent stale email ghosting.
- `clear` command and clean logout stripping.
- README overhaul and installer hardening.

## 1.5.0 — 2026-10-28

- Packaged VSIX, multi-target installer and MIT license.
- Support for both `server` and `ide-server` extension directories.

## 1.4.0 — 2026-10-28

- Dual-host WSL/UI support (`extensionKind: ["workspace", "ui"]`).
- Multi-database token aggregation and profile recovery.
- Google OAuth completion detection and auto-reload.

## 1.3.0 — 2026-10-28

- Email-keyed account profiles, zero-duplication selector UI and strict matching.

## 1.2.0 — 2026-10-28

- Native Node.js SQLite integration, immediate activation on startup and
  cross-platform profile sync.

## 1.0.0 — 2026-10-28

- Initial Antigravity Account Switcher extension and `agy-switch` CLI.
