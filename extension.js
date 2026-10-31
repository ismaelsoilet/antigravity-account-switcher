'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const tokenManager = require('./tokenManager');

let statusBarItem;
let outputChannel;
let lastKnownEmail = '';
const promptedSessions = new Set();
const lastPromptAt = new Map();
const conflictLogKeys = new Set();
let switchInProgress = false;
let suppressWatcherUntil = 0;
let activationTime = Date.now();
let pollTimer = null;
let pollIntervalMs = 5000;
let lastStoreSignature = '';
const PROMPT_COOLDOWN_MS = 30 * 60 * 1000;

function log(message) {
    if (outputChannel) outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function logError(message, error) {
    const detail = error && (error.stack || error.message || String(error));
    log(`${message}${detail ? `: ${detail}` : ''}`);
}

function safeMarkdown(value) {
    return String(value === undefined || value === null ? '' : value).replace(/`/g, "'");
}

function storeLabel(store) {
    if (!store) return 'unknown store';
    if (store.category === 'database') {
        return `Database (${store.home === 'win' ? 'Windows' : 'WSL'})`;
    }
    const surface = store.category === 'cliToken' ? 'CLI' : 'IDE/Desktop';
    return `${surface} token (${store.home === 'win' ? 'Windows' : 'WSL'})`;
}

function describeSessionConflicts(session) {
    const lines = [];
    for (const conflict of session.conflicts || []) {
        if (conflict.type === 'multiple-emails') {
            lines.push(`Multiple identities: ${conflict.emails.join(', ')}`);
        } else if (conflict.type === 'database-identity-mismatch') {
            lines.push(`Database identity mismatch: ${conflict.emails.join(' vs ')} (${conflict.path})`);
        } else if (conflict.type === 'target-mismatch') {
            const divergent = (conflict.stores || [])
                .map(store => `${storeLabel(store)}=${store.email}`)
                .join(', ');
            lines.push(`Expected ${conflict.targetEmail}; divergent stores: ${divergent}`);
        }
    }
    return lines.join('\n') || 'No conflict details available.';
}

function getProfileEntry(profiles, email) {
    if (!email) return null;
    const wanted = tokenManager.canonicalEmail(email);
    return Object.values(profiles).find(
        profile => profile.email && tokenManager.canonicalEmail(profile.email) === wanted
    ) || null;
}

function getPreferredStore() {
    try {
        return vscode.workspace
            .getConfiguration('antigravityAccountSwitcher')
            .get('preferredStore', 'standaloneToken');
    } catch {
        return 'standaloneToken';
    }
}

async function getActiveAccountInfo() {
    const session = tokenManager.detectSessions({ preferredStore: getPreferredStore() });
    const profiles = tokenManager.loadProfiles();
    const matched = getProfileEntry(profiles, session.email);

    return {
        isActive: session.isActive && Boolean(session.email),
        hasToken: session.hasToken,
        needsEmail: session.needsEmail,
        email: session.email || '',
        source: session.source || '',
        mtimeMs: session.mtimeMs || 0,
        targetEmail: session.targetEmail || '',
        conflicts: session.conflicts || [],
        stores: session.stores || [],
        label: matched ? matched.label : (session.email ? session.email.split('@')[0] : (session.hasToken ? 'Email not detected' : 'No Account')),
        isSaved: Boolean(matched),
        dbAvailable: tokenManager.isDbSupportAvailable(),
        dbCount: tokenManager.getDbPaths().length,
        vaultWarnings: tokenManager.getLastLoadWarnings()
    };
}

async function updateStatusBar() {
    try {
        const info = await getActiveAccountInfo();
        lastKnownEmail = info.email ? info.email.toLowerCase() : '';

        const dbStatus = !info.dbAvailable
            ? 'Unavailable (node:sqlite missing)'
            : (info.dbCount > 0
                ? `Available (${info.dbCount} database${info.dbCount === 1 ? '' : 's'})`
                : 'Available (no state.vscdb found)');
        const tooltip = [
            '### Antigravity Account Switcher',
            `* **Database sync:** ${dbStatus}`
        ];

        const hasConflict = info.conflicts.length > 0;
        if (info.isActive && info.email) {
            const displayLabel = info.label || info.email.split('@')[0];
            statusBarItem.text = hasConflict
                ? `$(warning) [${displayLabel}] ${info.email} +${info.conflicts.length}`
                : `$(account) [${displayLabel}] ${info.email}`;
            tooltip.push(
                `* **Active account:** \`${safeMarkdown(info.email)}\``,
                `* **Profile label:** \`${safeMarkdown(displayLabel)}\``,
                `* **Vault status:** ${info.isSaved ? 'Saved' : 'Not saved yet'}`,
                `* **Token source:** \`${safeMarkdown(info.source)}\``
            );
            if (info.targetEmail) {
                tooltip.push(`* **Desired account:** \`${safeMarkdown(info.targetEmail)}\``);
            }
            if (hasConflict) {
                tooltip.push('', '**Store conflict detected** (the switcher will not auto-switch):');
                for (const line of describeSessionConflicts(info).split('\n')) {
                    tooltip.push(`* ${safeMarkdown(line)}`);
                }
                tooltip.push('* Use the menu and choose **Reapply target profile** to write the desired account to every store.');
                tooltip.push('* If the conflict returns, reload/restart the surface shown as divergent (it is still signed in as the other account).');
            }
            tooltip.push('', '*(Click to switch accounts, add a new one, or rename the profile)*');
        } else if (info.hasToken) {
            statusBarItem.text = '$(warning) [Account] Email not detected';
            tooltip.push(
                '* **Status:** An OAuth token is active, but its email could not be determined.',
                '',
                '*(Click to register the email or sign in again)*'
            );
        } else {
            statusBarItem.text = '$(account) [No Account] Sign In';
            tooltip.push(
                '* **Status:** No active Google account detected (signed out).',
                '',
                '*(Click to sign in with Google or select a saved profile)*'
            );
        }

        if (!info.dbAvailable) {
            tooltip.push(
                '',
                '**Warning:** This host does not provide `node:sqlite`. Database synchronization is disabled until Antigravity runs on a compatible runtime.'
            );
        }
        if (info.vaultWarnings && info.vaultWarnings.length > 0) {
            tooltip.push('', '**Vault warnings:**');
            for (const warning of info.vaultWarnings) tooltip.push(`* ${safeMarkdown(warning)}`);
        }

        statusBarItem.tooltip = new vscode.MarkdownString(tooltip.join('\n'));
        statusBarItem.show();
    } catch (error) {
        logError('Failed to update the status bar', error);
        statusBarItem.text = '$(warning) [Account] Error';
        statusBarItem.tooltip = `Antigravity Account Switcher error: ${error.message || error}`;
        statusBarItem.show();
    }
}

