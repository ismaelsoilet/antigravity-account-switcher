'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const tokenManager = require('./tokenManager');
const { renderDashboardHtml, renderDashboardLoadingHtml, escapeHtml } = require('./dashboardHtml');

let statusBarItem;
let quotaStatusBarItem;
let outputChannel;
let dashboardProvider = null;
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

let cachedLocale = null;
let cachedLocaleAt = 0;

function normalizeLocale(value) {
    const text = String(value || '').trim().replace(/_/g, '-');
    if (!text) return '';
    const match = text.match(/^([a-z]{2,3})(?:-([a-z0-9]{2,8}))?/i);
    if (!match) return '';
    const language = match[1].toLowerCase();
    const region = match[2] ? `-${match[2].toUpperCase()}` : '';
    return `${language}${region}`;
}

function validateLocale(value) {
    const locale = normalizeLocale(value);
    if (!locale) return '';
    try {
        return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0 ? locale : '';
    } catch {
        return '';
    }
}

function getLocalizationLocale() {
    if (cachedLocale !== null && Date.now() - cachedLocaleAt < 60 * 60 * 1000) {
        return cachedLocale;
    }
    const candidates = [];
    if (process.platform === 'win32' || process.platform === 'linux') {
        try {
            candidates.push(execFileSync('powershell.exe', [
                '-NoProfile',
                '-Command',
                '(Get-Culture).Name'
            ], {
                encoding: 'utf-8',
                timeout: 3000,
                stdio: ['ignore', 'pipe', 'ignore']
            }));
        } catch {}
    }
    candidates.push(
        process.env.LC_ALL,
        process.env.LC_TIME,
        process.env.LANG,
        process.env.LANGUAGE
    );
    try {
        candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
    } catch {}
    try {
        candidates.push(vscode.env.language);
    } catch {}
    for (const candidate of candidates) {
        const first = String(candidate || '').split(':')[0].split('.')[0];
        const locale = validateLocale(first);
        if (locale) {
            cachedLocale = locale;
            cachedLocaleAt = Date.now();
            return locale;
        }
    }
    cachedLocale = 'en-US';
    cachedLocaleAt = Date.now();
    return cachedLocale;
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
            label: '$(add) Add Google Account...',
            detail: 'Saves the current profile, signs out, opens Google sign-in, and restores the previous account if cancelled.',
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

    const keyringProvider = typeof tokenManager.getKeyringProvider === 'function'
        ? tokenManager.getKeyringProvider()
        : null;
    if (keyringProvider && keyringProvider.available && !profile.keyring) {
        vscode.window.showErrorMessage(
            `Profile "[${label}] ${profile.email}" has no captured Windows keyring. Sign in to this account and save the profile again before switching.`
        );
        return;
    }

    const hasDbTokens = Object.keys(profile.db_tokens || {}).length > 0;
    const hasFileTokens = Boolean(profile.file_tokens && (
        profile.file_tokens.cliToken || profile.file_tokens.standaloneToken || profile.file_tokens.oauthCreds
    ));

    const details = [
        'Antigravity IDE will reload to apply this account to the IDE, Antigravity Desktop, the CLI and the Windows keyring.',
        'Please save all open files before continuing.',
        'The Windows keyring is written and verified; if another surface is still signed into a different account, reload/restart it after this switch.'
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
        refreshDashboard();
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
        refreshDashboard();
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
        refreshDashboard();
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

function chooseLoginCandidate(session) {
    const stores = (session.stores || []).filter(store => (
        store.kind === 'file'
        && store.usable
        && store.hasToken
        && store.email
    ));
    const byEmail = new Map();
    for (const store of stores) {
        const key = tokenManager.canonicalEmail(store.email);
        if (!byEmail.has(key)) byEmail.set(key, store);
    }
    if (byEmail.size > 1) {
        throw new Error(
            `Sign-in produced multiple fresh identities (${[...byEmail.keys()].join(', ')}). `
            + 'Close or switch the other Antigravity surfaces, then try again.'
        );
    }
    if (byEmail.size === 0) return null;
    const order = ['standaloneToken', 'cliToken', 'oauthCreds'];
    return [...byEmail.values()].sort(
        (left, right) => order.indexOf(left.category) - order.indexOf(right.category)
    )[0];
}

function scheduleWindowReload() {
    setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }, 900);
}

