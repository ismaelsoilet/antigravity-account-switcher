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
    const paths = [];
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(getHomeDir(), 'AppData', 'Roaming');
        paths.push(path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
        paths.push(path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
    } else {
        const winAppData = '/mnt/c/Users/Ismael/AppData/Roaming';
        paths.push(path.join(winAppData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
        paths.push(path.join(winAppData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
    }
    return paths.filter(p => fs.existsSync(p));
}

function loadProfiles() {
    const p = getProfilesFilePath();
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
            return clean;
        } catch {}
    }
    return {};
}

function saveProfiles(profiles) {
    const targets = [
        getProfilesFilePath(),
        // Also sync to WSL home if running on Windows
        process.platform === 'win32' ? path.join(getHomeDir(), '.gemini', 'antigravity_profiles.json') : '/mnt/c/Users/Ismael/.gemini/antigravity_profiles.json'
    ];

    for (const p of targets) {
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(profiles, null, 2), 'utf-8');
        } catch {}
    }
}

function extractEmail(tokens) {
    const raw = tokens['google.google-antigravity'];
    if (raw) {
        try {
            const data = JSON.parse(raw);
            const storage = data['antigravity-storage'];
            if (storage && storage['jetski.onboarding.lastLoginUsername']) {
                const em = storage['jetski.onboarding.lastLoginUsername'];
                if (em && em.includes('@')) {
                    return em;
                }
            }
        } catch {}
    }
    return '';
}

function readCurrentTokens() {
    const dbs = getDbPaths();
    if (dbs.length === 0) return {};

    const primaryDb = dbs[0];
    const tokens = {};

    if (DatabaseSync) {
        try {
            const db = new DatabaseSync(primaryDb, { readOnly: true });
            const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
            for (const k of AUTH_KEYS) {
                const row = stmt.get(k);
                if (row && row.value !== undefined) {
                    tokens[k] = row.value;
                }
            }
            db.close();
            return tokens;
        } catch (e) {
            console.warn('DatabaseSync read error:', e);
        }
    }
    return {};
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
            `* **Status:** Connected & Synced (IDE, Desktop 2.0 & CLI)\n\n` +
            `*(Click to switch accounts or manage profiles)*`
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

        // 1. Saved Accounts
        const savedList = Object.values(profiles);
        if (savedList.length > 0) {
            items.push({ label: 'GOOGLE ACCOUNTS (SAVED)', kind: vscode.QuickPickItemKind.Separator });
            for (const p of savedList) {
                const isActive = (activeInfo.email && p.email === activeInfo.email);
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

        // 2. Account Actions
        items.push({ label: 'ACCOUNT ACTIONS', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(add) Add / Sign In to Another Google Account...',
            detail: 'Opens browser for Google OAuth. Automatically captures new account and reloads.',
            action: 'login'
        });

        if (!activeInfo.isSaved && activeInfo.email) {
            items.push({
                label: `$(save) Save Active Account (${activeInfo.email})...`,
                detail: 'Save this currently logged-in account to the switcher vault',
                action: 'save'
            });
        } else if (activeInfo.isSaved) {
            items.push({
                label: `$(edit) Rename Profile Label for ${activeInfo.email}...`,
                detail: `Currently labeled as "${activeInfo.label}"`,
                action: 'rename'
            });
        }

        if (savedList.length > 0) {
            items.push({
                label: '$(trash) Remove Saved Account from Switcher...',
                detail: 'Delete an account from saved vault',
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
            await loginNewAccount(activeInfo.email);
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
        prompt: `Enter friendly label for ${actualEmail} (e.g. Personal, Work, Client):`,
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

async function loginNewAccount(currentEmail) {
    const proceed = await vscode.window.showInformationMessage(
        'Connect Another Google Account',
        {
            modal: true,
            detail: 'This will launch your browser for Google OAuth.\n\nOnce sign-in succeeds, Antigravity IDE will automatically detect your new email, save it to the switcher vault, and reload into the new session.'
        },
        'Proceed to Sign In',
        'Cancel'
    );

    if (proceed !== 'Proceed to Sign In') return;

    const initialTokens = readCurrentTokens();
    const initialOauth = initialTokens['antigravityUnifiedStateSync.oauthToken'] || '';

    try {
        vscode.commands.executeCommand('antigravity.internal.loginWithRedirect');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to launch Google Sign-In: ${err.message || err}`);
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Waiting for Google Sign-In in browser...',
            cancellable: true
        },
        async (progress, token) => {
            const startTime = Date.now();
            const timeout = 120000;

            while (Date.now() - startTime < timeout) {
                if (token.isCancellationRequested) return;

                await new Promise(r => setTimeout(r, 2000));

                try {
                    const latestTokens = readCurrentTokens();
                    const newOauth = latestTokens['antigravityUnifiedStateSync.oauthToken'] || '';
                    const newEmail = extractEmail(latestTokens);

                    if (newOauth && newOauth !== initialOauth) {
                        progress.report({ message: `Authenticated as ${newEmail || 'new account'}!` });

                        const defaultLabel = newEmail ? newEmail.split('@')[0] : 'Work';
                        const enteredLabel = await vscode.window.showInputBox({
                            prompt: `Google Sign-in successful for ${newEmail}! Enter a label for this profile:`,
                            value: defaultLabel,
                            ignoreFocusOut: true
                        });

                        const finalLabel = (enteredLabel && enteredLabel.trim()) ? enteredLabel.trim() : defaultLabel;
                        const profiles = loadProfiles();
                        profiles[newEmail] = {
                            email: newEmail,
                            label: finalLabel,
                            saved_at: new Date().toISOString(),
                            tokens: latestTokens
                        };
                        saveProfiles(profiles);

                        await vscode.window.showInformationMessage(
                            `Account [${finalLabel}] ${newEmail} saved! Reloading Antigravity IDE...`
                        );

                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                        return;
                    }
                } catch {}
            }

            vscode.window.showWarningMessage('Sign-in wait timed out. If you signed in successfully, click the status bar and select "Save Active Account".');
        }
    );
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
        vscode.commands.registerCommand('antigravity-account-switcher.login', () => loginNewAccount(''))
    );

    updateStatusBar();
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
