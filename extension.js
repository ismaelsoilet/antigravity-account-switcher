const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

let statusBarItem;

const AUTH_KEYS = [
    'antigravityUnifiedStateSync.oauthToken',
    'antigravityUnifiedStateSync.userStatus',
    'antigravityUnifiedStateSync.modelCredits',
    'antigravityAuthStatus',
    'google.google-antigravity'
];

// Helper: Try to require node:sqlite
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
            return JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch {}
    }
    return {};
}

function saveProfiles(profiles) {
    const p = getProfilesFilePath();
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(profiles, null, 2), 'utf-8');
    } catch (err) {
        console.error('Failed to save profiles to:', p, err);
    }
}

function extractEmail(tokens) {
    const raw = tokens['google.google-antigravity'];
    if (raw) {
        try {
            const data = JSON.parse(raw);
            const storage = data['antigravity-storage'];
            if (storage && storage['jetski.onboarding.lastLoginUsername']) {
                return storage['jetski.onboarding.lastLoginUsername'];
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
            console.warn('DatabaseSync read failed, trying fallback:', e);
        }
    }

    // Fallback: via python helper
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
                continue;
            } catch (e) {
                console.error(`DatabaseSync write failed for ${dbPath}:`, e);
            }
        }
    }
}

async function getActiveAccountInfo() {
    const tokens = readCurrentTokens();
    const email = extractEmail(tokens);
    const profiles = loadProfiles();

    let matchedProfile = null;
    const currentOauth = tokens['antigravityUnifiedStateSync.oauthToken'];

    for (const [name, data] of Object.entries(profiles)) {
        const profOauth = data.tokens && data.tokens['antigravityUnifiedStateSync.oauthToken'];
        if (currentOauth && profOauth && currentOauth === profOauth) {
            matchedProfile = name;
            break;
        }
        if (email && data.email === email) {
            matchedProfile = name;
            break;
        }
    }

    return {
        profileName: matchedProfile || (email ? email.split('@')[0] : 'Default'),
        email: email,
        tokens: tokens
    };
}

async function updateStatusBar() {
    try {
        const info = await getActiveAccountInfo();
        const profile = info.profileName;
        const email = info.email ? ` (${info.email})` : '';

        statusBarItem.text = `$(account) [${profile}]${email}`;
        statusBarItem.tooltip = new vscode.MarkdownString(
            `### Antigravity Account Switcher\n` +
            `* **Active Profile:** \`${profile}\`\n` +
            (info.email ? `* **Google Account:** \`${info.email}\`\n` : '') +
            `* **Status:** Connected & Synced (IDE, Desktop 2.0 & CLI)\n\n` +
            `*(Click to switch, add accounts, or manage profiles)*`
        );
        statusBarItem.show();
    } catch (err) {
        statusBarItem.text = `$(account) Antigravity: Account`;
        statusBarItem.tooltip = `Click to switch Antigravity accounts`;
        statusBarItem.show();
    }
}

async function showAccountSwitcherMenu() {
    try {
        const activeInfo = await getActiveAccountInfo();
        const profiles = loadProfiles();
        const items = [];

        const profileEntries = Object.entries(profiles);
        if (profileEntries.length > 0) {
            items.push({ label: 'SAVED PROFILES', kind: vscode.QuickPickItemKind.Separator });
            for (const [name, p] of profileEntries) {
                const isActive = (name === activeInfo.profileName) || (p.email && p.email === activeInfo.email);
                const emailDesc = p.email ? ` • ${p.email}` : '';
                items.push({
                    label: isActive ? `$(check) ${name}` : `$(account) ${name}`,
                    description: isActive ? `Currently Active${emailDesc}` : (p.email || 'Saved Profile'),
                    detail: `Saved on: ${(p.saved_at || '').slice(0, 19).replace('T', ' ')}`,
                    profileName: name,
                    profileEmail: p.email,
                    isActive,
                    action: 'switch'
                });
            }
        }

        items.push({ label: 'ACCOUNT ACTIONS', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(key) Sign In to New Google Account...',
            detail: 'Connect another account via browser OAuth. Reloads automatically upon completion.',
            action: 'login'
        });
        items.push({
            label: '$(save) Snapshot Current Session as Profile...',
            detail: `Save current session (${activeInfo.email || activeInfo.profileName}) under a custom profile name`,
            action: 'save'
        });
        if (profileEntries.length > 0) {
            items.push({
                label: '$(trash) Delete a Saved Profile...',
                detail: 'Remove a profile from saved storage',
                action: 'delete'
            });
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Active: [${activeInfo.profileName}] ${activeInfo.email || ''}`,
            title: 'Antigravity Account Switcher'
        });

        if (!selected) return;

        if (selected.action === 'switch') {
            if (selected.isActive) {
                vscode.window.showInformationMessage(`Account profile '${selected.profileName}' is already active.`);
                return;
            }
            await switchProfile(selected.profileName, selected.profileEmail);
        } else if (selected.action === 'save') {
            await saveCurrentProfile(activeInfo.email);
        } else if (selected.action === 'login') {
            await loginNewAccount(activeInfo.email);
        } else if (selected.action === 'delete') {
            await deleteProfile(profileEntries);
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Account Switcher Error: ${err.message || err}`);
    }
}

