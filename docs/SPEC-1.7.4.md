# SPEC 1.7.4 — Reliability Doctor, CI and Release Automation

Status: implemented
Owner: Antigravity Account Switcher maintainers
Scope: reliability hardening only; no new account source of truth

## 1. Problem

The switcher can apply an account to every token file and database, but an
Antigravity surface that was already running before the switch keeps the old
refresh token in memory. It may rewrite `jetski-standalone-oauth-token` (or the
CLI token) hours later, producing a conflict that looks like the switcher failed.
The existing conflict message says *which store* diverged, but not *which running
process* is likely responsible or whether it predates the last switch.

## 2. Goal

Give users a deterministic, local-only diagnostic that answers:

1. Which Antigravity surfaces are running?
2. When did each main process start, relative to the last switch?
3. Which surfaces predate the last switch and may overwrite the token?
4. Are there duplicate main surfaces, store conflicts, or unsafe file modes?

The Doctor must never modify tokens, databases or profiles. It is read-only.

## 3. Non-goals (deliberately out of scope for 1.7.4)

- Quota API polling and 429 failover/rotation.
- Per-instance isolation (`--user-data-dir` / separate profiles).
- OS keyring/DPAPI encryption of the vault.
- Local API gateway/proxy for Claude Code, Codex or OpenCode.
- Automatic process termination. The Doctor reports; the user decides.

These remain candidates for 1.8+.

## 4. Requirements

### R1 — Surface discovery

The Doctor discovers the **main** processes of the supported surfaces:

| Kind | Main process |
|---|---|
| `desktop-wsl` | `language_server --standalone --app_data_dir antigravity` |
| `ide-wsl` | `antigravity-ide-server ... out/server-main.js --start-server` |
| `desktop-win` | `Antigravity.exe` (no `--type=` helper flag) |
| `ide-win` | `Antigravity IDE.exe` (no `--type=` helper flag) |
| `agent-hub` | `.gemini/bin/agy --hub ...` |
| `cli` | `.gemini/bin/agy` (no `--hub`) |

Helpers MUST be ignored: Windows `--type=renderer|gpu-process|utility|nodeService`,
and WSL `bootstrap-fork`, `--type=extensionHost|fileWatcher|ptyHost`.

Discovery sources:

- Linux/WSL: `/proc/<pid>/cmdline`, `/proc/<pid>/stat` start time, `/proc/stat`
  `btime`, `getconf CLK_TCK` (fallback 100).
- Windows and WSL: `powershell.exe Get-CimInstance Win32_Process` filtered to
  `Antigravity.exe` / `Antigravity IDE.exe`; parse `ProcessId`, `CreationDate`,
  `CommandLine`.
- macOS: `ps -axo pid=,lstart=,command=`.

Results are cached for 30 seconds. The Doctor only runs on explicit command,
diagnostics, or a switch preflight — never on the 5-second watcher poll.

### R2 — Staleness

A surface is `stale` when its `startedAt` is earlier than the `switchState.appliedAt`
of the last successful switch. If no switch state exists, staleness is not claimed.
A stale surface is a `warning`; it becomes an `error` when the current session also
reports a store conflict, because it is the likely writer.

### R3 — Duplicates

Only main surfaces count as duplicates (`desktop-wsl`, `ide-wsl`, `desktop-win`,
`ide-win`). Multiple `agent-hub` or `cli` processes are normal and MUST NOT create
a duplicate warning.

### R4 — Permissions

On POSIX (not Windows), the Doctor checks the vault and token files. A file with
group/other bits set produces a warning; paths under `/mnt/c` are skipped because
Windows ACLs, not chmod, apply there. Expected mode is `0600`.

### R5 — Store conflicts

The Doctor reuses the existing per-store detection and reports
`multiple-emails`, `target-mismatch` and `database-identity-mismatch` as `error`
warnings.

### R6 — CLI contract

```text
agy-switch doctor            # human-readable report
agy-switch doctor --json     # machine-readable report
```

Exit code: `0` when there are no `error` warnings, `1` otherwise. The JSON report
contains `ok`, `activeSession`, `switchState`, `surfaces` (with `stale` flags),
`permissions`, and `warnings`.

### R7 — Extension contract

- Command **Antigravity: Run Account Switcher Doctor**.
- Menu item **Run Doctor (surfaces, conflicts, permissions)**.
- Result is written as JSON to the **Antigravity Account Switcher** output channel.
- A message reports the number of blocking issues and warnings.
- `Show Diagnostics` includes the `doctor` field.

### R8 — Diagnostics

`agy-switch diagnostics --json` and the extension diagnostics include the Doctor
report under `doctor`, without changing existing fields.

## 5. Acceptance criteria

1. `agy-switch doctor` lists only main surfaces on a machine with an IDE open
   (no `--type=`/`bootstrap-fork` helpers).
2. A main process started before the last switch is marked
   `[STARTED BEFORE LAST SWITCH]`.
3. A store conflict plus a stale surface makes `ok=false` and exits `1`.
4. Duplicate `agent-hub`/`cli` processes do not produce duplicate warnings.
5. A `0644` WSL token produces a permission warning; `0600` does not.
6. The Doctor does not write any token, database, profile or switch state.
7. Existing tests and the new Doctor tests pass on Linux; JS/Python tests pass on
   Windows CI with the documented chmod/mode skips.

## 6. Test matrix

| Unit | Check |
|---|---|
| Classification | all six kinds; helpers ignored; unrelated command → null |
| Staleness | before/after `appliedAt`; no `appliedAt` → not stale |
| Duplicates | main duplicates reported; hub/CLI duplicates ignored |
| Doctor report | stale + conflict → `ok=false`, both warning codes |
| Permissions | `0644` warning, `0600` clean, `/mnt/c` skipped, Windows skipped |
| Read-only | Doctor calls do not change file hashes or switch state |
| CI | Ubuntu + Windows: syntax, JS tests, Python tests |
| Release | tag `v*` builds VSIX and creates a GitHub release |

## 7. Risks and limits

- Process start times from `/proc/<pid>/stat` are boot-time + ticks; a clock change
  can shift them slightly. This is a diagnostic hint, not a security boundary.
- The Windows query depends on PowerShell/CIM availability. Failure returns an
  empty list; the Doctor still works with the remaining sources.
- A stale surface is not proof that it will overwrite the token; it is the most
  likely writer. The Doctor reports, the user restarts/closes it.
- The Doctor does not kill processes. That remains an explicit user action.

## 8. Future work

- Quota/reset display and opt-in 429 failover.
- Per-instance isolation for simultaneous accounts.
- Optional OS keyring encryption.
- Usage/cost dashboard.