async function showAccountSwitcherMenu() {
    try {
        const activeInfo = await getActiveAccountInfo();
        const profiles = tokenManager.loadProfiles();
        const items = [];
        const savedList = Object.values(profiles)
            .sort((left, right) => String(left.label).localeCompare(String(right.label)));
        const hasConflict = activeInfo.conflicts.length > 0;

        if (hasConflict && activeInfo.targetEmail) {
            const target = getProfileEntry(profiles, activeInfo.targetEmail);
            if (target && target.complete !== false) {
                items.push(
                    { label: 'CONFLICT RESOLUTION', kind: vscode.QuickPickItemKind.Separator },
                    {
                        label: `$(debug-restart) Reapply [${target.label}] ${target.email}`,
                        description: 'Write the desired account to every token file and database',
                        detail: 'Use this after reloading/restarting the surface that is still on the other account',
                        accountEmail: target.email,
                        accountLabel: target.label,
                        isActive: false,
                        action: 'switch'
                    }
                );
            }
        }

        if (hasConflict) {
            const switchState = tokenManager.readSwitchState();
            const lastAppliedAt = Date.parse(switchState.appliedAt || '') || 0;
            const newestLogin = activeInfo.stores
                .filter(store => store.kind === 'file' && store.email && (store.mtimeMs || 0) > lastAppliedAt)
                .sort((left, right) => (right.mtimeMs || 0) - (left.mtimeMs || 0))[0];
            if (newestLogin && tokenManager.canonicalEmail(newestLogin.email) !== tokenManager.canonicalEmail(activeInfo.targetEmail || activeInfo.email)) {
                items.push({
                    label: `$(sign-in) Use newest login: ${newestLogin.email}`,
                    description: 'Switch every surface to the account just signed in',
                    detail: 'Useful when the IDE or Desktop logged into a new account while the other stores still have the old one',
                    action: 'login_switch',
                    loginPath: newestLogin.path,
                    loginCategory: newestLogin.category,
                    loginEmail: newestLogin.email
                });
            }
        }

        if (savedList.length > 0) {
            items.push({ label: 'GOOGLE ACCOUNTS (SAVED IN VAULT)', kind: vscode.QuickPickItemKind.Separator });
            for (const profile of savedList) {
                const matchesActive = Boolean(
                    activeInfo.email
                    && tokenManager.canonicalEmail(profile.email) === tokenManager.canonicalEmail(activeInfo.email)
                );
                const isActive = matchesActive && !hasConflict;
                const incomplete = profile.complete === false;
                const aliases = (profile.aliases || []).filter(
                    alias => tokenManager.canonicalEmail(alias) !== tokenManager.canonicalEmail(profile.email)
                );
                const savedDetail = incomplete
                    ? 'Saved without the database identity; sign in live and save it again before switching'
                    : (profile.saved_at
                        ? `Saved on: ${profile.saved_at.slice(0, 19).replace('T', ' ')}`
                        : 'Saved profile');
                items.push({
                    label: isActive
                        ? `$(check) [${profile.label}] ${profile.email}`
                        : `${incomplete || (hasConflict && matchesActive) ? '$(warning)' : '$(account)'} [${profile.label}] ${profile.email}`,
                    description: isActive
                        ? 'Active Now'
                        : (incomplete
                            ? 'Incomplete — re-login & save'
                            : (hasConflict && matchesActive ? 'Conflict — click to reapply' : 'Click to Switch')),
                    detail: aliases.length > 0
                        ? `${savedDetail} • aliases: ${aliases.join(', ')}`
                        : savedDetail,
                    accountEmail: profile.email,
                    accountLabel: profile.label,
                    isActive,
                    incomplete,
                    action: 'switch'
                });
            }
        }

        items.push({ label: 'ACCOUNT ACTIONS', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(add) Connect / Sign In to Google Account...',
            detail: 'Opens the browser for Google OAuth and saves the new profile after sign-in.',
            action: 'login'
        });

        if (activeInfo.isActive && activeInfo.email) {
            if (activeInfo.isSaved) {
                items.push({
                    label: `$(edit) Rename Profile Label for ${activeInfo.email}...`,
                    detail: `Currently labeled as "[${activeInfo.label}]"`,
                    action: 'rename'
                });
            } else {
                items.push({
                    label: `$(save) Save Active Account (${activeInfo.email})...`,
                    detail: 'Store this active session in the switcher vault',
                    action: 'save'
                });
            }
            items.push({
                label: '$(sign-out) Log Out Current Account...',
                detail: 'Clear the active session from the IDE, Desktop and CLI',
                action: 'logout'
            });
        } else if (activeInfo.hasToken && activeInfo.needsEmail) {
            items.push({
                label: '$(edit) Register Email for Active Session...',
                detail: 'An OAuth token is active, but its email could not be detected',
                action: 'manual_save'
            });
        }

        if (savedList.length > 0) {
            items.push({
                label: '$(trash) Remove an Account from Vault...',
                detail: 'Delete an account profile from local storage',
                action: 'delete'
            });
        }

        items.push(
            {
                label: '$(info) Show Diagnostics',
                detail: 'Print detected paths, runtime support and vault warnings',
                action: 'diagnostics'
            },
            {
                label: '$(heart) Run Doctor (surfaces, conflicts, permissions)',
                detail: 'Detect running Antigravity surfaces that predate the last switch and may overwrite the token',
                action: 'doctor'
            },
            {
                label: '$(clear-all) Reset / Clear All Switcher Data...',
                detail: 'Clear every saved profile and all session tokens',
                action: 'clear_all'
            },
            {
                label: '$(refresh) Reload Window',
                detail: 'Reload Antigravity IDE to refresh the session',
                action: 'reload'
            }
        );

        const currentActive = activeInfo.isActive && activeInfo.email
            ? `[${activeInfo.label}] ${activeInfo.email}`
            : (activeInfo.hasToken ? 'Active session (email not detected)' : 'No Account (Signed Out)');

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Currently Active: ${currentActive}`,
            title: 'Antigravity Account Switcher'
        });
        if (!selected) return;

        if (selected.action === 'switch') {
            if (selected.isActive) {
                vscode.window.showInformationMessage(`Account ${selected.accountEmail} is already active.`);
                return;
            }
            await switchAccount(selected.accountEmail, selected.accountLabel);
        } else if (selected.action === 'login_switch') {
            await applyLoginCandidate({
                path: selected.loginPath,
                category: selected.loginCategory,
                email: selected.loginEmail
            });
        } else if (selected.action === 'save' || selected.action === 'rename') {
            await saveOrRenameAccount(activeInfo.email, activeInfo.label);
        } else if (selected.action === 'manual_save') {
            await manualRegisterAccount();
        } else if (selected.action === 'login') {
            await loginNewAccount();
        } else if (selected.action === 'logout') {
            await logoutAccount();
        } else if (selected.action === 'delete') {
            await deleteAccount(savedList);
        } else if (selected.action === 'diagnostics') {
            await showDiagnostics();
        } else if (selected.action === 'doctor') {
            await showDoctor();
        } else if (selected.action === 'clear_all') {
            await clearAllData();
        } else if (selected.action === 'reload') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } catch (error) {
        logError('Account switcher menu failed', error);
        vscode.window.showErrorMessage(`Account Switcher Error: ${error.message || error}`);
    }
}

async function switchAccount(email, label) {
    const profiles = tokenManager.loadProfiles();
    const profile = getProfileEntry(profiles, email);
    if (!profile) {
        vscode.window.showErrorMessage(`Account '${email}' was not found in the saved vault.`);
        return;
    }
    if (profile.complete === false) {
        vscode.window.showErrorMessage(
            `Profile "[${label}] ${profile.email}" is incomplete: it was saved without the Antigravity database identity. Sign in live and save it again before switching.`
        );
        return;
    }

    const hasDbTokens = Object.keys(profile.db_tokens || {}).length > 0;
    const hasFileTokens = Boolean(profile.file_tokens && (
        profile.file_tokens.cliToken || profile.file_tokens.standaloneToken || profile.file_tokens.oauthCreds
    ));

    const details = [
        'Antigravity IDE will reload to apply this account to the IDE, Antigravity Desktop and the CLI.',
        'Please save all open files before continuing.',
        'If another Antigravity surface is still signed into a different account, reload/restart it after this switch; otherwise it may write its account back.'
    ];
    if (!hasDbTokens) details.push('This profile has no database tokens; the IDE database will be left unchanged.');
    if (!hasFileTokens) details.push('This profile has no OAuth token files; local token files will be cleared and you may need to sign in again.');

    const confirmation = await vscode.window.showWarningMessage(
        `Switch to account "[${label}] ${profile.email}"?`,
        { modal: true, detail: details.join('\n\n') },
        'Switch & Reload',
        'Cancel'
    );
    if (confirmation !== 'Switch & Reload') return;
    if (switchInProgress) {
        vscode.window.showInformationMessage('Another account switch is already in progress.');
        return;
    }

    switchInProgress = true;
    suppressWatcherUntil = Date.now() + 5000;
    try {
        const result = tokenManager.restoreProfile(profile);
        conflictLogKeys.clear();
        log(`Switched to ${profile.email}. DB written: ${result.db.written.length}; files written: ${result.files.written.length}; files removed: ${result.files.removed.length}; verified: ${result.verification.ok}; complete: ${result.complete}.`);
        if (result.db.skipped) {
            const reason = result.db.reason || 'no Antigravity database was found';
            log(`Database state was left unchanged: ${reason}.`);
            vscode.window.showWarningMessage(`Account files were switched, but the database was not updated (${reason}).`);
        }
        await updateStatusBar();
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
        logError(`Failed to switch to ${profile.email}`, error);
        vscode.window.showErrorMessage(`Failed to switch account: ${error.message || error}`);
    } finally {
        switchInProgress = false;
        suppressWatcherUntil = Date.now() + 5000;
    }
}

function hasBlockingConflicts(session) {
    return (session.conflicts || []).some(
        conflict => conflict.type === 'multiple-emails' || conflict.type === 'database-identity-mismatch'
    );
}

async function saveOrRenameAccount(email, currentLabel) {
    const session = tokenManager.detectActiveSession();
    if (!session.hasToken) {
        vscode.window.showErrorMessage('No active Antigravity session was detected. Sign in before saving a profile.');
        return;
    }
    if (hasBlockingConflicts(session)) {
        const choice = await vscode.window.showErrorMessage(
            'Cannot save: the Antigravity stores disagree about the active account.',
            {
                modal: true,
                detail: `${describeSessionConflicts(session)}\n\nReload/restart the divergent surface, or use the menu → Reapply target profile.`
            },
            'Show Diagnostics',
            'Cancel'
        );
        if (choice === 'Show Diagnostics') await showDiagnostics();
        return;
    }
    if (!session.email) {
        await manualRegisterAccount();
        return;
    }
    if (email && tokenManager.canonicalEmail(email) !== tokenManager.canonicalEmail(session.email)) {
        vscode.window.showErrorMessage(`The active session belongs to ${session.email}, not ${email}.`);
        return;
    }

    const defaultLabel = currentLabel && currentLabel !== 'Unsaved' ? currentLabel : session.email.split('@')[0];
    const newLabel = await vscode.window.showInputBox({
        prompt: `Enter a friendly label for ${session.email}:`,
        value: defaultLabel,
        ignoreFocusOut: true
    });
    if (!newLabel || !newLabel.trim()) return;

    switchInProgress = true;
    suppressWatcherUntil = Date.now() + 5000;
    try {
        const entry = tokenManager.snapshotActiveAccount(newLabel.trim(), session.email);
        conflictLogKeys.clear();
        await updateStatusBar();
        const suffix = entry.complete ? '' : ' (incomplete: no database identity captured — sign in live and save again)';
        const merged = tokenManager.canonicalEmail(entry.email) !== tokenManager.canonicalEmail(session.email)
            ? ` (merged into existing profile ${entry.email})`
            : '';
        vscode.window.showInformationMessage(`Account ${entry.email} saved as "[${entry.label}]".${suffix}${merged}`);
    } catch (error) {
        logError('Failed to save the active account', error);
        vscode.window.showErrorMessage(`Failed to save account: ${error.message || error}`);
    } finally {
        switchInProgress = false;
        suppressWatcherUntil = Date.now() + 5000;
    }
}

async function manualRegisterAccount() {
    const session = tokenManager.detectActiveSession();
    if (!session.hasToken) {
        vscode.window.showErrorMessage('No active OAuth token was found. Sign in before registering an account.');
        return;
    }
    if (hasBlockingConflicts(session)) {
        const choice = await vscode.window.showErrorMessage(
            'Cannot register: the Antigravity stores disagree about the active account.',
            {
                modal: true,
                detail: `${describeSessionConflicts(session)}\n\nReload/restart the divergent surface, or use the menu → Reapply target profile.`
            },
            'Show Diagnostics',
            'Cancel'
        );
        if (choice === 'Show Diagnostics') await showDiagnostics();
        return;
    }

    const emailInput = await vscode.window.showInputBox({
        prompt: 'Enter the Google email that owns the active OAuth session:',
        placeHolder: 'user@gmail.com',
        value: session.email || '',
        ignoreFocusOut: true,
        validateInput: value => tokenManager.isValidEmail(value)
            ? null
            : 'Enter a valid email address (e.g. name@domain.com)'
    });
    if (!emailInput || !emailInput.trim()) return;

    const cleanEmail = emailInput.trim();
    const labelInput = await vscode.window.showInputBox({
        prompt: `Enter a friendly label for ${cleanEmail}:`,
        value: cleanEmail.split('@')[0],
        ignoreFocusOut: true
    });
    const cleanLabel = labelInput && labelInput.trim() ? labelInput.trim() : cleanEmail.split('@')[0];

    switchInProgress = true;
    suppressWatcherUntil = Date.now() + 5000;
    try {
        const entry = tokenManager.snapshotActiveAccount(cleanLabel, cleanEmail);
        conflictLogKeys.clear();
        await updateStatusBar();
        const suffix = entry.complete ? '' : ' (incomplete: no database identity captured — sign in live and save again)';
        const merged = tokenManager.canonicalEmail(entry.email) !== tokenManager.canonicalEmail(cleanEmail)
            ? ` (merged into existing profile ${entry.email})`
            : '';
        vscode.window.showInformationMessage(`Account ${entry.email} registered as "[${entry.label}]".${suffix}${merged}`);
    } catch (error) {
        logError('Failed to register the account', error);
        vscode.window.showErrorMessage(`Failed to register account: ${error.message || error}`);
    } finally {
        switchInProgress = false;
        suppressWatcherUntil = Date.now() + 5000;
    }
}

async function applyLoginCandidate(candidate, suggestedLabel) {
    if (!candidate || !candidate.path) {
        vscode.window.showErrorMessage('No fresh login token was found. Sign in again.');
        return;
    }
    const confirmation = await vscode.window.showWarningMessage(
        `Switch all Antigravity surfaces to ${candidate.email}?`,
        {
            modal: true,
            detail: 'This writes the new account to the IDE, Desktop and CLI, replacing the current account in every token file and database. Save any unsaved work first.'
        },
        'Switch All & Reload',
        'Cancel'
    );
    if (confirmation !== 'Switch All & Reload') return;

    const label = await vscode.window.showInputBox({
        prompt: `Friendly label for ${candidate.email}:`,
        value: suggestedLabel || candidate.email.split('@')[0],
        ignoreFocusOut: true
    });
    if (!label || !label.trim()) return;

    switchInProgress = true;
    suppressWatcherUntil = Date.now() + 5000;
    try {
        const { entry } = tokenManager.switchToLoginSession(candidate, label.trim());
        conflictLogKeys.clear();
        await updateStatusBar();
        vscode.window.showInformationMessage(`All surfaces switched to ${entry.email} as "[${entry.label}]".`);
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
        logError('Failed to switch all surfaces to the new login', error);
        vscode.window.showErrorMessage(`Login switch failed: ${error.message || error}`);
    } finally {
        switchInProgress = false;
        suppressWatcherUntil = Date.now() + 5000;
    }
}

async function loginNewAccount() {
    const commands = await vscode.commands.getCommands(false);
    if (!commands.includes('antigravity.internal.loginWithRedirect')) {
        vscode.window.showErrorMessage('This Antigravity version does not expose the sign-in command. Sign in from the Antigravity account menu and then use "Save Active Account".');
        return;
    }

    const confirmation = await vscode.window.showInformationMessage(
        'Connect Google Account',
        {
            modal: true,
            detail: 'The browser will open for Google OAuth. After you finish, the extension detects the new session and asks you to name the profile.'
        },
        'Open Browser & Sign In',
        'Cancel'
    );
    if (confirmation !== 'Open Browser & Sign In') return;

    const loginStart = Date.now();
    const before = tokenManager.detectSessions({ preferredStore: getPreferredStore() });
    const beforeFingerprints = new Set(before.stores.map(store => store.fingerprint).filter(Boolean));
    const beforeEmails = new Set(
        before.stores
            .flatMap(store => (store.kind === 'database' ? (store.identityEmails || []) : [store.email]))
            .filter(Boolean)
            .map(tokenManager.canonicalEmail)
    );

    let candidate = null;
    let candidateConflict = null;
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Antigravity: waiting for Google sign-in to complete...',
                cancellable: false
            },
            async () => {
                await vscode.commands.executeCommand('antigravity.internal.loginWithRedirect');
                const deadline = Date.now() + 20000;
                while (Date.now() < deadline) {
                    const current = tokenManager.detectSessions({ preferredStore: getPreferredStore() });
                    const fresh = current.stores.filter(store => (
                        store.kind === 'file'
                        && store.usable
                        && store.hasToken
                        && store.email
                        && (store.mtimeMs || 0) >= loginStart - 2000
                        && (
                            (store.fingerprint && !beforeFingerprints.has(store.fingerprint))
                            || !beforeEmails.has(tokenManager.canonicalEmail(store.email))
                        )
                    ));
                    const distinct = new Map();
                    for (const store of fresh) {
                        const key = tokenManager.canonicalEmail(store.email);
                        if (!distinct.has(key)) distinct.set(key, store);
                    }
                    if (distinct.size > 1) {
                        candidateConflict = [...distinct.values()];
                        return;
                    }
                    if (distinct.size === 1) {
                        candidate = [...distinct.values()][0];
                        return;
                    }
                    await tokenManager.delay(500);
                }
            }
        );
    } catch (error) {
        logError('Google sign-in command failed', error);
        vscode.window.showErrorMessage(`Google Sign-In failed or was cancelled: ${error.message || error}`);
        return;
    }

    if (candidateConflict) {
        const emails = candidateConflict.map(store => store.email).join(', ');
        vscode.window.showErrorMessage(`Sign-in produced multiple fresh identities (${emails}). Close or switch the other Antigravity surfaces and try again.`);
        return;
    }
    if (!candidate) {
        vscode.window.showWarningMessage('Sign-in was not detected with a fresh token. Finish the flow in your browser and then use "Save Active Account".');
        return;
    }

    await applyLoginCandidate(candidate, candidate.email.split('@')[0]);
}

async function logoutAccount() {
    const confirmation = await vscode.window.showWarningMessage(
        'Log out of the current Google Account session?',
        { modal: true, detail: 'This clears the OAuth tokens and the Antigravity session state. Saved profiles are kept.' },
        'Log Out',
        'Cancel'
    );
    if (confirmation !== 'Log Out') return;

    switchInProgress = true;
    suppressWatcherUntil = Date.now() + 5000;
    try {
        tokenManager.clearAllSessionTokens();
        conflictLogKeys.clear();
        try {
            await vscode.commands.executeCommand('antigravity.internal.logout');
        } catch {}
        await updateStatusBar();
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
        logError('Logout failed', error);
        vscode.window.showErrorMessage(`Log out failed: ${error.message || error}`);
    } finally {
        switchInProgress = false;
        suppressWatcherUntil = Date.now() + 5000;
    }
}

async function clearAllData() {
    const confirmation = await vscode.window.showWarningMessage(
        'Clear all accounts and switcher data?',
        { modal: true, detail: 'Every saved profile and every active session token will be removed.' },
        'Clear Everything',
        'Cancel'
    );
    if (confirmation !== 'Clear Everything') return;

    switchInProgress = true;
    suppressWatcherUntil = Date.now() + 5000;
    try {
        const lock = tokenManager.acquireSwitchLock();
        try {
            tokenManager.saveProfiles({});
        } finally {
            lock.release();
        }
        tokenManager.clearAllSessionTokens();
        conflictLogKeys.clear();
        try {
            await vscode.commands.executeCommand('antigravity.internal.logout');
        } catch {}
        promptedSessions.clear();
        lastPromptAt.clear();
        await updateStatusBar();
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
        logError('Failed to clear switcher data', error);
        vscode.window.showErrorMessage(`Clear failed: ${error.message || error}`);
    } finally {
        switchInProgress = false;
        suppressWatcherUntil = Date.now() + 5000;
    }
}

async function deleteAccount(savedList) {
    const items = savedList.map(profile => ({
        label: `[${profile.label}] ${profile.email}`,
        accountEmail: profile.email,
        detail: profile.saved_at ? `Saved: ${profile.saved_at.slice(0, 10)}` : ''
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an account to remove from the saved vault...',
        title: 'Remove Saved Account'
    });
    if (!selected) return;

    const confirmation = await vscode.window.showWarningMessage(
        `Remove ${selected.accountEmail} from the switcher vault?`,
        { modal: true },
        'Delete',
        'Cancel'
    );
    if (confirmation !== 'Delete') return;

    const lock = tokenManager.acquireSwitchLock();
    try {
        const profiles = tokenManager.loadProfiles();
        const entry = getProfileEntry(profiles, selected.accountEmail);
        if (!entry) throw new Error('Profile not found.');
        delete profiles[entry.email];
        tokenManager.saveProfiles(profiles);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account ${entry.email} removed.`);
    } catch (error) {
        logError('Failed to remove the account', error);
        vscode.window.showErrorMessage(`Failed to remove account: ${error.message || error}`);
    } finally {
        lock.release();
    }
}

