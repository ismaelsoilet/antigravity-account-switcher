# SPEC 1.8.6 — Cancel-safe Add Google Account

## Problem

Antigravity stores one active Google identity. Calling the internal sign-in
command while an account is active lets Google reuse the existing session, so
adding a second account appeared to require a manual logout. The old flow also
asked for a second confirmation and a label after login, and a cancelled or
failed flow could leave the user signed out or partially switched.

## Goal

One explicit action that:

1. keeps the current account safe;
2. signs out only after a recoverable snapshot exists;
3. lets the user choose the new Google account in the browser;
4. applies the new account to every surface;
5. restores the previous account on cancel, timeout or failure.

This remains one active account at a time and uses Antigravity's normal Google
OAuth flow; it does not bypass or automate Google authentication.

## Flow

1. The user clicks **Add account**.
2. The extension reads the current session (`detectSessions`, including keyring)
   and refuses to continue if:
   * the stores report a blocking conflict; or
   * a token exists without a detectable email.
3. A single modal explains that the current account will be signed out, that its
   profile is saved, and that it will be restored if the flow fails.
4. Before sign-out the extension:
   * saves/refreshes the current profile with `snapshotActiveAccount`;
   * captures token files, database auth keys and keyring with
     `captureCurrentState({ includeKeyring: true })`.
5. It runs `antigravity.internal.logout` and clears the remaining session tokens
   with `clearAllSessionTokens()`.
6. It runs `antigravity.internal.loginWithRedirect` and waits for a usable file
   token. Multiple distinct emails are rejected. The progress asks the user to
   choose the desired account and use “Use another account” when necessary.
7. The new account is applied with `switchToLoginSession` using an automatic
   label (existing label or email prefix). Every surface is verified.
8. On success the window reloads. If the signed-in email is the same as before,
   the profile is refreshed and no duplicate profile is created.
9. On any failure after the snapshot, `restoreCapturedState` restores the token
   files, databases and keyring, then the window reloads.

## Invariants

* No sign-out happens before a profile snapshot and a raw state capture succeed.
* A failed login never leaves the user without a recoverable previous state.
* The new profile writes both `standaloneToken` and `cliToken` copies through
  the normal token normalization.
* A browser login is never completed automatically; the user chooses the Google
  account and grants consent.
* Only one account is active; parallel accounts are out of scope.

## Tests

* `captureCurrentState` / `restoreCapturedState` round-trip restores the old file
  token and database identity after a simulated new login.
* `switchToLoginSession` still writes both token categories and verifies stores.
* Dashboard render tests assert the **Add account** entry points and no token
  leakage.
