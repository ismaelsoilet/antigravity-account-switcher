# Master Development Plan — Antigravity Account Switcher

Status: proposed, started 2026-10-31
Current release: 1.8.0-alpha.1 (icon + read-only keyring detection; keyring write is next)

## TL;DR

1. **Per-instance isolation is not worth building as a core feature.** Google is
   unifying the Antigravity *surfaces* (IDE, 2.0 app, CLI, SDK), not the *account
   model*. Native multi-account is still a requested feature. `--user-data-dir`
   isolates workspace/window state, but authentication remains machine-wide in
   the OS keyring (`gemini:antigravity`) and `~/.gemini`. Full isolation requires
   environment/keyring hacks; Google staff explicitly said that orchestrating
   several AI Pro accounts through the official CLI violates the Terms of
   Service. The safe path for parallel work is Gemini API keys/Vertex AI, not
   account multiplexing.
2. **The real missing store is the OS keyring.** On this machine the Windows
   Credential Manager contains `gemini:antigravity` with a live refresh token
   and the active email. The 1.7.x switcher reads/writes file tokens and
   `state.vscdb` only. A switch can therefore leave the Windows CLI/app on the
   old account, which can rewrite the file tokens later. This is a correctness
   bug and the top priority.
3. **Next releases:**
   - `1.8.0-alpha.1` — custom icon + **keyring read-only detection** (this
     change).
   - `1.8.0` — keyring snapshot/restore/verify, first-class store, Doctor and
     rollback coverage.
   - `1.8.1` — quota/429 read-only + status bar/Activity Bar dashboard.
   - `1.9.0` — keyring encryption, Open VSX, screenshots, Windows CI hardening.
   - `2.0-lab` — optional Windows-only isolation proof of concept, feature-flagged,
     with an explicit ToS warning and a go/no-go gate.

## Evidence

### Google direction and account model

- I/O 2026 announced a **unified ecosystem** of Antigravity surfaces: 2.0 app,
  CLI, SDK, managed agents. It did **not** announce multi-account or per-instance
  account isolation.
- Official forum, Feb 2026: Antigravity supports **one active login**; a
  multi-account feature request was filed with the internal team. No delivery
  date. A follow-up in May 2026 still asked for news.
- Official forum, Apr 2026: `--user-data-dir` is for **total isolation of the
  data directory** (workspace/window state); `--profile` manages profiles inside
  one data directory. It does not isolate the OS keyring or the machine-wide
  `~/.gemini` auth.
- Official support, Oct 2026: manually switching between two independently paid
  AI Pro accounts is allowed; alternatives are credits or a larger plan.
- Official staff, Sep 2026: using an orchestrator to multiplex several AI Pro
  accounts through the official `agy` CLI **violates the Terms of Service**;
  use the Gemini Developer API or Vertex AI for high-capacity needs.
- Official changelog through 2.28.2 (Oct 29, 2026): no native multi-account or
  profile-switching feature. The roadmap is agents, plugins, browser, enterprise.

### Technical reality

- Antigravity CLI: one keyring entry per machine, service `gemini`, account
  `antigravity`; no `--profile`, `--data-dir`, or `--auth-store`. Issues asking
  for a `CLAUDE_CONFIG_DIR`/`CODEX_HOME` equivalent are open.
- Windows: `language_server.exe` uses the Credential Manager entry
  `gemini:antigravity`, and has `shouldBypassKeyring`/`SSH_CONNECTION` logic to
  fall back to file storage. `--user-data-dir` alone does not change that.
- Local confirmation (2026-10-31): `cmdkey /list` shows
  `LegacyGeneric:target=gemini:antigravity`; the credential contains
  `access_token`, `refresh_token`, `id_token_email`,
  `id_token_email=onlinedistribuidora.servicos@gmail.com` and a refresh token.
  The checker never prints token values.
- Existing isolation projects confirm the difficulty:
  - MultiGravity (Windows, 8 stars): `--user-data-dir` + `USERPROFILE` override
    + `SSH_CONNECTION` keyring bypass + NTFS junctions for shared chats.
  - Antigravity Cluster (Linux, 3 stars): bubblewrap, DBus keyring proxy,
    `xdg-open` wrapper, `language_server` wrapper rewriting `--app_data_dir`,
    migration resets and a CDP auto-approval injector. High maintenance, high
    blast radius.
- The CLI's one genuinely per-process credential is a **Gemini API key** from
  the environment; that is the supported way to run agents concurrently.

## Decision: isolation

**No-go for core per-instance isolation.** It is technically possible on
Windows with environment and keyring tricks, but it is fragile, machine-wide,
against the stated ToS when used to multiplex subscriptions, and not a durable
product moat. The ecosystem is moving toward unified surfaces, which makes
single-account assumptions stronger, not weaker.