async function showDiagnostics() {
    try {
        const diagnostics = tokenManager.getDiagnostics();
        if (!outputChannel) return;
        outputChannel.clear();
        outputChannel.appendLine(JSON.stringify(diagnostics, null, 2));
        outputChannel.show(true);
        vscode.window.showInformationMessage('Diagnostics written to the "Antigravity Account Switcher" output channel.');
    } catch (error) {
        logError('Failed to collect diagnostics', error);
        vscode.window.showErrorMessage(`Diagnostics failed: ${error.message || error}`);
    }
}

async function showDoctor() {
    try {
        const report = tokenManager.getDoctorReport({ preferredStore: getPreferredStore() });
        if (outputChannel) {
            outputChannel.clear();
            outputChannel.appendLine(JSON.stringify(report, null, 2));
            outputChannel.show(true);
        }
        const errors = report.warnings.filter(warning => warning.severity === 'error').length;
        const warnings = report.warnings.length;
        if (report.ok) {
            vscode.window.showInformationMessage(
                `Account Switcher Doctor: no blocking issues (${warnings} warning${warnings === 1 ? '' : 's'}).`
            );
        } else {
            const choice = await vscode.window.showWarningMessage(
                `Account Switcher Doctor: ${errors} blocking issue(s), ${warnings} total.`,
                'Show Output',
                'Dismiss'
            );
            if (choice === 'Show Output' && outputChannel) outputChannel.show(true);
        }
    } catch (error) {
        logError('Doctor failed', error);
        vscode.window.showErrorMessage(`Doctor failed: ${error.message || error}`);
    }
}

