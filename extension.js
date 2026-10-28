const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

let statusBarItem;
const SCRIPT_PATH = path.join(__dirname, 'switch.py');

function runSwitcherCmd(args) {
    return new Promise((resolve, reject) => {
        // Execute python3 script via WSL or local python
        const cmd = `python3 "${SCRIPT_PATH}" ${args}`;
        exec(cmd, { encoding: 'utf-8' }, (err, stdout, stderr) => {
            if (err) {
                return reject(stderr || stdout || err.message);
            }
            resolve(stdout.trim());
        });
    });
}

async function updateStatusBar() {
    try {
        const out = await runSwitcherCmd('current');
        const activeName = out || 'Default';
        statusBarItem.text = `$(account) Antigravity: ${activeName}`;
        statusBarItem.tooltip = `Active Antigravity Account: ${activeName}\nClick to switch or manage accounts`;
        statusBarItem.show();
    } catch (err) {
        statusBarItem.text = `$(account) Antigravity: Account`;
        statusBarItem.tooltip = `Click to switch Antigravity accounts`;
        statusBarItem.show();
    }
}

async function showAccountSwitcherMenu() {
    try {
        const listJson = await runSwitcherCmd('list --json');
        const data = JSON.parse(listJson);
        const profiles = data.profiles || [];
        const activeName = data.active;

        const items = [];

        // Add saved profiles
        if (profiles.length > 0) {
            items.push({ label: 'SAVED ACCOUNTS', kind: vscode.QuickPickItemKind.Separator });
            for (const p of profiles) {
                const isActive = p.active || p.name === activeName;
                items.push({
                    label: isActive ? `$(check) ${p.name}` : `$(account) ${p.name}`,
                    description: isActive ? 'Currently Active' : `Saved: ${p.saved_at.slice(0, 10)}`,
                    profileName: p.name,
                    action: 'switch'
                });
            }
        }

        items.push({ label: 'ACTIONS', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(save) Save Current Session as Profile...',
            detail: 'Snapshot your currently logged-in account into a reusable profile',
            action: 'save'
        });
        items.push({
            label: '$(key) Sign In to New Google Account...',
            detail: 'Start OAuth login to authenticate another account',
            action: 'login'
        });
        if (profiles.length > 0) {
            items.push({
                label: '$(trash) Delete a Saved Profile...',
                detail: 'Remove a profile from saved storage',
                action: 'delete'
            });
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select an Antigravity account or manage profiles...',
            title: 'Antigravity Account Switcher'
        });

        if (!selected) return;

        if (selected.action === 'switch') {
            await switchProfile(selected.profileName);
        } else if (selected.action === 'save') {
            await saveCurrentProfile();
        } else if (selected.action === 'login') {
            await loginNewAccount();
        } else if (selected.action === 'delete') {
            await deleteProfile(profiles);
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Account Switcher Error: ${err}`);
    }
}

async function switchProfile(name) {
    try {
        await runSwitcherCmd(`load "${name}"`);
        updateStatusBar();

        const action = await vscode.window.showInformationMessage(
            `Switched to Antigravity account '${name}'! Reload Antigravity IDE to apply?`,
            'Reload Now',
            'Later'
        );

        if (action === 'Reload Now') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to switch profile: ${err}`);
    }
}

async function saveCurrentProfile() {
    const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for this account profile (e.g., Personal, Work, ClientB)',
        placeHolder: 'Personal'
    });

    if (!name || !name.trim()) return;

    try {
        await runSwitcherCmd(`save "${name.trim()}"`);
        vscode.window.showInformationMessage(`Account profile '${name.trim()}' saved successfully!`);
        updateStatusBar();
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to save profile: ${err}`);
    }
}

async function loginNewAccount() {
    try {
        // Trigger Antigravity internal login command
        await vscode.commands.executeCommand('antigravity.internal.loginWithRedirect');
        vscode.window.showInformationMessage(
            'Browser opened for Google Sign-in. Once completed, click the status bar and select "Save Current Session as Profile".'
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to launch Google Sign-In: ${err}`);
    }
}

async function deleteProfile(profiles) {
    const items = profiles.map(p => ({
        label: p.name,
        description: `Saved: ${p.saved_at.slice(0, 10)}`
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select profile to delete...'
    });

    if (!selected) return;

    try {
        await runSwitcherCmd(`delete "${selected.label}"`);
        vscode.window.showInformationMessage(`Profile '${selected.label}' deleted.`);
        updateStatusBar();
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete profile: ${err}`);
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
        vscode.commands.registerCommand('antigravity-account-switcher.save', saveCurrentProfile)
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