**Conditional lab spike only (2.0-lab):** Windows-only, opt-in, no quota
pooling, no proxy, no auto-approval, explicit warning that Google may change
the behavior and that multiplexing subscriptions through the CLI is not
supported. Gate: two weeks of real use across Antigravity updates, no auth
corruption, no terms issue. Otherwise archive it.

## Decision: keyring-aware switching (1.8.0)

Make the OS keyring a first-class auth store:

- Providers:
  - Windows Credential Manager: `gemini:antigravity` (read/write/delete/verify).
  - Linux Secret Service: same service/account (read first; write behind a
    capability check).
  - macOS Keychain: future.
- Store record: provider, target, username, email, account id, refresh-token
  fingerprint, raw JSON (memory/vault only, never logs).
- Profile schema v2: `keyring`, `keyringFingerprint`, `keyringProvider`,
  `keyringAvailable`.
- Switch transaction: back up the current keyring, write files + databases +
  keyring, verify every store, roll back all three on failure, keep the lock.
- Detection/diagnostics: include the keyring in `stores`; report
  `keyring-mismatch`; never print tokens. Doctor warns if the keyring email
  differs from the active account.
- `clear`/`reset` removes the keyring entry only after explicit confirmation.
- Tests: fake provider; Windows CI; integration against a test credential target
  (`gemini:antigravity.test`), never the real entry.

## Roadmap

### 1.8.0-alpha.1 — started

- Custom icon (assets/icon.png) and installer asset parity.
- Read-only keyring detection in diagnostics and Doctor.
- No keyring writes yet; no profile schema change.
- Acceptance: `agy-switch diagnostics --json` shows `keyring` with email and
  token-presence booleans; Doctor warns on a keyring/active mismatch; tests pass.

### 1.8.0 — keyring-aware switching

- Keyring provider read/write/delete + verification.
- Snapshot/detect/restore include the keyring; profiles store it.
- Atomic multi-store switch with rollback; conflict/Doctor UX.
- Acceptance: switching accounts changes the Windows Credential Manager email;
  a subsequent Windows CLI/app start uses the new account; all stores verify;
  a forced failure rolls back files, DB and keyring.
- Tests: fake provider + Windows integration test target; no real credential in
  CI.

### 1.8.1 — quota/429 + dashboard

- Read-only quota/reset display from the local quota data/API.
- Detect 429/quota errors and show a clear status; no automatic account
  switching by default.
- Activity Bar view with current account, profiles, conflicts, Doctor and quota.
- Optional opt-in failover later, only after a separate review.

### 1.9.0 — hardening and distribution

- Keyring/vault encryption (DPAPI/Keychain/Secret Service) and migration.
- Open VSX, screenshots/GIF, marketplace metadata, Windows CI.
- Larger integration suite; release notes.

### 2.0-lab — optional isolation POC

- Windows-only launcher with `--user-data-dir`, isolated `USERPROFILE`, keyring
  bypass, shared-project junctions.
- Feature flag, explicit ToS warning, no quota pooling, no auto-approval.
- Go/no-go gate; if no-go, document and remove.

## Non-goals

- Proxy/gateway to pool quotas.
- Auto-approving permissions or "turbo" injection.
- Bypassing Google rate limits or terms.
- Full Linux keyring/DBus proxy as a supported feature.
- Storing raw tokens in logs, diagnostics or the README.

## Success metrics

- Zero auth-store conflicts after a switch + restart.
- Keyring email equals target account in diagnostics.
- No token material in logs.
- Switch rollback passes a fault-injection test.
- CI green on Ubuntu and Windows; release artifact reproducible.

## Sources

- [Google Antigravity @ I/O 2026](https://antigravity.google/blog/google-io-2026)
- [Antigravity changelog](https://antigravity.google/docs/changelog)
- [Antigravity plans](https://antigravity.google/docs/plans)
- [How do --user-data-dir and --profile work?](https://discuss.ai.google.dev/t/how-do-user-data-dir-and-profile-work/137054)
- [Feature Request: Multi-Account Support](https://discuss.ai.google.dev/t/feature-request-multi-account-support-work-personal/127162)
- [Using multiple paid accounts in Antigravity IDE](https://discuss.ai.google.dev/t/using-multiple-paid-accounts-in-antigravity-ide/138027)
- [One person, several paid accounts: may an orchestrator use agy?](https://discuss.ai.google.dev/t/one-person-several-paid-google-ai-pro-accounts-may-a-local-orchestrator-use-them-with-the-official-agy-cli/185460)
- [Antigravity CLI keeps one Google login per machine](https://agentsroom.dev/blog/multiple-accounts-antigravity-cli)
- [MultiGravity](https://github.com/rodolford1112/MultiGravity-Multi-Profile-Manager-for-Antigravity)
- [Antigravity Cluster](https://github.com/ypatil2006-coder/antigravity-cluster)