async function checkAndPromptNewAccountOnStartup() {
    if (switchInProgress || Date.now() < suppressWatcherUntil) return;
    try {
        const info = await getActiveAccountInfo();

        if (info.vaultWarnings.length > 0) {
            log(`Vault warnings: ${info.vaultWarnings.join(' | ')}`);
        }
        if (info.conflicts.length > 0) {
            log('Skipping the save prompt because the stores disagree about the active account.');
            return;
        }

        if (info.hasToken && info.needsEmail) {
            if (promptedSessions.has('needs-email')) return;
            const last = lastPromptAt.get('needs-email') || 0;
            if (Date.now() - last < PROMPT_COOLDOWN_MS) return;
            promptedSessions.add('needs-email');
            lastPromptAt.set('needs-email', Date.now());
            const choice = await vscode.window.showWarningMessage(
                'Antigravity Account Switcher: an OAuth session is active, but its email could not be detected.',
                'Register Email',
                'Later'
            );
            if (choice === 'Register Email') await manualRegisterAccount();
            return;
        }

        if (!info.email || info.isSaved) return;
        const emailKey = info.email.toLowerCase();
        const key = `${emailKey}:${info.source || ''}:${info.mtimeMs || 0}`;
        if (promptedSessions.has(key)) return;
        const last = lastPromptAt.get(emailKey) || 0;
        if (Date.now() - last < PROMPT_COOLDOWN_MS) return;
        promptedSessions.add(key);
        lastPromptAt.set(emailKey, Date.now());

        const choice = await vscode.window.showInformationMessage(
            `Antigravity Account Switcher: active account detected (${info.email}). Save it to your vault?`,
            'Save Account',
            'Later'
        );
        if (choice === 'Save Account') {
            await saveOrRenameAccount(info.email, '');
        }
    } catch (error) {
        logError('Startup account check failed', error);
    }
}

