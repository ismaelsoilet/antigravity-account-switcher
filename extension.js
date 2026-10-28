const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

let statusBarItem;

const AUTH_KEYS = [
    'antigravityUnifiedStateSync.oauthToken',
    'antigravityUnifiedStateSync.userStatus',
    'antigravityUnifiedStateSync.modelCredits',
    'antigravityAuthStatus',
    'google.google-antigravity'
];

let DatabaseSync;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
    DatabaseSync = null;
}

function getHomeDir() {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function getProfilesFilePath() {
    return path.join(getHomeDir(), '.gemini', 'antigravity_profiles.json');
}

function getDbPaths() {
    const paths = [
        '/mnt/c/Users/Ismael/AppData/Roaming/Antigravity IDE/User/globalStorage/state.vscdb',
        '/mnt/c/Users/Ismael/AppData/Roaming/Antigravity/User/globalStorage/state.vscdb'
    ];
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(getHomeDir(), 'AppData', 'Roaming');
        paths.push(path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
        paths.push(path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
    }
    return [...new Set(paths.filter(p => fs.existsSync(p)))];
}

function loadProfiles() {
    const targets = [
        path.join(getHomeDir(), '.gemini', 'antigravity_profiles.json'),
        '/mnt/c/Users/Ismael/.gemini/antigravity_profiles.json',
        '/home/ismaelsoilet/.gemini/antigravity_profiles.json'
    ];
    if (process.platform === 'win32') {
        targets.push('C:\\Users\\Ismael\\.gemini\\antigravity_profiles.json');
    }

    for (const p of [...new Set(targets)]) {
        if (fs.existsSync(p)) {
            try {
                const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
                const clean = {};
                for (const [k, v] of Object.entries(raw)) {
                    const em = v.email || k;
                    if (em && em.includes('@')) {
                        clean[em] = {
                            email: em,
                            label: v.label || v.name || em.split('@')[0],
                            saved_at: v.saved_at || '',
                            tokens: v.tokens || {}
                        };
                    }
                }
                if (Object.keys(clean).length > 0) {
                    return clean;
                }
            } catch {}
        }
    }
    return {};
}

function saveProfiles(profiles) {
    const targets = [
        path.join(getHomeDir(), '.gemini', 'antigravity_profiles.json'),
        '/mnt/c/Users/Ismael/.gemini/antigravity_profiles.json',
        '/home/ismaelsoilet/.gemini/antigravity_profiles.json'
    ];
    if (process.platform === 'win32') {
        targets.push('C:\\Users\\Ismael\\.gemini\\antigravity_profiles.json');
    }

    for (const p of [...new Set(targets)]) {
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(profiles, null, 2), 'utf-8');
        } catch {}
    }
}

function extractEmail(tokens) {
    if (!tokens) return '';
    const raw = tokens['google.google-antigravity'];
    if (raw) {
        try {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const storage = data['antigravity-storage'];
            if (storage && storage['jetski.onboarding.lastLoginUsername']) {
                const em = storage['jetski.onboarding.lastLoginUsername'];
                if (em && em.includes('@')) {
                    return em.trim();
                }
            }
        } catch {}
    }
    // Check antigravityAuthStatus JSON
    const authStatus = tokens['antigravityAuthStatus'];
    if (authStatus) {
        try {
            const data = typeof authStatus === 'string' ? JSON.parse(authStatus) : authStatus;
            if (data && data.email && data.email.includes('@')) {
                return data.email.trim();
            }
        } catch {}
    }
    // Fallback: search any token value for a user email
    for (const val of Object.values(tokens)) {
        if (typeof val === 'string') {
            const matches = val.match(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g);
            if (matches) {
                for (const em of matches) {
                    if (!em.includes('gserviceaccount.com') && !em.includes('googleapis.com')) {
                        return em.trim();
                    }
                }
            }
        }
    }
    return '';
}

function readCurrentTokens() {
    const dbs = getDbPaths();
    if (dbs.length === 0) return {};

    const tokens = {};
    if (DatabaseSync) {
        for (const dbPath of dbs) {
            try {
                const db = new DatabaseSync(dbPath, { readOnly: true });
                const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
                for (const k of AUTH_KEYS) {
                    if (!tokens[k]) {
                        const row = stmt.get(k);
                        if (row && row.value !== undefined) {
                            tokens[k] = row.value;
                        }
                    }
                }
                db.close();
            } catch (e) {
                console.warn(`DatabaseSync read error for ${dbPath}:`, e);
            }
        }
    }
    return tokens;
}