async function applyLoginCandidate(candidate) {
    if (!candidate || !candidate.path || !candidate.email) {
        vscode.window.showErrorMessage('No fresh login token was found. Sign in again.');
        return;
    }
    const profiles = tokenManager.loadProfiles();
    const existing = getProfileEntry(profiles, candidate.email);
    const label = existing && existing.label ? existing.label : candidate.email.split('@')[0];
    const confirmation = await vscode.window.showWarningMessage(
        `Switch all Antigravity surfaces to ${candidate.email}?`,
        {
            modal: true,
            detail: 'This writes the signed-in account to every token file and database. Saved profiles are kept.'
        },
        'Switch All & Reload',
        'Cancel'
    );
    if (confirmation !== 'Switch All & Reload') return;

    switchInProgress = true;
    suppressWatcherUntil = Date.now() + 5000;
    try {
        const { entry } = tokenManager.switchToLoginSession(candidate, label);
        conflictLogKeys.clear();
        await updateStatusBar();
        refreshDashboard();
        vscode.window.showInformationMessage(`All surfaces switched to ${entry.email} as [${entry.label}]. Reloading...`);
        scheduleWindowReload();
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
        vscode.window.showErrorMessage(
            'This Antigravity version does not expose the sign-in command. '
            + 'Sign in from the Antigravity account menu, choose the new account, and then use "Save Active Account".'
        );
        return;
    }

    const before = tokenManager.detectSessions({
        preferredStore: getPreferredStore(),
        includeKeyring: true
    });
    const previousEmail = before.hasToken ? (before.email || '') : '';
    if (before.hasToken && !previousEmail) {
        vscode.window.showErrorMessage(
            'The active session has no detectable email. Register or save it before adding another account.'
        );
        return;
    }
    if (previousEmail && hasBlockingConflicts(before)) {
        vscode.window.showErrorMessage(
            'Cannot add an account while the Antigravity stores disagree. '
            + 'Resolve the conflict from the dashboard first.'
        );
        return;
    }
    if (previousEmail && !commands.includes('antigravity.internal.logout')) {
        vscode.window.showErrorMessage(
            'This Antigravity version does not expose the sign-out command. '
            + 'Use "Log Out Current Account", sign in with the new account, then use "Save Active Account".'
        );
        return;
    }

    const detail = previousEmail
        ? `Antigravity supports one active Google account at a time. To add another account, the extension will:\n\n`
            + `1. save/refresh the profile for ${previousEmail};\n`
            + `2. sign out of ${previousEmail};\n`
            + `3. open Google sign-in;\n`
            + `4. save the new account and apply it to every surface.\n\n`
            + `In the browser, choose the account you want to add. If ${previousEmail} appears preselected, choose "Use another account".\n\n`
            + `If you cancel or sign-in fails, ${previousEmail} is restored. `
            + `Finish running agent tasks and close other Antigravity windows/CLI sessions first.`
        : 'The browser will open for Google sign-in. The new account will be saved and applied to every surface.';
    const continueLabel = previousEmail ? 'Sign Out & Continue' : 'Sign In & Continue';
    const confirmation = await vscode.window.showWarningMessage(
        'Add Google Account',
        { modal: true, detail },
        continueLabel,
        'Cancel'
    );
    if (confirmation !== continueLabel) return;

    let rollback = null;
    let candidate = null;
    switchInProgress = true;
    suppressWatcherUntil = Date.now() + 5 * 60 * 1000;
    try {
        if (previousEmail) {
            const profiles = tokenManager.loadProfiles();
            const existing = getProfileEntry(profiles, previousEmail);
            const label = existing && existing.label ? existing.label : previousEmail.split('@')[0];
            tokenManager.snapshotActiveAccount(label, previousEmail);
        }
        rollback = tokenManager.captureCurrentState({ includeKeyring: true });

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: previousEmail ? 'Antigravity: adding Google account' : 'Antigravity: signing in',
                cancellable: false
            },
            async progress => {
                if (previousEmail) {
                    progress.report({ message: `Signing out of ${previousEmail}...` });
                    await vscode.commands.executeCommand('antigravity.internal.logout');
                    tokenManager.clearAllSessionTokens();
                } else if (commands.includes('antigravity.internal.logout')) {
                    try {
                        await vscode.commands.executeCommand('antigravity.internal.logout');
                    } catch {}
                }
                progress.report({
                    message: previousEmail
                        ? `Signed out. In the browser, choose the account to add (use "Use another account" if ${previousEmail} appears).`
                        : 'In the browser, choose the account to add.'
                });
                const authResult = await vscode.commands.executeCommand('antigravity.internal.loginWithRedirect');
                if (authResult && authResult.hasValidAuth === false) {
                    throw new Error(authResult.uiMessage || 'Google sign-in did not complete.');
                }
                progress.report({ message: 'Reading the new session...' });
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline) {
                    const current = tokenManager.detectSessions({ preferredStore: getPreferredStore() });
                    candidate = chooseLoginCandidate(current);
                    if (candidate) return;
                    await tokenManager.delay(500);
                }
                throw new Error(
                    'Google sign-in was not detected with a fresh token. '
                    + 'Finish the browser flow and try again.'
                );
            }
        );

        if (!candidate) throw new Error('No fresh login token was found. Sign in again.');

        const profiles = tokenManager.loadProfiles();
        const existing = getProfileEntry(profiles, candidate.email);
        const label = existing && existing.label ? existing.label : candidate.email.split('@')[0];
        const { entry } = tokenManager.switchToLoginSession(candidate, label);
        conflictLogKeys.clear();
        await updateStatusBar();
        refreshDashboard();
        const sameAccount = previousEmail
            && tokenManager.canonicalEmail(previousEmail) === tokenManager.canonicalEmail(entry.email);
        vscode.window.showInformationMessage(
            sameAccount
                ? `Signed in as ${entry.email} again; profile [${entry.label}] refreshed and all surfaces synced. Reloading...`
                : `Added ${entry.email} as [${entry.label}]. All surfaces synced. Reloading...`
        );
        scheduleWindowReload();
    } catch (error) {
        logError('Add Google account failed', error);
        if (rollback) {
            const restored = tokenManager.restoreCapturedState(rollback);
            if (restored.failed.length > 0) {
                vscode.window.showErrorMessage(
                    `Add account failed: ${error.message || error}. `
                    + `The previous account could not be fully restored: ${restored.failed.join(' | ')}`
                );
                if (outputChannel) outputChannel.show(true);
            } else {
                vscode.window.showWarningMessage(
                    `Add account failed: ${error.message || error}. `
                    + (previousEmail ? `Previous account ${previousEmail} restored. Reloading...` : 'Previous state restored. Reloading...')
                );
                try {
                    await updateStatusBar();
                    refreshDashboard();
                } catch {}
                scheduleWindowReload();
            }
        } else {
            vscode.window.showErrorMessage(`Add account failed: ${error.message || error}. No changes were made.`);
        }
    } finally {
        switchInProgress = false;
        suppressWatcherUntil = Date.now() + 5000;
    }
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
        refreshDashboard();
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
        refreshDashboard();
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
        refreshDashboard();
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

