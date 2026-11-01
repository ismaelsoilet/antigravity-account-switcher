# SPEC 1.8.7 — Keyring policy, completeness and strict verification

## Problem

The 1.8.6 Add account flow detected a successful Google login and then threw
before writing anything:

```
Profile incomplete: sign in to <email>, then run agy-switch save to capture the Windows keyring.
```

Root cause: `restoreProfile` treated `getKeyringProvider().available` as a
requirement for a credential. On WSL the Windows Credential Manager provider is
reachable, but Antigravity uses **file-based token storage** and never creates
`gemini:antigravity`. Every switch therefore aborted after sign-out, then
rolled back. `buildLoginProfile` and `snapshotActiveAccount` also marked
token-only WSL profiles `complete:false`, which blocked later switches.

A second defect made verification too optimistic: `verifyRestore` counted an
empty database identity as a match, so a switch could be reported successful
while a Windows `state.vscdb` had no account identity.

## Architecture

### 1. Three independent keyring concepts

| Concept | Meaning |
|---|---|
| Provider usable | The host can reach a credential store (Windows Credential Manager via PowerShell on WSL, Keychain, Secret Service). |
| Credential present | `gemini:antigravity` actually exists and is readable. |
| Policy | Whether the credential is **required** for this runtime. |

Policy values:

* `managed` — native Windows. Keyring is required for Windows surfaces.
* `optional` — WSL/Linux file-storage hosts. The keyring is an optional mirror;
  file tokens and DB identity are authoritative.
* `unsupported` — no provider. Never a failure.

`restoreProfile` has **no throw path for a missing keyring**. It writes and
verifies a keyring only when the profile carries one; otherwise it records a
warning and continues with files/DBs. A failed write or verification of a
keyring the profile actually carries still aborts and rolls back.

Diagnostics expose all three axes:

```
keyring.available          // credential present (backwards compatible)
keyring.providerAvailable
keyring.credentialPresent
keyring.policy             // managed | optional | unsupported
keyring.required
keyringPolicy              // top-level diagnostics summary
```

### 2. Profile completeness

`assessProfileCompleteness()` is the single source of truth:

* `tokenOk` — at least one usable token file.
* `dbOk` — a DB identity is claimed, no DB exists, or the host is WSL
  (`policy.wsl`), where DBs are optional Windows mirrors.
* `keyringOk` — no keyring required, or a keyring is present.

Existing profiles stored as `complete:false` are upgraded on load when the
derived assessment is complete. A stored `true` is never downgraded. Profiles
carry `completeness.reasons` for UI/diagnostics.

### 3. Verification

Database verification is claim-aware:

| DB identity | Claimed by profile | Result |
|---|---|---|
| empty | yes | **fail** (`empty-identity`) |
| empty | no | pass |
| one email | any | must equal target |
| multiple emails | any | fail |
| matching email but no `antigravityAuthStatus` | yes | fail |

A DB is claimed when `db_tokens_by_path` contains its path, or when a merged
`db_tokens` map is used for all current DBs. A DB without `ItemTable` remains
skipped rather than aborting, preserving the existing compatibility behavior.
Keyring verification runs only when a keyring record was written.

### 4. Snapshot and login profile

`snapshotActiveAccount` now includes empty-identity DBs, patches the active
identity into them, and records them in `db_tokens_by_path`. DBs holding a
different account are still excluded and reported. `buildLoginProfile` writes
the identity to every readable DB, so a fresh WSL login fills the empty Windows
DBs instead of leaving them anonymous.

### 5. Add account transaction

The 1.8.6 flow remains:

1. save/refresh the current profile;
2. capture files, DBs and keyring;
3. sign out and clear session stores;
4. open Google sign-in;
5. detect one fresh file token;
6. apply with `switchToLoginSession`;
7. reload, or restore the capture on cancel/failure.

With keyring policy in place, step 6 no longer fails on WSL. The DBs are now
positively verified instead of silently passing empty.

### 6. Recovery and backups

`saveProfiles({})` no longer overwrites a non-empty `.bak` with an empty vault.
This preserves the only surviving profile when the user uses Clear All.

The current machine was signed out and its live vault emptied before this fix.
Safe recovery (explicit, never automatic):

```bash
# copy one of the preserved profiles into the live vault
cp ~/.gemini/antigravity_profiles.json.bak ~/.gemini/antigravity_profiles.json
chmod 600 ~/.gemini/antigravity_profiles.json

# after 1.8.7 is installed, apply the profile (no keyring required on WSL)
agy-switch load soilet.ismael@gmail.com
```

Alternatively, use **Add account** and sign in again. A manual recovery command
and a crash-safe pending-capture journal are deferred to 1.9.x.

## Invariants

1. No switch throws solely because the host has no keyring credential.
2. A profile carrying a keyring must write and verify it, or roll back.
3. Empty claimed DB identity never verifies as success.
4. A token-only WSL profile is complete for WSL/CLI surfaces.
5. Existing `complete:false` profiles are repaired on load, never silently
   downgraded.
6. A missing keyring may leave Windows surfaces needing one live sign-in; it is
   reported, not disguised as success.
7. No token/keyring material is added to diagnostics or errors.

## Deferred to 1.9.x

* On-disk pending-login journal and automatic crash recovery.
* `agy-switch recover` / **Recover Previous Session** UI.
* Deferred/staged DB writes over 9p and a DB lock preflight.
* Synthesising a Windows keyring from a WSL file token.
* Full surface manifest with per-profile `verified_surfaces`.
* DPAPI/Keychain encrypted vault and Open VSX.

## Test coverage

JavaScript:

* provider available + credential missing + profile without keyring restores;
* token-only WSL profile is complete;
* legacy `complete:false` repaired on load;
* empty claimed DB fails verification; empty unclaimed DB passes;
* `buildLoginProfile` writes identity to an empty DB;
* `snapshotActiveAccount` completes empty DBs and excludes foreign ones;
* empty-vault saves do not clobber a non-empty `.bak`;
* dashboard renders “keyring optional” without disabling the switch.

Python mirrors the same behavioral tests. The Add account harness runs success
and rollback under the WSL-like provider (available + credential null).

Current result: 64 JavaScript tests, 62 Python tests, 1 opt-in real-keyring test
skipped; Add account harness green.
