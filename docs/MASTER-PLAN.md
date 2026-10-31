# Master Development Plan — Secure, TOS-Safe Account Switcher

Status: active, 2026-10-31
Current build: `1.8.0-alpha.1` (icon + read-only keyring detection)
Next code milestone: `1.8.0` (keyring-aware switching)

## 1. Product principles

1. **One active account at a time.** The user chooses an account; the switcher
   applies it manually. It never runs two subscription accounts in parallel.
2. **No TOS workarounds.** No account multiplexing, no quota pooling, no proxy,
   no automatic failover, no auto-approval, no rate-limit bypass. Quota is shown
   read-only; the user decides when to switch.
3. **The OS keyring is the source of truth.** File tokens and the IDE database
   are mirrors. A switch is only complete when every store agrees.
4. **Security before convenience.** No token material in logs, diagnostics,
   errors, command lines or analytics. The vault is encrypted or protected by
   OS facilities; raw tokens exist only in memory and the protected vault.
5. **Fast and deterministic.** A warm switch should be under 2 seconds on
   Windows and under 1 second when only files/databases are involved. No
   process scans on the watcher; no hidden network calls.

## 2. Scope

### In scope

- Manual switching between Google accounts the user legitimately owns.
- Windows Credential Manager, WSL/Windows file tokens and IDE database identity.
- Secure profile vault, snapshot/restore, verification, rollback and diagnostics.
- Read-only quota/reset display and a clear "quota exhausted" warning.
- A fast dashboard/status bar for profiles, conflicts and Doctor results.
- Distribution, CI, regression tests and Windows/WSL reliability.

### Explicit non-goals

- Running three accounts simultaneously.
- Per-instance isolation, `--user-data-dir` launchers or keyring bypass.
- Quota pooling, automatic rotation, failover or "unlimited quota" behavior.
- Proxy/gateway interception of model traffic.
- Auto-approving agent permissions or "turbo mode" injection.
- Modifying Antigravity binaries or bypassing its authentication UI.
- Using an account the user does not own or control.

## 3. Architecture

### 3.1 Auth stores

| Store | Location | Role |
|---|---|---|
| Windows keyring | Credential Manager `gemini:antigravity` | Authoritative on Windows |
| Linux keyring | Secret Service `gemini`/`antigravity` | Authoritative on Linux |
| macOS keyring | Keychain `gemini`/`antigravity` | Authoritative on macOS |
| Standalone token | `~/.gemini/jetski-standalone-oauth-token` (WSL + Windows) | IDE/Desktop mirror |
| CLI token | `~/.gemini/antigravity-cli/antigravity-oauth-token` | CLI mirror |
| IDE database | `state.vscdb` (`antigravityAuthStatus`, onboarding identity) | UI identity |
| Desktop database | `state.vscdb` (same keys) | UI identity |

The keyring is read/written through a small provider abstraction. A switch
writes all available stores, then verifies them. If any store fails, the
transaction rolls back all stores.

### 3.2 Profile schema (v2)

```json
{
  "email": "user@example.com",
  "label": "Work",
  "account_id": "sha256...",
  "aliases": [],
  "complete": true,
  "saved_at": "2026-10-31T...",
  "fingerprints": {
    "standaloneToken": "sha256...",
    "cliToken": "sha256...",
    "keyring": "sha256..."
  },
  "tokens": { "...": "..." },
  "db_tokens_by_path": { "...": "..." },
  "keyring": {
    "provider": "windows-credential-manager",
    "target": "gemini:antigravity",
    "username": "antigravity",
    "email": "user@example.com",
    "refreshFingerprint": "sha256...",
    "raw": "{...}"
  }
}
```

`raw` is the exact JSON blob accepted by the OS keyring. It is never returned by
diagnostics or logs; only the redacted metadata is shown.

### 3.3 Switch transaction

