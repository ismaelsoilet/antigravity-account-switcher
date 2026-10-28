const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

let statusBarItem;
const SCRIPT_PATH = path.join(__dirname, 'switch.py');

function runSwitcherCmd(args) {
    return new Promise((resolve, reject) => {
        const cmd = `python3 "${SCRIPT_PATH}" ${args}`;
        exec(cmd, { encoding: 'utf-8' }, (err, stdout, stderr) => {
            if (err) {
                return reject(stderr || stdout || err.message);
            }
            resolve(stdout.trim());
        });
    });
}

async function getActiveAccountInfo() {
    try {
        const raw = await runSwitcherCmd('current --json');
        return JSON.parse(raw);
    } catch {
        return { name: 'Default', email: '', display_name: '' };
    }
}

async function updateStatusBar() {
    try {
        const info = await getActiveAccountInfo();
        const profile = info.name || 'Default';
        const email = info.email ? ` (${info.email})` : '';

        statusBarItem.text = `$(account) [${profile}]${email}`;
        statusBarItem.tooltip = new vscode.MarkdownString(
            `### Antigravity Account Switcher\n` +
            `* **Active Profile:** \`${profile}\`\n` +
            (info.email ? `* **Google Account:** \`${info.email}\`\n` : '') +
            (info.display_name ? `* **User:** ${info.display_name}\n` : '') +
            `* **Status:** Synced across IDE, Desktop 2.0 & CLI\n\n` +
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
        const listJson = await runSwitcherCmd('list --json');
        const data = JSON.parse(listJson);
        const profiles = data.profiles || [];
        const activeName = data.active;
        const currentEmail = data.current_email;

        const items = [];

        // Saved profiles
        if (profiles.length > 0) {
            items.push({ label: 'SAVED PROFILES', kind: vscode.QuickPickItemKind.Separator });
            for (const p of profiles) {
                const isActive = p.active || p.name === activeName;
                const emailLabel = p.email ? ` • ${p.email}` : '';
                items.push({
                    label: isActive ? `$(check) ${p.name}` : `$(account) ${p.name}`,
                    description: isActive ? `Active${emailLabel}` : (p.email || `Saved`),
                    detail: `Saved on: ${p.saved_at.slice(0, 19).replace('T', ' ')}`,
                    profileName: p.name,
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
            detail: `Save current session (${currentEmail || 'Active'}) under a custom profile name`,
            action: 'save'
        });
        if (profiles.length > 0) {
            items.push({
                label: '$(trash) Delete a Saved Profile...',
                detail: 'Remove a profile from local storage',
                action: 'delete'
            });
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Currently active: [${activeName || 'Default'}] ${currentEmail || ''}`,
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
            await saveCurrentProfile(currentEmail);
        } else if (selected.action === 'login') {
            await loginNewAccount();
        } else if (selected.action === 'delete') {
            await deleteProfile(profiles);
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Account Switcher Error: ${err}`);
    }
}

async function switchProfile(name, email) {
    const emailStr = email ? ` (${email})` : '';
    
    // Confirmation dialog with reload warning
    const confirm = await vscode.window.showWarningMessage(
        `Switch to Antigravity profile '${name}'${emailStr}?`,
        {
            modal: true,
            detail: `Antigravity IDE will immediately reload to apply the session tokens across the IDE, Antigravity 2.0, and the CLI.\n\nPlease ensure your ongoing unsaved edits are saved before proceeding.`
        },
        'Switch & Reload',
        'Cancel'
    );

    if (confirm !== 'Switch & Reload') return;

    try {
        await runSwitcherCmd(`load "${name}"`);
        await updateStatusBar();

        // Perform instant window reload
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to switch profile: ${err}`);
    }
}

async function saveCurrentProfile(defaultEmail) {
    const suggested = defaultEmail ? defaultEmail.split('@')[0] : 'Work';
    const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for this account profile (e.g., Personal, Work, Secondary):',
        value: suggested,
        placeHolder: 'Personal',
        ignoreFocusOut: true
    });

    if (!name || !name.trim()) return;

    try {
        await runSwitcherCmd(`save "${name.trim()}"`);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Account profile '${name.trim()}' saved successfully!`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to save profile: ${err}`);
    }
}

async function loginNewAccount() {
    // Confirmation dialog before launching browser
    const proceed = await vscode.window.showInformationMessage(
        'Connect New Google Account',
        {
            modal: true,
            detail: 'This will launch your browser to sign in with your other Google Account.\n\nOnce authentication succeeds, Antigravity IDE will prompt you for a profile name and automatically reload into the new session.'
        },
        'Proceed to Sign In',
        'Cancel'
    );

    if (proceed !== 'Proceed to Sign In') return;

    // Get current token before starting OAuth to detect when it changes
    let initialToken = '';
    try {
        const cur = JSON.parse(await runSwitcherCmd('current --json'));
        initialToken = cur.email || '';
    } catch {}

    try {
        // Trigger Antigravity internal login command
        vscode.commands.executeCommand('antigravity.internal.loginWithRedirect');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to trigger Google Sign-In: ${err}`);
        return;
    }

    // Monitor for successful login in progress notification
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Waiting for Google Sign-In in browser...',
            cancellable: true
        },
        async (progress, token) => {
            const startTime = Date.now();
            const timeout = 120000; // 2 minutes

            while (Date.now() - startTime < timeout) {
                if (token.isCancellationRequested) {
                    return;
                }

                await new Promise(r => setTimeout(r, 2000));

                try {
                    const currentInfo = JSON.parse(await runSwitcherCmd('current --json'));
                    const newEmail = currentInfo.email;

                    // If email is detected and different from initial, or token updated
                    if (newEmail && newEmail !== initialToken) {
                        progress.report({ message: `Authenticated as ${newEmail}!` });

                        const defaultName = newEmail.split('@')[0];
                        const profileName = await vscode.window.showInputBox({
                            prompt: `Google Sign-in successful (${newEmail})! Enter profile name:`,
                            value: defaultName,
                            ignoreFocusOut: true
                        });

                        const finalName = (profileName && profileName.trim()) ? profileName.trim() : defaultName;
                        await runSwitcherCmd(`save "${finalName}"`);

                        await vscode.window.showInformationMessage(
                            `Profile '${finalName}' (${newEmail}) saved! Reloading Antigravity IDE...`
                        );

                        // Reload window to fully apply across all surfaces
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                        return;
                    }
                } catch {}
            }

            vscode.window.showWarningMessage('Sign-in wait timed out. If you signed in successfully, click the status bar and select "Snapshot Current Session".');
        }
    );
}

async function deleteProfile(profiles) {
    const items = profiles.map(p => ({
        label: p.name,
        description: p.email || 'Saved Profile',
        detail: `Saved: ${p.saved_at.slice(0, 10)}`
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
        await runSwitcherCmd(`delete "${selected.label}"`);
        await updateStatusBar();
        vscode.window.showInformationMessage(`Profile '${selected.label}' deleted.`);
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
