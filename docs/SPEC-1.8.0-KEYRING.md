# SPEC 1.8.0 — Keyring-Aware Manual Switching

Status: ready to implement
Depends on: 1.8.0-alpha.1 read-only keyring detection
Scope: one manually selected account at a time; no parallel accounts, no quota
pooling, no automatic switching

## 1. Problem

A switch currently writes:

- the WSL and Windows standalone OAuth token files;
- the WSL and Windows CLI token files;
- the identity keys in both Antigravity `state.vscdb` databases.

It does **not** write the OS keyring entry `gemini:antigravity`. The Windows
Credential Manager entry contains a live `refresh_token` and `id_token_email`.
The Windows app/CLI reads that entry, so a file/DB switch can be silently undone
when the app refreshes the old account and rewrites the mirrors. The keyring is
the missing source of truth.

## 2. Goals

1. Read, snapshot, restore, verify and delete the OS keyring credential.
2. Include the keyring in profile completeness, conflict detection, switch
   state, verification and rollback.
3. Keep the switch manual and deterministic: no automatic account changes, no
   quota-based rotation, no multi-account parallelism.
4. Keep the switch fast: one keyring read/write per switch; no process scans.
5. Never expose token material in logs, diagnostics, errors or argv.

## 3. Non-goals

- Running two accounts at the same time.
- Isolating Antigravity instances with `--user-data-dir` or environment hacks.
- Bypassing the keyring with `SSH_CONNECTION` or `--password-store`.
- Quota pooling, failover, proxy or rate-limit bypass.
- Auto-approving agent permissions.
- Writing a credential the user does not own.

## 4. Provider interface

```ts
interface KeyringProvider {
  id: "windows-credential-manager" | "secret-service" | "macos-keychain";
  available(): boolean;
  read(target): KeyringRecord | null;
  write(record): void;
  delete(target): void;
}
```

### 4.1 KeyringRecord

```json
{
  "provider": "windows-credential-manager",
  "target": "gemini:antigravity",
  "username": "antigravity",
  "email": "user@example.com",
  "hasRefreshToken": true,
  "refreshFingerprint": "sha256...",
  "raw": "{...}"
}
```

`raw` is the exact credential blob (JSON) and is only used by snapshot/restore.
It is never returned by diagnostics, logs or error messages.

### 4.2 Windows provider

- Target: `gemini:antigravity` (generic credential, type 1).
- Username: `antigravity`.
- Persist: preserve the value read from the existing credential; default
  `CRED_PERSIST_LOCAL_MACHINE` (2) when creating.
- Read: `CredReadW`; return `CredentialBlob` decoded as UTF-8 JSON.
- Write: `CredWriteW` with the UTF-8 JSON blob, same target/username/persist.
- Delete: `CredDeleteW`.
- Transport: PowerShell P/Invoke. The payload is passed via **stdin**, never the
  command line. A fixed script is used; the payload is base64-decoded inside
  PowerShell.
- Verification: read back; compare `id_token_email` and refresh-token
  fingerprint; compare blob length only as a sanity check.
- Failure: any PowerShell error, non-zero exit, missing email or fingerprint is
  a hard failure and triggers rollback.

### 4.3 Linux provider

- Secret Service entry: service `gemini`, account `antigravity`.
- Read/write through `secret-tool` when available:
  `secret-tool lookup service gemini account antigravity` and
  `secret-tool store --label="Antigravity" service gemini account antigravity`.
- If Secret Service is unavailable (common in WSL), report
  `available: false, reason: "secret-service-unavailable"` and rely on file
  tokens. Do not fake a keyring write.
- Never use a DBus proxy.

### 4.4 macOS provider

- Keychain generic password, service `gemini`, account `antigravity`.
- `security find-generic-password -s gemini -a antigravity -w` and
  `security add-generic-password -U -s gemini -a antigravity -w <secret>`.
- Payload via stdin where possible; otherwise a temporary file with `0600` and
  immediate deletion.

## 5. Identity and fingerprints

- Email: `id_token_email` in the keyring JSON; fall back to the JWT `email`
  claim only if `id_token_email` is absent.
- Refresh fingerprint: `sha256(refresh_token)`; never store the token itself in
  logs.
- Account id: `sha256(refresh_token + email)` or the existing `account_id`
  algorithm; the same account must merge by canonical email or fingerprint.
- `canonicalEmail` applies (Gmail aliases/dots).
- Profile completeness in strict mode requires:
  - canonical email;
  - file token fingerprint;
  - database identity (when the database exists);
  - keyring record with matching email and a refresh fingerprint (when the
    provider is available).

## 6. Data model changes

- `profiles[email].keyring`: KeyringRecord (including `raw`).
- `profiles[email].fingerprints.keyring`: refresh fingerprint.
- `profiles[email].complete`: false if strict keyring is missing.
- `switchState.keyring`: `{ provider, target, email, refreshFingerprint }`.
- `switchState.verification.keyring`: `{ matches, email }`.
- `diagnostics.keyring`: redacted metadata only (`managed` becomes true after
  1.8.0).
- `doctor.keyring`: redacted metadata + mismatch warning.
- `stores`: add `{ category: "keyring", home: "win" | "linux" | "mac",
  path: "keyring://gemini:antigravity", email, identityEmails }`.
- `storeDiff`: add keyring refresh/conflict/missing classes.

## 7. Switch transaction