function formatQuotaReset(value) {
    if (!value) return '';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return '';
    const remaining = timestamp - Date.now();
    if (remaining <= 0) return 'reset due';
    const minutes = Math.round(remaining / 60000);
    if (minutes < 60) return `reset in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 48) return `reset in ${hours}h${rest ? ` ${rest}m` : ''}`;
    return `resets ${new Date(timestamp).toLocaleDateString()}`;
}

class DashboardViewProvider {
    constructor(context) {
        this.context = context;
        this.view = null;
        this.pendingForceQuota = false;
        this.updateSeq = 0;
    }

    resolveWebviewView(view) {
        this.view = view;
        try {
            view.webview.options = {
                enableScripts: true,
                localResourceRoots: []
            };
            view.webview.onDidReceiveMessage(async message => {
                if (!message || typeof message.command !== 'string') return;
                try {
                    if (message.command === 'switch') {
                        await switchAccount(message.email, message.label);
                    } else if (message.command === 'save') {
                        await saveOrRenameAccount('', '');
                    } else if (message.command === 'login') {
                        await loginNewAccount();
                    } else if (message.command === 'doctor') {
                        await showDoctor();
                    } else if (message.command === 'diagnostics') {
                        await showDiagnostics();
                    } else if (message.command === 'openSettings') {
                        await vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            'antigravityAccountSwitcher'
                        );
                    } else if (message.command === 'refresh') {
                        await this.update(true);
                    }
                } catch (error) {
                    logError(`Dashboard action ${message.command} failed`, error);
                    vscode.window.showErrorMessage(`Dashboard action failed: ${error.message || error}`);
                }
            });
            if (typeof view.onDidChangeVisibility === 'function') {
                view.onDidChangeVisibility(() => {
                    if (view.visible) void this.update(false);
                });
            }
        } catch (error) {
            logError('Dashboard view setup failed', error);
        }
        try {
            view.webview.html = renderDashboardLoadingHtml();
        } catch {}
        const force = this.pendingForceQuota;
        this.pendingForceQuota = false;
        void this.update(force);
    }

    buildSnapshot(quotaOverride, loading = false) {
        const session = tokenManager.detectSessions({ preferredStore: getPreferredStore() });
        const profiles = tokenManager.loadProfiles();
        const keyring = tokenManager.getKeyringReport();
        const localQuota = tokenManager.getQuotaReport({ live: false, refresh: false });
        const quota = quotaOverride
            ? { ...quotaOverride, loading: Boolean(loading) }
            : { ...localQuota, loading: Boolean(loading) };
        const matched = getProfileEntry(profiles, session.email);
        const activeLabel = matched
            ? matched.label
            : (session.email ? session.email.split('@')[0] : '');
        return {
            version: tokenManager.VERSION,
            locale: getLocalizationLocale(),
            active: {
                email: session.email || '',
                label: activeLabel,
                targetEmail: session.targetEmail || '',
                conflicts: (session.conflicts || []).length,
                conflictDetails: (session.conflicts || []).length
                    ? describeSessionConflicts(session)
                    : ''
            },
            keyring,
            quota,
            profiles: Object.values(profiles).map(profile => ({
                email: profile.email,
                label: profile.label || profile.email,
                complete: profile.complete !== false,
                keyring: Boolean(profile.keyring),
                active: Boolean(
                    session.email
                    && tokenManager.canonicalEmail(profile.email) === tokenManager.canonicalEmail(session.email)
                )
            })).sort((left, right) => String(left.label).localeCompare(String(right.label)))
        };
    }

    async update(forceQuota = false) {
        if (!this.view) {
            this.pendingForceQuota = this.pendingForceQuota || Boolean(forceQuota);
            return;
        }
        this.updateSeq += 1;
        const sequence = this.updateSeq;
        try {
            const localQuota = tokenManager.getQuotaReport({ live: false, refresh: false });
            const needsLive = Boolean(forceQuota) || !localQuota.live;
            const localSnapshot = this.buildSnapshot(localQuota, needsLive);
            this.view.webview.html = renderDashboardHtml(
                localSnapshot,
                crypto.randomBytes(16).toString('hex')
            );
            if (!needsLive) {
                void updateQuotaStatusBar(false);
                return;
            }
            const live = await tokenManager.getQuotaReportAsync({
                live: true,
                refresh: Boolean(forceQuota),
                usageTimeout: 6000
            });
            if (sequence !== this.updateSeq || !this.view) return;
            this.view.webview.html = renderDashboardHtml(
                this.buildSnapshot(live, false),
                crypto.randomBytes(16).toString('hex')
            );
            void updateQuotaStatusBar(false);
        } catch (error) {
            logError('Dashboard update failed', error);
            this.view.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)"><strong>Dashboard unavailable</strong><p>${escapeHtml(error.message || String(error))}</p></body></html>`;
        }
    }

    refresh(forceQuota = false) {
        if (!this.view) {
            this.pendingForceQuota = this.pendingForceQuota || Boolean(forceQuota);
            return;
        }
        void this.update(forceQuota);
    }
}

