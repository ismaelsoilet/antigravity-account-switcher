'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const tokenManager = require('./tokenManager');

let statusBarItem;
let outputChannel;
let lastKnownEmail = '';
const promptedSessions = new Set();

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

function getProfileEntry(profiles, email) {
    if (!email) return null;
    const wanted = email.toLowerCase();
    return Object.values(profiles).find(profile => profile.email && profile.email.toLowerCase() === wanted) || null;
}

async function getActiveAccountInfo() {
    const session = tokenManager.detectActiveSession();
    const profiles = tokenManager.loadProfiles();
    const matched = getProfileEntry(profiles, session.email);

    return {
        isActive: session.isActive && Boolean(session.email),
        hasToken: session.hasToken,
        needsEmail: session.needsEmail,
        email: session.email || '',
        source: session.source || '',
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

        if (info.isActive && info.email) {
            const displayLabel = info.label || info.email.split('@')[0];
            statusBarItem.text = `$(account) [${displayLabel}] ${info.email}`;
            tooltip.push(
                `* **Active account:** \`${safeMarkdown(info.email)}\``,
                `* **Profile label:** \`${safeMarkdown(displayLabel)}\``,
                `* **Vault status:** ${info.isSaved ? 'Saved' : 'Not saved yet'}`,
                `* **Token source:** \`${safeMarkdown(info.source)}\``,
                '',
                '*(Click to switch accounts, add a new one, or rename the profile)*'
            );
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

        if (savedList.length > 0) {
            items.push({ label: 'GOOGLE ACCOUNTS (SAVED IN VAULT)', kind: vscode.QuickPickItemKind.Separator });
            for (const profile of savedList) {
                const isActive = Boolean(activeInfo.email && profile.email.toLowerCase() === activeInfo.email.toLowerCase());
                items.push({
                    label: isActive ? `$(check) [${profile.label}] ${profile.email}` : `$(account) [${profile.label}] ${profile.email}`,
                    description: isActive ? 'Active Now' : 'Click to Switch',
                    detail: profile.saved_at
                        ? `Saved on: ${profile.saved_at.slice(0, 19).replace('T', ' ')}`
                        : 'Saved profile',
                    accountEmail: profile.email,
                    accountLabel: profile.label,
                    isActive,
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

    const hasDbTokens = Object.keys(profile.db_tokens || {}).length > 0;
    const hasFileTokens = Boolean(profile.file_tokens && (
        profile.file_tokens.cliToken || profile.file_tokens.standaloneToken || profile.file_tokens.oauthCreds
    ));

    const details = [
        'Antigravity IDE will reload to apply this account to the IDE, Antigravity Desktop and the CLI.',
        'Please save all open files before continuing.'
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

    try {
        const result = tokenManager.restoreProfile(profile);
        log(`Switched to ${profile.email}. DB written: ${result.db.written.length}; files written: ${result.files.written.length}; files removed: ${result.files.removed.length}.`);
        if (result.db.skipped) {
            log('No Antigravity database was found; database state was left unchanged.');
            vscode.window.showWarningMessage('Account files were switched, but no Antigravity database was found. The database state was left unchanged.');
        }
        await updateStatusBar();
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
        logError(`Failed to switch to ${profile.email}`, error);
        vscode.window.showErrorMessage(`Failed to switch account: ${error.message || error}`);
    }
}

async function saveOrRenameAccount(email, currentLabel) {
    const session = tokenManager.detectActiveSession();
    if (!session.hasToken) {
        vscode.window.showErrorMessage('No active Antigravity session was detected. Sign in before saving a profile.');
        return;
    }
    if (!session.email) {
        await manualRegisterAccount();
        return;
    }
    if (email && email.toLowerCase() !== session.email.toLowerCase()) {
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

    try {
        tokenManager.snapshotActiveAccount(newLabel.trim(), session.email);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account ${session.email} saved as "[${newLabel.trim()}]".`);
    } catch (error) {
        logError('Failed to save the active account', error);
        vscode.window.showErrorMessage(`Failed to save account: ${error.message || error}`);
    }
}

async function manualRegisterAccount() {
    const session = tokenManager.detectActiveSession();
    if (!session.hasToken) {
        vscode.window.showErrorMessage('No active OAuth token was found. Sign in before registering an account.');
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

    try {
        tokenManager.snapshotActiveAccount(cleanLabel, cleanEmail);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account ${cleanEmail} registered as "[${cleanLabel}]".`);
    } catch (error) {
        logError('Failed to register the account', error);
        vscode.window.showErrorMessage(`Failed to register account: ${error.message || error}`);
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

    const before = tokenManager.detectActiveSession();
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
                    const current = tokenManager.detectActiveSession();
                    const changed = current.hasToken && (
                        !before.hasToken ||
                        current.email !== before.email ||
                        current.source !== before.source
                    );
                    if (changed) return;
                    await tokenManager.delay(500);
                }
            }
        );
    } catch (error) {
        logError('Google sign-in command failed', error);
        vscode.window.showErrorMessage(`Google Sign-In failed or was cancelled: ${error.message || error}`);
        return;
    }

    const session = tokenManager.detectActiveSession();
    if (!session.hasToken) {
        vscode.window.showWarningMessage('Sign-in was not detected yet. Finish the flow in your browser and then use "Save Active Account".');
        return;
    }
    if (!session.email) {
        await manualRegisterAccount();
        return;
    }

    const choice = await vscode.window.showInformationMessage(
        `Signed in as ${session.email}.`,
        'Save Profile & Reload',
        'Reload',
        'Later'
    );
    if (choice === 'Save Profile & Reload') {
        const label = await vscode.window.showInputBox({
            prompt: `Friendly label for ${session.email}:`,
            value: session.email.split('@')[0],
            ignoreFocusOut: true
        });
        if (label && label.trim()) {
            try {
                tokenManager.snapshotActiveAccount(label.trim(), session.email);
            } catch (error) {
                logError('Failed to save the new profile', error);
                vscode.window.showErrorMessage(`Signed in, but the profile could not be saved: ${error.message || error}`);
                return;
            }
        }
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } else if (choice === 'Reload') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
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

    try {
        tokenManager.clearAllSessionTokens();
        try {
            await vscode.commands.executeCommand('antigravity.internal.logout');
        } catch {}
        await updateStatusBar();
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
        logError('Logout failed', error);
        vscode.window.showErrorMessage(`Log out failed: ${error.message || error}`);
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

    try {
        tokenManager.saveProfiles({});
        tokenManager.clearAllSessionTokens();
        try {
            await vscode.commands.executeCommand('antigravity.internal.logout');
        } catch {}
        promptedSessions.clear();
        await updateStatusBar();
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
        logError('Failed to clear switcher data', error);
        vscode.window.showErrorMessage(`Clear failed: ${error.message || error}`);
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

async function checkAndPromptNewAccountOnStartup() {
    try {
        const info = await getActiveAccountInfo();

        if (info.vaultWarnings.length > 0) {
            log(`Vault warnings: ${info.vaultWarnings.join(' | ')}`);
        }

        if (info.hasToken && info.needsEmail) {
            if (promptedSessions.has('needs-email')) return;
            promptedSessions.add('needs-email');
            const choice = await vscode.window.showWarningMessage(
                'Antigravity Account Switcher: an OAuth session is active, but its email could not be detected.',
                'Register Email',
                'Later'
            );
            if (choice === 'Register Email') await manualRegisterAccount();
            return;
        }

        if (!info.email || info.isSaved) return;
        const key = info.email.toLowerCase();
        if (promptedSessions.has(key)) return;
        promptedSessions.add(key);

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

function setupTokenFileWatchers(context) {
    const paths = tokenManager.getTokenFilePaths();
    const directories = new Set(tokenManager.getGeminiDirs());
    for (const list of Object.values(paths)) {
        for (const tokenPath of list) directories.add(path.dirname(tokenPath));
    }

    let timer = null;
    for (const directory of directories) {
        try {
            if (!fs.existsSync(directory)) continue;
            const watcher = fs.watch(directory, () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = null;
                    void (async () => {
                        try {
                            const session = tokenManager.detectActiveSession();
                            const email = session.email ? session.email.toLowerCase() : '';
                            const previousEmail = lastKnownEmail;
                            await updateStatusBar();
                            if (email && email !== previousEmail) {
                                log(`Detected a new session: ${session.email}`);
                                await checkAndPromptNewAccountOnStartup();
                            }
                        } catch (error) {
                            logError('Token watcher failed', error);
                        }
                    })();
                }, 750);
            });
            context.subscriptions.push({ dispose: () => { try { watcher.close(); } catch {} } });
        } catch (error) {
            logError(`Could not watch ${directory}`, error);
        }
    }
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
        vscode.commands.registerCommand('antigravity-account-switcher.diagnostics', showDiagnostics)
    );

    void updateStatusBar();
    setupTokenFileWatchers(context);

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(state => {
            if (!state.focused) return;
            void updateStatusBar();
            void checkAndPromptNewAccountOnStartup();
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