1. Acquire the cross-process lock.
2. Validate the profile: identity, completeness, keyring presence (strict mode).
3. Back up the current files, database auth keys and keyring blob.
4. Write files and database identity in a deterministic order.
5. Write the keyring credential.
6. Re-read every store and verify email + refresh-token fingerprint.
7. On any failure, restore files, database and keyring from the backup.
8. Persist the desired state and release the lock.

The transaction is idempotent: writing the same profile twice is safe.

### 3.4 Security model

- **Vault:** Windows DPAPI (`CryptProtectData`) in 1.9.0; Linux Secret
  Service/macOS Keychain or encrypted file; until then, `0600` plus a Doctor
  warning. No plaintext tokens in logs.
- **Keyring:** OS-protected; the switcher reads/writes only the known target.
- **Diagnostics:** email, fingerprint prefix (optional), booleans and blob length
  only. No access/refresh/id token values.
- **Arguments:** keyring payloads go through stdin, never the command line.
- **Errors:** redact token-like strings; no stack traces with secrets.
- **Files:** atomic replace, `0600`, backups, no world-readable permissions.

### 3.5 Performance model

- Warm switch target: **p95 < 2.0 s** on Windows (including one keyring write
  and verification).
- File/DB-only switch: **p95 < 1.0 s**.
- Status bar refresh: < 150 ms; no keyring read on the 5-second watcher poll.
- Keyring reads cached for 30 s for diagnostics; invalidated after a switch.
- No process enumeration on switch; running surfaces are only inspected by the
  explicit Doctor.
- Independent reads (standalone token, CLI token, database) run in parallel; DB
  writes remain sequential to preserve SQLite safety.
- No network calls in the switch path.

## 4. Features

### F1 — Keyring-aware switching (1.8.0, critical)

Read, snapshot, restore, verify and delete the OS keyring credential. This is the
missing store that explains why a file/DB switch can be undone by the Windows
app or CLI. Detailed spec: [SPEC-1.8.0-KEYRING.md](SPEC-1.8.0-KEYRING.md).

Acceptance: switching changes the keyring email; a restarted Windows CLI/app
starts on the target account; all stores verify; a forced failure rolls back.

### F2 — Secure vault and token handling (1.9.0)

Encrypt the profile vault at rest with OS facilities (DPAPI/Keychain/Secret
Service), migrate the existing JSON, and keep a rollback copy. Redact all
diagnostics. Add a `vault` Doctor check for permissions and encryption status.

### F3 — Fast, verified switch (1.8.0)

Reduce the switch to the minimum writes: skip unchanged stores, use a single
keyring read/write, avoid `getRunningSurfaces`, cache profile metadata and
invalidate after the switch. Add a benchmark test with a fake keyring and a
Windows integration test with a test credential target.

### F4 — Read-only quota and reset display (1.8.1)

Show remaining quota, reset countdown and exhausted models from the official
local data/API. A quota warning is informational only; it never switches accounts
automatically. No proxy, no rotation, no failover.

### F5 — Activity Bar dashboard (1.8.1)

A sidebar view with the active account, profile list, one-click manual switch,
conflicts, Doctor summary and quota. The custom icon is already present. The
dashboard reads cached data; it does not poll the keyring every few seconds.

### F6 — Doctor and diagnostics (maintained)

Keep the read-only Doctor: running surfaces that predate the last switch,
duplicate main surfaces, store conflicts, keyring mismatch, permission warnings.
It never kills processes or changes state.

### F7 — Profiles and UX (maintained)

Canonical Gmail aliases, refresh-token fingerprints, duplicate merge, profile
self-heal, login/adopt, conflict-aware menu, backup/restore. No silent
auto-switching.

### F8 — Distribution and quality (continuous)

Ubuntu/Windows CI, fault-injection tests, performance benchmark, Open VSX,
screenshots/GIF, release notes, reproducible VSIX, prerelease tags.

## 5. Roadmap

### 1.8.0-alpha.1 — done

- Custom icon.
- Read-only keyring detection in diagnostics/Doctor.
- `keyring-mismatch` warning.
- Master plan and test coverage.