async function evaluateStoreChanges(reason) {
    if (switchInProgress || Date.now() < suppressWatcherUntil) return;
    try {
        const state = tokenManager.readSwitchState();
        const signature = tokenManager.getStoreMtimeSignature();
        if (signature === lastStoreSignature) return;
        lastStoreSignature = signature;

        const diff = tokenManager.diffAgainstSwitchState(state);

        if (diff.conflicts.length > 0) {
            for (const conflict of diff.conflicts) {
                const key = `${conflict.kind}:${conflict.path}:${conflict.email}`;
                if (conflictLogKeys.has(key)) continue;
                conflictLogKeys.add(key);
                log(`External account conflict (${reason}): ${conflict.kind} ${conflict.path} contains ${conflict.email}, expected ${conflict.expectedEmail}.`);
            }
            await updateStatusBar();
            return;
        }

        if (diff.missing.length > 0) {
            for (const missing of diff.missing) {
                const key = `missing:${missing.path}`;
                if (conflictLogKeys.has(key)) continue;
                conflictLogKeys.add(key);
                log(`External store deletion (${reason}): ${missing.path}`);
            }
            await updateStatusBar();
            return;
        }

        if (diff.refreshes.length > 0) {
            log(`Same-account token refresh detected (${reason}); no action taken.`);
        }

        const info = await getActiveAccountInfo();
        const previousEmail = lastKnownEmail;
        await updateStatusBar();
        if (info.email && info.email !== previousEmail && !info.isSaved && info.mtimeMs >= activationTime) {
            await checkAndPromptNewAccountOnStartup();
        }
    } catch (error) {
        logError('Token watcher failed', error);
    }
}