function refreshDashboard() {
    if (!dashboardProvider) return;
    dashboardProvider.refresh(false);
}

async function switchToProfile(email, label) {
    await switchAccount(email, label);
    refreshDashboard();
}

async function openDashboard() {
    await vscode.commands.executeCommand('workbench.view.extension.antigravityAccountSwitcher');
    if (dashboardProvider && dashboardProvider.view) dashboardProvider.refresh(false);
    void updateQuotaStatusBar();
}

async function showQuota() {
    try {
        await openDashboard();
        if (dashboardProvider) dashboardProvider.refresh(true);
        void updateQuotaStatusBar(true);
    } catch (error) {
        logError('Quota lookup failed', error);
        vscode.window.showErrorMessage(`Quota lookup failed: ${error.message || error}`);
    }
}

async function refreshDashboardCommand() {
    if (!dashboardProvider) return;
    if (!dashboardProvider.view) {
        await openDashboard();
        return;
    }
    dashboardProvider.refresh(true);
}

function applyQuotaStatusBar(quota) {
    if (!quotaStatusBarItem) return;
    if (!quota || !quota.available) {
        quotaStatusBarItem.text = '$(pulse) Quota';
        quotaStatusBarItem.tooltip = 'Quota is not available locally. Click to open the Antigravity Accounts dashboard.';
        quotaStatusBarItem.show();
        return;
    }
    const weekly = quota.models.find(model => /weekly/i.test(model.label));
    const fiveHour = quota.models.find(model => /five hour|5-hour|5h/i.test(model.label));
    const geminiWeekly = quota.models.find(model => /gemini/i.test(model.label) && /weekly/i.test(model.label)) || weekly;
    const geminiFive = quota.models.find(model => /gemini/i.test(model.label) && /five hour|5-hour|5h/i.test(model.label)) || fiveHour;
    const parts = [];
    if (geminiWeekly) parts.push(`${Math.round(geminiWeekly.remainingPercent)}%`);
    if (geminiFive) parts.push(`5h ${Math.round(geminiFive.remainingPercent)}%`);
    quotaStatusBarItem.text = `${quota.rateLimited ? '$(warning)' : '$(pulse)'} ${parts.join(' · ') || 'Quota'}`;
    const tooltip = new vscode.MarkdownString();
    const locale = getLocalizationLocale();
    tooltip.appendMarkdown('**Antigravity quota**\n\n');
    for (const model of quota.models) {
        const reset = model.resetAt
            ? new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(new Date(model.resetAt))
            : '';
        tooltip.appendMarkdown(
            `- ${model.label}: ${model.remainingPercent}%`
            + `${model.exhausted ? ' (exhausted)' : ''}`
            + `${reset ? ` · reset ${reset}` : ''}\n`
        );
    }
    if (quota.rateLimited) {
        tooltip.appendMarkdown('\nA recent 429 / quota signal was found in local logs. This is informational only.\n');
    }
    tooltip.appendMarkdown('\nClick to open the dashboard.');
    quotaStatusBarItem.tooltip = tooltip;
    quotaStatusBarItem.show();
}