### 1.8.0 — keyring-aware switching

- Keyring provider read/write/delete/verify.
- Profile schema v2; snapshot/restore/detect/diff include the keyring.
- Atomic rollback across files + databases + keyring.
- Strict migration: profiles without keyring are blocked until re-saved.
- Windows integration test with `gemini:antigravity.test`; no real credential.
- Acceptance: F1 + F3 targets.

### 1.8.1 — quota and dashboard

- Read-only quota/reset display.
- Activity Bar dashboard and status bar improvements.
- No automatic switching.

### 1.9.0 — security and distribution

- DPAPI/Keychain/Secret Service vault encryption and migration.
- Open VSX, screenshots, docs, performance hardening.
- Expanded Windows/WSL integration tests.

### 2.0.0 — polish

- Stable API/UX, localization, import/export of encrypted profiles, release
  automation. No isolation, no quota pooling.

## 6. Acceptance criteria

- Switching accounts updates the OS keyring, all file tokens and both databases.
- `agy-switch diagnostics` reports the keyring email and `managed: true`.
- A restarted Windows CLI/app reads the target account.
- A forced keyring/files/DB failure leaves every store unchanged.
- No token values appear in logs, diagnostics, errors or command lines.
- Warm switch p95 < 2 s on Windows; file/DB-only p95 < 1 s.
- Existing 45 JS + 48 Python tests stay green; new keyring tests pass on
  Ubuntu and Windows CI.

## 7. Test strategy

- Unit: identity, canonical email, fingerprints, profile merge, conflict
  classification, redaction, keyring report parsing.
- Fake provider: snapshot/restore/detect/diff/rollback without touching a real
  credential.
- Windows integration: create/read/verify/delete `gemini:antigravity.test`;
  never the real target.
- Fault injection: fail keyring write, DB write, file write; assert rollback.
- Performance: measure the fake-provider transaction and a real Windows keyring
  round-trip; publish p50/p95.
- CI: Ubuntu + Windows, syntax, JS, Python; release workflow on tags.

## 8. Migration

Existing profiles do not contain the keyring. In strict mode they are
incomplete for switching. The user must:

1. Sign in to the account (or keep it active).
2. Run `agy-switch save` / **Snapshot Current Session**.
3. Repeat for each account.

This is a one-time migration. The active profile can be captured immediately;
others require a manual login. The CLI/extension shows the exact instruction.

## 9. Risks

- Keyring API differences across Windows/Linux/macOS.
- PowerShell startup latency; mitigate with one read/write per switch and a
  cached read for diagnostics.
- Token expiry during a switch; verify identity/fingerprint, not only presence.
- Antigravity updates can change paths/schema; Doctor and tests catch drift.
- Vault plaintext until 1.9.0; documented and warned in the Doctor.
- Strict keyring migration adds friction; documented and one-time.

## 10. Sources and evidence

- [Google Antigravity @ I/O 2026](https://antigravity.google/blog/google-io-2026)
- [Antigravity changelog](https://antigravity.google/docs/changelog)
- [Antigravity plans](https://antigravity.google/docs/plans)
- [How do --user-data-dir and --profile work?](https://discuss.ai.google.dev/t/how-do-user-data-dir-and-profile-work/137054)
- [Feature Request: Multi-Account Support](https://discuss.ai.google.dev/t/feature-request-multi-account-support-work-personal/127162)
- [Using multiple paid accounts in Antigravity IDE](https://discuss.ai.google.dev/t/using-multiple-paid-accounts-in-antigravity-ide/138027)
- [Orchestrator + agy CLI ToS answer](https://discuss.ai.google.dev/t/one-person-several-paid-google-ai-pro-accounts-may-a-local-orchestrator-use-them-with-the-official-agy-cli/185460)
- [Antigravity CLI one login per machine](https://agentsroom.dev/blog/multiple-accounts-antigravity-cli)