```text
lock()
profile = loadProfile(target)
validate(profile)                    // identity, completeness, keyring strict
backup = backupAllStores()           // files, DB auth keys, keyring raw
try:
  writeFiles(profile)
  writeDatabases(profile)
  writeKeyring(profile.keyring)
  verifyFiles(profile)
  verifyDatabases(profile)
  verifyKeyring(profile)
  writeSwitchState(profile, verification)
except:
  restoreFiles(backup)
  restoreDatabases(backup)
  restoreKeyring(backup.keyring)
  throw SwitchError(details)
finally:
  unlock()
```

Ordering rationale: files/DB first (cheap, recoverable), keyring last (the
authoritative store). If the keyring write fails, the mirrors are rolled back so
the old keyring remains consistent with them.

Rollback rules:

- File backup: original bytes + mode.
- DB backup: original auth keys (not the whole database) + item table
  availability.
- Keyring backup: original raw blob or "absent".
- Rollback failures are reported explicitly; the switch is never marked
  successful.
- The lock is always released.

## 8. Detection and diagnostics

`detectSessions` includes the keyring when the provider is available:

- `stores` includes the keyring with `email`.
- `conflicts` includes `keyring-mismatch` when the keyring email differs from
  the preferred file/DB account.
- `getDiagnostics` returns redacted keyring metadata and `managed: true`.
- `getDoctorReport` warns on mismatch and on profiles missing keyring in strict
  mode. It does not print tokens.

## 9. Strict migration

Profiles saved by 1.7.x do not have a keyring. To avoid a silent half-switch:

- If the keyring provider is available and the profile lacks a keyring, the
  switch is blocked with:
  `Profile incomplete: sign in to <email>, then run agy-switch save to capture
  the Windows keyring.`
- The active profile can be captured immediately with `agy-switch save`.
- Other profiles require a one-time manual login + save.
- A `--lenient-keyring` flag may be offered for diagnostics only; it must warn
  loudly and never claim a complete switch. Default is strict.

## 10. CLI and extension UX

- `agy-switch save` captures the keyring when the active session matches.
- `agy-switch load <email>` writes it and verifies it.
- `agy-switch diagnostics` shows:
  `Keyring: gemini:antigravity -> user@example.com (managed)`.
- `agy-switch doctor` shows keyring status and profile completeness.
- Extension: the switch success message mentions the keyring when written; the
  error modal shows which store failed; the Doctor/menu show keyring mismatch.
- No automatic switch on quota, timer or file change.

## 11. Security requirements

- Raw keyring/token values never appear in:
  - logs, output channels, diagnostics, Doctor, errors, telemetry;
  - process argv;
  - test snapshots or fixtures.
- Keyring payloads are passed via stdin; the fixed PowerShell script contains no
  user data.
- Vault is `0600`; on Windows, the plan for 1.9.0 is DPAPI encryption. Until
  then, the Doctor warns if the vault is group/other-readable.
- The keyring target is a constant; reject any other target from profile data.
- Validate the decoded JSON: object, `id_token_email` string, `refresh_token`
  string; reject oversized blobs (> 64 KiB) and unknown schemas.

## 12. Performance requirements

- One keyring read before the switch, one write, one verification read.
- No `getRunningSurfaces` or process enumeration in the switch path.
- Warm switch p95 < 2.0 s on Windows; file/DB-only p95 < 1.0 s.
- Keyring diagnostics reads cached for 30 s; invalidated after a switch.
- Keyring PowerShell round-trip measured and reported in tests; if it exceeds
  1.5 s, document it and consider a native helper in 1.9.0.
- Status bar refresh does not read the keyring.

## 13. Test matrix

| Test | Assertion |
|---|---|
| Fake provider read/write/delete | round-trip email, refresh fingerprint, raw blob |
| Snapshot | profile includes keyring; diagnostics redacted |
| Restore | files + DB + keyring all updated; verification true |
| Keyring mismatch | conflict/Doctor warning; no silent switch |
| Missing keyring profile | strict switch blocked with actionable message |
| Keyring write failure | files/DB rolled back; old keyring intact |
| DB write failure | keyring not changed; files rolled back |
| File write failure | keyring not changed; old files intact |
| Redaction | no `refresh_token`/`access_token` in any report |
| Windows integration | read/write/verify/delete `gemini:antigravity.test` |
| Performance | warm fake switch p95 < 1.0 s; Windows keyring round-trip logged |
| CI | Ubuntu + Windows, fake provider; no real credential |

The Windows integration test must never touch `gemini:antigravity`; it creates
`gemini:antigravity.test` and deletes it in `finally`.

## 14. Acceptance criteria

1. A switch to a complete profile changes the keyring email to the target.
2. `agy-switch diagnostics` shows the target keyring email and `managed: true`.
3. A restarted Windows CLI/app starts on the target account.
4. A forced keyring write failure leaves files, DB and keyring unchanged.
5. No token material appears in logs, diagnostics, errors or argv.
6. Warm switch p95 < 2 s on Windows; file/DB-only p95 < 1 s.
7. Profiles without keyring are blocked in strict mode with a clear migration
   instruction.
8. Existing tests stay green; new keyring tests pass on Ubuntu and Windows CI.

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| PowerShell latency | one read/write per switch; cache diagnostics; measure |
| Credential Manager API differences | fixed P/Invoke script; Windows CI test target |
| Token expires between snapshot and switch | verify email/fingerprint; surface auth error |
| Antigravity changes the blob schema | validate schema; Doctor detects; keep raw fallback |
| Vault plaintext until 1.9.0 | 0600, Doctor warning, DPAPI in 1.9.0 |
| Strict migration friction | one-time message with exact command; capture active profile now |
| Multiple Windows users | keyring is per-user; the CLI runs as the same user |
| WSL/Windows split | keyring provider calls `powershell.exe`; file stores remain separate |
