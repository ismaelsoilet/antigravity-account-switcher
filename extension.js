const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const tokenManager = require('./tokenManager');

let statusBarItem;
let lastKnownEmail = '';

/**
 * Get active account information for UI and menus
 */
async function getActiveAccountInfo() {
    const email = tokenManager.detectActiveEmail();
    const profiles = tokenManager.loadProfiles();

    let matched = null;
    if (email && profiles[email]) {
        matched = profiles[email];
    }

    return {
        isActive: Boolean(email),
        email: email || '',
        label: matched ? matched.label : (email ? email.split('@')[0] : 'No Account'),
        isSaved: Boolean(matched)
    };
}

/**
 * Update the status bar item with the current account status
 */
async function updateStatusBar() {
    try {
        const info = await getActiveAccountInfo();
        lastKnownEmail = info.email;

        if (info.isActive && info.email) {
            const displayLabel = info.label || info.email.split('@')[0];
            statusBarItem.text = `$(account) [${displayLabel}] ${info.email}`;
            statusBarItem.tooltip = new vscode.MarkdownString(
                `### Antigravity Account Switcher\n` +
                `* **Active Account:** \`${info.email}\`\n` +
                `* **Profile Label:** \`${displayLabel}\`\n` +
                `* **Vault Status:** ${info.isSaved ? '✅ Saved in Vault' : '⚠️ Unsaved Session'}\n` +
                `* **Storage:** Synced across IDE, Antigravity 2.0 & CLI\n\n` +
                `*(Click to switch accounts, add new, or rename profile)*`
            );
        } else {
            statusBarItem.text = `$(account) [No Account] Sign In`;
            statusBarItem.tooltip = new vscode.MarkdownString(
                `### Antigravity Account Switcher\n` +
                `* **Status:** No Active Google Account Detected (Signed Out)\n\n` +
                `*(Click to sign in with Google, select a saved profile, or register account)*`
            );
        }
        statusBarItem.show();
    } catch {
        statusBarItem.text = `$(account) [No Account]`;
        statusBarItem.tooltip = `Click to connect Google account`;
        statusBarItem.show();
    }
}

/**
 * Show the account switcher QuickPick menu
 */