function writeTokensToDbs(tokens) {
    const dbs = getDbPaths();
    for (const dbPath of dbs) {
        if (DatabaseSync) {
            try {
                const db = new DatabaseSync(dbPath);
                const stmt = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
                for (const [k, v] of Object.entries(tokens)) {
                    if (v !== undefined && v !== null) {
                        stmt.run(k, String(v));
                    }
                }
                db.close();
            } catch (e) {
                console.error(`DatabaseSync write error for ${dbPath}:`, e);
            }
        }
    }
}

async function getActiveAccountInfo() {
    const tokens = readCurrentTokens();
    const email = extractEmail(tokens);
    const profiles = loadProfiles();

    let matched = null;
    if (email && profiles[email]) {
        matched = profiles[email];
    } else {
        const currOauth = tokens['antigravityUnifiedStateSync.oauthToken'];
        for (const p of Object.values(profiles)) {
            if (currOauth && p.tokens && p.tokens['antigravityUnifiedStateSync.oauthToken'] === currOauth) {
                matched = p;
                break;
            }
        }
    }

    const label = matched ? matched.label : (email ? email.split('@')[0] : 'Unsaved');
    return {
        email: email,
        label: label,
        isSaved: !!matched,
        tokens: tokens
    };
}

async function updateStatusBar() {
    try {
        const info = await getActiveAccountInfo();
        const displayLabel = info.label || 'Account';
        const displayEmail = info.email ? ` ${info.email}` : '';

        statusBarItem.text = `$(account) [${displayLabel}]${displayEmail}`;
        statusBarItem.tooltip = new vscode.MarkdownString(
            `### Antigravity Account Switcher\n` +
            `* **Active Account:** \`${info.email || 'None'}\`\n` +
            `* **Profile Label:** \`${displayLabel}\`\n` +
            `* **Vault Status:** ${info.isSaved ? '✅ Saved in Vault' : '⚠️ Unsaved Session'}\n` +
            `* **Environment:** Synced across IDE, Desktop 2.0 & CLI\n\n` +
            `*(Click to switch accounts, add new, or rename profile)*`
        );
        statusBarItem.show();
    } catch {
        statusBarItem.text = `$(account) Antigravity`;
        statusBarItem.tooltip = `Click to switch Antigravity accounts`;
        statusBarItem.show();
    }
}