async function switchProfile(name, email) {
    const emailStr = email ? ` (${email})` : '';

    const confirm = await vscode.window.showWarningMessage(
        `Switch to Antigravity profile '${name}'${emailStr}?`,
        {
            modal: true,
            detail: `Antigravity IDE will reload immediately to activate the session across the IDE, Antigravity 2.0 Desktop, and the CLI.\n\nPlease save all ongoing work before proceeding.`
        },
        'Switch & Reload',
        'Cancel'
    );

    if (confirm !== 'Switch & Reload') return;

    try {
        const profiles = loadProfiles();
        const target = profiles[name];
        if (!target || !target.tokens) {
            throw new Error(`Profile '${name}' has no saved tokens.`);
        }

        writeTokensToDbs(target.tokens);
        await updateStatusBar();

        vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to switch profile: ${err.message || err}`);
    }
}

async function saveCurrentProfile(defaultEmail) {
    const tokens = readCurrentTokens();
    const email = extractEmail(tokens) || defaultEmail;
    const suggested = email ? email.split('@')[0] : 'Work';

    const name = await vscode.window.showInputBox({
        prompt: `Enter profile name for ${email || 'this account'} (e.g. Personal, Work, Secondary):`,
        value: suggested,
        placeHolder: 'Personal',
        ignoreFocusOut: true
    });

    if (!name || !name.trim()) return;

    try {
        const profiles = loadProfiles();
        profiles[name.trim()] = {
            name: name.trim(),
            email: email,
            saved_at: new Date().toISOString(),
            tokens: tokens
        };
        saveProfiles(profiles);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account profile '${name.trim()}' (${email}) saved successfully!`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to save profile: ${err.message || err}`);
    }
}

async function loginNewAccount(currentEmail) {
    const proceed = await vscode.window.showInformationMessage(
        'Connect New Google Account',
        {
            modal: true,
            detail: 'This will launch your browser to sign in with another Google Account.\n\nOnce authentication completes in your browser, Antigravity IDE will automatically detect the new login, prompt you for a profile name, and reload into the new session.'
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
        vscode.window.showErrorMessage(`Failed to trigger Google Sign-In: ${err.message || err}`);
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
                        progress.report({ message: `Signed in as ${newEmail || 'new account'}!` });

                        const defaultName = newEmail ? newEmail.split('@')[0] : 'Work';
                        const profileName = await vscode.window.showInputBox({
                            prompt: `Google Sign-in successful (${newEmail})! Enter a profile name:`,
                            value: defaultName,
                            ignoreFocusOut: true
                        });

                        const finalName = (profileName && profileName.trim()) ? profileName.trim() : defaultName;
                        const profiles = loadProfiles();
                        profiles[finalName] = {
                            name: finalName,
                            email: newEmail,
                            saved_at: new Date().toISOString(),
                            tokens: latestTokens
                        };
                        saveProfiles(profiles);

                        await vscode.window.showInformationMessage(
                            `Profile '${finalName}' (${newEmail}) saved! Reloading Antigravity IDE...`
                        );

                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                        return;
                    }
                } catch {}
            }

            vscode.window.showWarningMessage('Sign-in wait timed out. If you signed in successfully, click the status bar and select "Snapshot Current Session".');
        }
    );
}

async function deleteProfile(profileEntries) {
    const items = profileEntries.map(([name, p]) => ({
        label: name,
        description: p.email || 'Saved Profile',
        detail: `Saved: ${(p.saved_at || '').slice(0, 10)}`
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select profile to delete...',
        title: 'Delete Saved Profile'
    });

    if (!selected) return;

    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete profile '${selected.label}'?`,
        { modal: true },
        'Delete',
        'Cancel'
    );

    if (confirm !== 'Delete') return;

    try {
        const profiles = loadProfiles();
        delete profiles[selected.label];
        saveProfiles(profiles);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Profile '${selected.label}' deleted.`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete profile: ${err.message || err}`);
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
        vscode.commands.registerCommand('antigravity-account-switcher.save', () => saveCurrentProfile(''))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-account-switcher.login', loginNewAccount)
    );

    updateStatusBar();
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
