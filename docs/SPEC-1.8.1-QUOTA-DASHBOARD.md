# SPEC 1.8.1 — Read-Only Quota and Activity Bar Dashboard

Status: implemented in 1.8.1
Scope: manual switching only; no quotas are pooled or rotated automatically

## 1. Goal

Give the user a fast, trustworthy view of the active account, saved profiles,
keyring status and current quota without introducing any account automation.

## 2. Official quota source

- Primary source: `agy --print /usage --output-format json`.
- The JSON contains `command.data.groups[].buckets[]` with
  `remaining_fraction`, `reset_time`, `name` and `window`.
- The command is read-only and reports `num_turns: 0` / no token usage in the
  observed response.
- The quota is displayed as weekly and 5-hour buckets per group (Gemini and
  Claude/GPT). No model request is made by the extension.

## 3. Local fallback

If the CLI is unavailable or unauthenticated:

- Read `quota*.json` / `usage*.json` from known `.gemini` directories
  (`antigravity`, `antigravity-cli`, `antigravity-ide`, `cache`).
- Read recent (24h) CLI/language-server logs for quota JSON or text lines.
- If neither exists, report `available: false` and link the user to
  **Antigravity Settings > View Usage**.

Accepted quota shapes:

```json
{
  "models": [
    {
      "label": "Gemini 3.5 Pro",
      "remainingPercentage": 72,
      "resetTime": "2026-10-31T23:00:00Z",
      "isExhausted": false
    }
  ]
}
```

`remainingPercentage` can be 0–1 or 0–100; it is normalized to a percentage.
`timeUntilResetMs` is converted to an absolute reset time.

## 4. 429 / rate-limit signals

Recent local logs are scanned (bounded tail, 24h) for:

- HTTP `429`
- `RESOURCE_EXHAUSTED`
- `quota exhausted`
- `rate limit`

A signal is shown as **informational only**. The switcher never changes accounts,
never rotates on 429, never pools quotas and never proxies traffic.

## 5. Activity Bar dashboard

View container: **Antigravity Accounts** (`antigravityAccountSwitcher`).
View: **Accounts** (`antigravityAccountSwitcher.dashboard`).

Root items:

- Active account + label/conflict count.
- Keyring status (managed / not found / unavailable).
- Profiles group; each profile shows active/migration state and switches only
  after the existing confirmation dialog.
- Quota group; live/cached models with remaining % and reset countdown.
- Recent 429 signal (if present).
- Doctor and Diagnostics shortcuts.

View-title commands: refresh (force live quota), show quota, Doctor.

The dashboard reads live quota only when opened/refreshed, not on the 5-second
token watcher. Keyring and quota results are cached.

## 6. CLI

```text
agy-switch quota            # official /usage + local 429 signals
agy-switch quota --json
agy-switch quota --local    # skip the CLI call
```

Exit code is 0 for both available and unavailable quota; unavailable is a
report, not an error.

## 7. TOS guardrails

- No automatic switching.
- No quota pooling, rotation, failover or proxy.
- No multi-account isolation.
- No auto-approval of agent permissions.
- The quota display is informational and uses the official local CLI command.

## 8. Acceptance criteria

1. `agy-switch quota` returns weekly and 5-hour buckets from the official CLI.
2. The Activity Bar view shows active account, keyring, profiles and quota.
3. Clicking a profile still requires the manual switch confirmation.
4. A recent 429 log produces an informational warning only.
5. No token values are printed by quota/dashboard.
6. The 5-second watcher does not run `/usage` or keyring reads.
7. Tests cover parsing, local cache, 429 detection and Doctor warnings.

## 9. Tests

- `parseUsageOutput` JSON + text.
- `getQuotaReport` live payload and local cache.
- 429 log signal detection and redaction.
- Doctor `quota-rate-limit` / `quota-exhausted` warnings.
- Extension smoke test with a fake `vscode` host (tree items and commands).
- CI Ubuntu + Windows.

## 10. Non-goals

- Automatic switching on quota exhaustion.
- Quota-aware load balancing or account rotation.
- Network scraping outside the official CLI.
- Running multiple accounts at once.