async function showAccountSwitcherMenu() {
    try {
        const activeInfo = await getActiveAccountInfo();
        const profiles = loadProfiles();
        const items = [];

        // 1. Saved Accounts Section
        const savedList = Object.values(profiles);
        if (savedList.length > 0) {
            items.push({ label: 'GOOGLE ACCOUNTS (SAVED)', kind: vscode.QuickPickItemKind.Separator });
            for (const p of savedList) {
                const isActive = (activeInfo.email && p.email.toLowerCase() === activeInfo.email.toLowerCase());
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
            label: '$(add) Add / Sign In to Another Google Account...',
            detail: 'Opens browser for Google OAuth. Once complete, automatically reloads and saves.',
            action: 'login'
        });

        if (!activeInfo.isSaved && activeInfo.email) {
            items.push({
                label: `$(save) Save Current Account (${activeInfo.email})...`,
                detail: 'Save this active account to your switcher vault with a custom label',
                action: 'save'
            });
        } else if (activeInfo.isSaved) {
            items.push({
                label: `$(edit) Rename Profile Label for ${activeInfo.email}...`,
                detail: `Currently labeled as "[${activeInfo.label}]"`,
                action: 'rename'
            });
        }

        if (savedList.length > 0) {
            items.push({
                label: '$(trash) Remove an Account from Switcher...',
                detail: 'Delete an account profile from local storage',
                action: 'delete'
            });
        }

        items.push({
            label: '$(refresh) Reload Window',
            detail: 'Reload Antigravity IDE to refresh session and extensions',
            action: 'reload'
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Currently Active: [${activeInfo.label}] ${activeInfo.email || 'None'}`,
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
        } else if (selected.action === 'login') {
            await loginNewAccount();
        } else if (selected.action === 'delete') {
            await deleteAccount(savedList);
        } else if (selected.action === 'reload') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Account Switcher Error: ${err.message || err}`);
    }
}

async function switchAccount(email, label) {
    const confirm = await vscode.window.showWarningMessage(
        `Switch to account "[${label}] ${email}"?`,
        {
            modal: true,
            detail: `Antigravity IDE will immediately reload to apply this account across the IDE, Antigravity 2.0 Desktop, and the CLI.\n\nPlease save all open files before proceeding.`
        },
        'Switch & Reload',
        'Cancel'
    );

    if (confirm !== 'Switch & Reload') return;

    try {
        const profiles = loadProfiles();
        const target = profiles[email];
        if (!target || !target.tokens) {
            throw new Error(`Account '${email}' has no saved credentials.`);
        }

        writeTokensToDbs(target.tokens);

        // Notify language server client to reset session
        try {
            await vscode.commands.executeCommand('antigravity.internal.logout');
        } catch {}

        await updateStatusBar();

        vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to switch account: ${err.message || err}`);
    }
}

async function saveOrRenameAccount(email, currentLabel) {
    const tokens = readCurrentTokens();
    const actualEmail = email || extractEmail(tokens);

    if (!actualEmail) {
        vscode.window.showErrorMessage('No active Google Account detected to save.');
        return;
    }

    const defaultVal = currentLabel && currentLabel !== 'Unsaved' ? currentLabel : actualEmail.split('@')[0];
    const newLabel = await vscode.window.showInputBox({
        prompt: `Enter a friendly label for ${actualEmail} (e.g. Personal, Work, Secondary):`,
        value: defaultVal,
        ignoreFocusOut: true
    });

    if (!newLabel || !newLabel.trim()) return;

    try {
        const profiles = loadProfiles();
        profiles[actualEmail] = {
            email: actualEmail,
            label: newLabel.trim(),
            saved_at: new Date().toISOString(),
            tokens: tokens
        };
        saveProfiles(profiles);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account ${actualEmail} saved as "[${newLabel.trim()}]"!`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to save account: ${err.message || err}`);
    }
}

async function loginNewAccount() {
    const proceed = await vscode.window.showInformationMessage(
        'Connect Another Google Account',
        {
            modal: true,
            detail: 'This will launch your browser for Google OAuth.\n\nComplete the sign-in in your browser. Once authenticated, Antigravity IDE will automatically reload into the new session and prompt you to name this profile.'
        },
        'Open Browser & Sign In',
        'Cancel'
    );

    if (proceed !== 'Open Browser & Sign In') return;

    try {
        // Run Google OAuth login with progress indicator
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

        // Once the OAuth promise resolves, login has succeeded!
        vscode.window.showInformationMessage(
            'Google authentication successful! Reloading Antigravity IDE to activate the new account...',
            'Reload Now'
        );

        // Immediate reload to flush and load new credentials
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
        vscode.window.showErrorMessage(`Google Sign-In failed or was cancelled: ${err.message || err}`);
    }
}

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
        const profiles = loadProfiles();
        delete profiles[selected.accountEmail];
        saveProfiles(profiles);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account ${selected.accountEmail} removed.`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to remove account: ${err.message || err}`);
    }
}

async function checkAndPromptNewAccountOnStartup() {
    // Check if the currently active account on startup is not yet in the vault
    try {
        const info = await getActiveAccountInfo();
        if (info.email && !info.isSaved) {
            const choice = await vscode.window.showInformationMessage(
                `Antigravity Account Switcher: New active account detected (${info.email})! Save it to your vault?`,
                'Save Account',
                'Later'
            );
            if (choice === 'Save Account') {
                await saveOrRenameAccount(info.email, '');
            }
        }
    } catch {}
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

    // Update status bar and check for new logins when IDE window gains focus
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(e => {
            if (e.focused) {
                updateStatusBar();
                checkAndPromptNewAccountOnStartup();
            }
        })
    );

    // Check on startup if current account is newly logged in
    setTimeout(checkAndPromptNewAccountOnStartup, 1500);
    setTimeout(checkAndPromptNewAccountOnStartup, 4500);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