async function showAccountSwitcherMenu() {
    try {
        const activeInfo = await getActiveAccountInfo();
        const profiles = tokenManager.loadProfiles();
        const items = [];

        // 1. Saved Accounts Section
        const savedList = Object.values(profiles);
        if (savedList.length > 0) {
            items.push({ label: 'GOOGLE ACCOUNTS (SAVED IN VAULT)', kind: vscode.QuickPickItemKind.Separator });
            for (const p of savedList) {
                const isActive = activeInfo.isActive && (activeInfo.email && p.email.toLowerCase() === activeInfo.email.toLowerCase());
                items.push({
                    label: isActive ? `$(check) [${p.label}] ${p.email}` : `$(account) [${p.label}] ${p.email}`,
                    description: isActive ? 'Active Now' : 'Click to Switch',
                    detail: `Saved on: ${(p.saved_at || '').slice(0, 19).replace('T', ' ')}`,
                    accountEmail: p.email,
                    accountLabel: p.label,
                    isActive,
                    action: 'switch'
                });
            }
        }

        // 2. Account Actions Section
        items.push({ label: 'ACCOUNT ACTIONS', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(add) Connect / Sign In to Google Account...',
            detail: 'Opens browser for Google OAuth. Once complete, automatically reloads into new session.',
            action: 'login'
        });

        if (activeInfo.isActive && activeInfo.email) {
            if (!activeInfo.isSaved) {
                items.push({
                    label: `$(save) Save Active Account (${activeInfo.email})...`,
                    detail: 'Save this active session to your switcher vault with a custom label',
                    action: 'save'
                });
            } else {
                items.push({
                    label: `$(edit) Rename Profile Label for ${activeInfo.email}...`,
                    detail: `Currently labeled as "[${activeInfo.label}]"`,
                    action: 'rename'
                });
            }

            items.push({
                label: '$(sign-out) Log Out Current Account...',
                detail: 'Disconnect current session from Antigravity IDE and Desktop 2.0',
                action: 'logout'
            });
        } else {
            // Always allow manual registration so the user is NEVER blocked from saving
            items.push({
                label: '$(save) Save / Register Active Account Manually...',
                detail: 'If you are already logged in, enter your Google email to register and snapshot this profile',
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

        items.push({
            label: '$(clear-all) Reset / Clear All Switcher Data...',
            detail: 'Clear all saved profiles and session tokens for a fresh start',
            action: 'clear_all'
        });

        items.push({
            label: '$(refresh) Reload Window',
            detail: 'Reload Antigravity IDE to refresh session and extensions',
            action: 'reload'
        });

        const currentActiveDesc = (activeInfo.isActive && activeInfo.email)
            ? `[${activeInfo.label}] ${activeInfo.email}`
            : 'No Account (Signed Out)';

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Currently Active: ${currentActiveDesc}`,
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
        } else if (selected.action === 'clear_all') {
            await clearAllData();
        } else if (selected.action === 'reload') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Account Switcher Error: ${err.message || err}`);
    }
}

/**
 * Switch account: restores DB tokens & token files, then reloads window
 */
async function switchAccount(email, label) {
    const confirm = await vscode.window.showWarningMessage(
        `Switch to account "[${label}] ${email}"?`,
        {
            modal: true,
            detail: `Antigravity IDE will immediately reload to apply this account across the IDE, Antigravity 2.0 Desktop, and CLI tools.\n\nPlease save all open files before proceeding.`
        },
        'Switch & Reload',
        'Cancel'
    );

    if (confirm !== 'Switch & Reload') return;

    try {
        const profiles = tokenManager.loadProfiles();
        const target = profiles[email];
        if (!target) {
            throw new Error(`Account '${email}' not found in saved vault.`);
        }

        // Restore all tokens across SQLite DBs and OAuth files
        tokenManager.restoreProfile(target);

        // DO NOT call antigravity.internal.logout here!
        await updateStatusBar();

        // Reload window to let IDE and language server read restored tokens
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to switch account: ${err.message || err}`);
    }
}

/**
 * Save active account or rename its friendly label
 */
async function saveOrRenameAccount(email, currentLabel) {
    let activeEmail = email || tokenManager.detectActiveEmail();

    if (!activeEmail) {
        return manualRegisterAccount();
    }

    const defaultVal = currentLabel && currentLabel !== 'Unsaved' ? currentLabel : activeEmail.split('@')[0];
    const newLabel = await vscode.window.showInputBox({
        prompt: `Enter a friendly label for ${activeEmail} (e.g. Personal, Work, Secondary):`,
        value: defaultVal,
        ignoreFocusOut: true
    });

    if (!newLabel || !newLabel.trim()) return;

    try {
        tokenManager.snapshotActiveAccount(newLabel.trim(), activeEmail);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account ${activeEmail} saved as "[${newLabel.trim()}]"!`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to save account: ${err.message || err}`);
    }
}

/**
 * Manual registration fallback: asks user for email and label, then snapshots session
 */
async function manualRegisterAccount() {
    const detected = tokenManager.detectActiveEmail();
    const emailInput = await vscode.window.showInputBox({
        prompt: 'Enter the Google Account email currently signed in:',
        placeHolder: 'user@gmail.com',
        value: detected || '',
        ignoreFocusOut: true,
        validateInput: val => {
            if (!val || !tokenManager.isValidEmail(val)) {
                return 'Please enter a valid email address (e.g. name@domain.com)';
            }
            return null;
        }
    });

    if (!emailInput || !emailInput.trim()) return;
    const cleanEmail = emailInput.trim();

    const labelInput = await vscode.window.showInputBox({
        prompt: `Enter a friendly label for ${cleanEmail} (e.g. Personal, Work):`,
        value: cleanEmail.split('@')[0],
        ignoreFocusOut: true
    });

    const cleanLabel = (labelInput && labelInput.trim()) || cleanEmail.split('@')[0];

    try {
        tokenManager.snapshotActiveAccount(cleanLabel, cleanEmail);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account ${cleanEmail} registered and saved as "[${cleanLabel}]"!`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to register account: ${err.message || err}`);
    }
}

/**
 * Connect a new Google Account via OAuth login
 */
async function loginNewAccount() {
    const proceed = await vscode.window.showInformationMessage(
        'Connect Google Account',
        {
            modal: true,
            detail: 'This will launch your browser for Google OAuth sign-in.\n\nOnce completed in your browser, Antigravity IDE will automatically reload into the new session and prompt you to name the profile.'
        },
        'Open Browser & Sign In',
        'Cancel'
    );

    if (proceed !== 'Open Browser & Sign In') return;

    try {
        const preLoginEmail = tokenManager.detectActiveEmail();

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Antigravity: Complete Google Sign-In in your browser window...',
                cancellable: false
            },
            async () => {
                await vscode.commands.executeCommand('antigravity.internal.loginWithRedirect');
            }
        );

        const postLoginEmail = tokenManager.detectActiveEmail();
        const successMessage = postLoginEmail && postLoginEmail !== preLoginEmail
            ? `Google authentication successful for ${postLoginEmail}! Reloading Antigravity IDE...`
            : 'Google authentication successful! Reloading Antigravity IDE...';

        vscode.window.showInformationMessage(successMessage, 'Reload Now');
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
        vscode.window.showErrorMessage(`Google Sign-In failed or was cancelled: ${err.message || err}`);
    }
}

/**
 * Log out of current Google Account
 */
async function logoutAccount() {
    const confirm = await vscode.window.showWarningMessage(
        'Log out of the current Google Account session?',
        { modal: true, detail: 'This will clear all session credentials and reset the language server.' },
        'Log Out',
        'Cancel'
    );
    if (confirm !== 'Log Out') return;

    try {
        tokenManager.clearAllSessionTokens();

        try {
            await vscode.commands.executeCommand('antigravity.internal.logout');
        } catch {}

        await updateStatusBar();
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
        vscode.window.showErrorMessage(`Log out failed: ${err.message || err}`);
    }
}

/**
 * Factory reset: clear all saved profiles and session tokens
 */
async function clearAllData() {
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to clear all accounts and switcher data?',
        {
            modal: true,
            detail: 'This will wipe all saved vault profiles and log out completely so you can start fresh.'
        },
        'Clear Everything',
        'Cancel'
    );
    if (confirm !== 'Clear Everything') return;

    try {
        tokenManager.saveProfiles({});
        tokenManager.clearAllSessionTokens();

        try {
            await vscode.commands.executeCommand('antigravity.internal.logout');
        } catch {}

        await updateStatusBar();
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
        vscode.window.showErrorMessage(`Clear failed: ${err.message || err}`);
    }
}

/**
 * Delete a single account from the vault
 */
async function deleteAccount(savedList) {
    const items = savedList.map(p => ({
        label: `[${p.label}] ${p.email}`,
        accountEmail: p.email,
        detail: `Saved: ${(p.saved_at || '').slice(0, 10)}`
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an account to remove from saved vault...',
        title: 'Remove Saved Account'
    });

    if (!selected) return;

    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove ${selected.accountEmail} from the switcher?`,
        { modal: true },
        'Delete',
        'Cancel'
    );

    if (confirm !== 'Delete') return;

    try {
        const profiles = tokenManager.loadProfiles();
        delete profiles[selected.accountEmail];
        tokenManager.saveProfiles(profiles);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account ${selected.accountEmail} removed.`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to remove account: ${err.message || err}`);
    }
}

/**
 * Check on startup if current active account is unsaved and prompt user
 */
async function checkAndPromptNewAccountOnStartup() {
    try {
        const info = await getActiveAccountInfo();
        if (info.email && !info.isSaved) {
            const choice = await vscode.window.showInformationMessage(
                `Antigravity Account Switcher: Active account detected (${info.email})! Save it to your vault?`,
                'Save Account',
                'Later'
            );
            if (choice === 'Save Account') {
                await saveOrRenameAccount(info.email, '');
            }
        }
    } catch {}
}

/**
 * Start watching token files for login changes
 */
function setupTokenFileWatchers(context) {
    const tokenPaths = tokenManager.getTokenFilePaths();
    const watchedDirs = new Set();

    for (const p of tokenPaths.cliToken) {
        try {
            const dir = path.dirname(p);
            if (fs.existsSync(dir)) watchedDirs.add(dir);
        } catch {}
    }

    for (const dir of watchedDirs) {
        try {
            const watcher = fs.watch(dir, (eventType, filename) => {
                if (filename && filename.includes('token')) {
                    const currentEmail = tokenManager.detectActiveEmail();
                    if (currentEmail && currentEmail !== lastKnownEmail) {
                        updateStatusBar();
                        checkAndPromptNewAccountOnStartup();
                    }
                }
            });
            context.subscriptions.push({ dispose: () => watcher.close() });
        } catch {}
    }
}

function activate(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravity-account-switcher.switch';
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-account-switcher.switch', showAccountSwitcherMenu)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-account-switcher.save', () => saveOrRenameAccount('', ''))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-account-switcher.login', loginNewAccount)
    );

    updateStatusBar();
    setupTokenFileWatchers(context);

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(e => {
            if (e.focused) {
                updateStatusBar();
                checkAndPromptNewAccountOnStartup();
            }
        })
    );

    setTimeout(checkAndPromptNewAccountOnStartup, 1500);
    setTimeout(checkAndPromptNewAccountOnStartup, 4500);
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