async function updateQuotaStatusBar(forceLive = false) {
    if (!quotaStatusBarItem) return;
    try {
        const local = tokenManager.getQuotaReport({ live: false, refresh: false });
        applyQuotaStatusBar(local);
        if (local.live && !forceLive) return;
        if (!local.available) {
            quotaStatusBarItem.text = '$(sync~spin) Quota';
            quotaStatusBarItem.tooltip = 'Loading quota from the official /usage…';
            quotaStatusBarItem.show();
        }
        const live = await tokenManager.getQuotaReportAsync({
            live: true,
            refresh: Boolean(forceLive),
            usageTimeout: 6000
        });
        applyQuotaStatusBar(live);
    } catch (error) {
        logError('Could not update quota status bar', error);
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

    quotaStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    quotaStatusBarItem.name = 'Antigravity Quota';
    quotaStatusBarItem.command = 'antigravity-account-switcher.showQuota';
    context.subscriptions.push(quotaStatusBarItem);

    dashboardProvider = new DashboardViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'antigravityAccountSwitcher.dashboard',
            dashboardProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-account-switcher.switch', showAccountSwitcherMenu),
        vscode.commands.registerCommand('antigravity-account-switcher.save', () => saveOrRenameAccount('', '')),
        vscode.commands.registerCommand('antigravity-account-switcher.login', loginNewAccount),
        vscode.commands.registerCommand('antigravity-account-switcher.diagnostics', showDiagnostics),
        vscode.commands.registerCommand('antigravity-account-switcher.doctor', showDoctor),
        vscode.commands.registerCommand('antigravity-account-switcher.refreshDashboard', refreshDashboardCommand),
        vscode.commands.registerCommand('antigravity-account-switcher.showQuota', showQuota),
        vscode.commands.registerCommand('antigravity-account-switcher.openDashboard', openDashboard),
        vscode.commands.registerCommand('antigravity-account-switcher.switchToProfile', switchToProfile)
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
    void updateQuotaStatusBar();
    setupTokenFileWatchers(context);

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(state => {
            if (!state.focused) return;
            void updateStatusBar();
            void updateQuotaStatusBar();
        })
    );

    setTimeout(() => { void checkAndPromptNewAccountOnStartup(); }, 2000);

    const introSeen = context.globalState
        ? context.globalState.get('antigravityAccountSwitcher.dashboardIntroSeen', false)
        : false;
    if (!introSeen) {
        setTimeout(async () => {
            try {
                const choice = await vscode.window.showInformationMessage(
                    'Antigravity Accounts: quota, profiles and Doctor are in the Activity Bar.',
                    'Open Dashboard',
                    'Later'
                );
                if (choice === 'Open Dashboard') await openDashboard();
                if (context.globalState) {
                    await context.globalState.update('antigravityAccountSwitcher.dashboardIntroSeen', true);
                }
            } catch {}
        }, 2500);
    }

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