function setupTokenFileWatchers(context) {
    const paths = tokenManager.getTokenFilePaths();
    const directories = new Set(tokenManager.getGeminiDirs());
    for (const list of Object.values(paths)) {
        for (const tokenPath of list) directories.add(path.dirname(tokenPath));
    }

    let timer = null;
    const schedule = reason => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void evaluateStoreChanges(reason);
        }, 750);
    };

    for (const directory of directories) {
        try {
            if (!fs.existsSync(directory)) continue;
            const watcher = fs.watch(directory, () => schedule('fs-watch'));
            context.subscriptions.push({ dispose: () => { try { watcher.close(); } catch {} } });
        } catch (error) {
            logError(`Could not watch ${directory}`, error);
        }
    }

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => schedule('poll'), pollIntervalMs);
    context.subscriptions.push({
        dispose: () => {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }
    });
}

function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Antigravity Account Switcher');
    context.subscriptions.push(outputChannel);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.name = 'Antigravity Account';
    statusBarItem.command = 'antigravity-account-switcher.switch';
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-account-switcher.switch', showAccountSwitcherMenu),
        vscode.commands.registerCommand('antigravity-account-switcher.save', () => saveOrRenameAccount('', '')),
        vscode.commands.registerCommand('antigravity-account-switcher.login', loginNewAccount),
        vscode.commands.registerCommand('antigravity-account-switcher.diagnostics', showDiagnostics),
        vscode.commands.registerCommand('antigravity-account-switcher.doctor', showDoctor)
    );

    activationTime = Date.now();
    try {
        const configuredPoll = Number(
            vscode.workspace.getConfiguration('antigravityAccountSwitcher').get('pollIntervalMs', 5000)
        );
        pollIntervalMs = Number.isFinite(configuredPoll) && configuredPoll >= 1000 ? configuredPoll : 5000;
    } catch {
        pollIntervalMs = 5000;
    }

    const initialized = tokenManager.initialize();
    log(`Activated v${tokenManager.VERSION} (host: ${vscode.env.remoteName || 'local'}, poll: ${pollIntervalMs}ms).`);
    log(`Homes: ${initialized.homes.join(', ') || '(none)'}`);
    log(`Databases: ${initialized.dbPaths.join(', ') || '(none)'}`);

    void updateStatusBar();
    setupTokenFileWatchers(context);

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(state => {
            if (!state.focused) return;
            void updateStatusBar();
        })
    );

    setTimeout(() => { void checkAndPromptNewAccountOnStartup(); }, 2000);

    if (!tokenManager.isDbSupportAvailable()) {
        log('node:sqlite is unavailable in this host. Database synchronization is disabled.');
    }
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
    getActiveAccountInfo,
    switchAccount,
    saveOrRenameAccount,
    manualRegisterAccount,
    logoutAccount,
    clearAllData
};
