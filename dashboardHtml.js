'use strict';

function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return `${Math.round(number * 10) / 10}%`;
}

function formatReset(value) {
    if (!value) return '';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return '';
    const remaining = timestamp - Date.now();
    if (remaining <= 0) return 'reset due';
    const minutes = Math.round(remaining / 60000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 48) return `in ${hours}h${rest ? ` ${rest}m` : ''}`;
    return `on ${new Date(timestamp).toLocaleDateString()}`;
}

function quotaClass(model) {
    if (model.exhausted || Number(model.remainingPercent) <= 0) return 'bad';
    if (Number(model.remainingPercent) <= 20) return 'warn';
    return 'good';
}

function groupQuotaModels(models) {
    const groups = new Map();
    for (const model of models || []) {
        const label = String(model.label || 'Quota');
        const separator = label.indexOf(' — ');
        const groupName = separator >= 0 ? label.slice(0, separator) : 'Quota';
        const bucketName = separator >= 0 ? label.slice(separator + 3) : label;
        if (!groups.has(groupName)) groups.set(groupName, []);
        groups.get(groupName).push({ ...model, bucketName });
    }
    return [...groups.entries()];
}

function renderQuota(snapshot) {
    const quota = snapshot.quota || {};
    if (!quota.available) {
        return `
            <section class="card quota-card">
                <div class="section-head">
                    <div><h2>Quota</h2><p class="muted">Read-only. Nothing switches automatically.</p></div>
                    <button class="ghost" data-action="refresh" title="Refresh quota">Refresh</button>
                </div>
                <div class="empty">
                    <strong>No local quota data</strong>
                    <span>Open the official panel in Settings to see remaining limits.</span>
                    <button class="primary" data-action="openSettings">Open Settings &gt; View Usage</button>
                </div>
            </section>`;
    }

    const groups = groupQuotaModels(quota.models);
    const groupHtml = groups.map(([groupName, models]) => `
        <div class="quota-group">
            <div class="quota-group-title">${escapeHtml(groupName)}</div>
            ${models.map(model => {
                const percent = Math.max(0, Math.min(100, Number(model.remainingPercent) || 0));
                const klass = quotaClass(model);
                const reset = model.resetAt ? formatReset(model.resetAt) : '';
                return `
                    <div class="quota-row">
                        <div class="quota-top">
                            <span class="quota-label">${escapeHtml(model.bucketName || model.label)}</span>
                            <span class="quota-value ${klass}">${model.exhausted ? 'exhausted' : formatPercent(percent)}</span>
                        </div>
                        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}">
                            <span class="${klass}" style="width:${percent}%"></span>
                        </div>
                        <div class="quota-meta">
                            <span>${model.exhausted ? 'Limit reached' : `${formatPercent(percent)} remaining`}</span>
                            ${reset ? `<span>${escapeHtml(reset)}</span>` : ''}
                        </div>
                    </div>`;
            }).join('')}
        </div>`).join('');

    const rate = quota.rateLimited ? `
        <div class="banner warn">
            <strong>Recent 429 / quota signal</strong>
            <span>Local logs show a rate-limit message. This is informational; switch manually if needed.</span>
        </div>` : '';

    return `
        <section class="card quota-card">
            <div class="section-head">
                <div>
                    <h2>Quota</h2>
                    <p class="muted">${quota.live ? 'Live from the official /usage' : 'Cached local quota'}${quota.updatedAt ? ` · ${escapeHtml(formatReset(quota.updatedAt) || 'now')}` : ''}</p>
                </div>
                <div class="head-actions">
                    <span class="badge ${quota.live ? 'live' : 'muted'}">${quota.live ? 'LIVE' : 'CACHED'}</span>
                    <button class="ghost" data-action="refresh" title="Refresh quota">Refresh</button>
                </div>
            </div>
            ${rate}
            ${groupHtml || '<div class="empty"><strong>No buckets returned</strong><span>Open Settings &gt; View Usage.</span></div>'}
            <div class="quota-foot">
                <span class="muted">Weekly and 5-hour buckets are shown separately. No auto-switch, no pooling.</span>
                <button class="link" data-action="openSettings">Official panel</button>
            </div>
        </section>`;
}

function renderProfiles(snapshot) {
    const profiles = snapshot.profiles || [];
    const rows = profiles.map(profile => {
        const active = Boolean(profile.active);
        const missingKeyring = !profile.keyring;
        const canSwitch = !active && !missingKeyring && profile.complete !== false;
        const initial = (profile.label || profile.email || '?').trim().slice(0, 1).toUpperCase();
        const label = profile.label || profile.email;
        const badge = active
            ? '<span class="badge ok">Active</span>'
            : missingKeyring
                ? '<span class="badge warn">Keyring missing</span>'
                : profile.complete === false
                    ? '<span class="badge warn">Incomplete</span>'
                    : '';
        const hint = missingKeyring
            ? 'Sign in to this account and run Save Current to capture the keyring.'
            : 'Manual switch with confirmation.';
        return `
            <div class="profile-row ${active ? 'is-active' : ''}">
                <div class="avatar small">${escapeHtml(initial)}</div>
                <div class="profile-main">
                    <div class="profile-name">${escapeHtml(label)} ${badge}</div>
                    <div class="profile-email">${escapeHtml(profile.email)}</div>
                    <div class="muted">${escapeHtml(hint)}</div>
                </div>
                ${active
                    ? '<button class="ghost" disabled>Active</button>'
                    : `<button class="${canSwitch ? 'primary' : 'ghost'}" data-action="switch" data-email="${escapeHtml(profile.email)}" data-label="${escapeHtml(label)}" ${canSwitch ? '' : 'disabled'}>Switch</button>`}
            </div>`;
    }).join('');

    return `
        <section class="card">
            <div class="section-head">
                <div><h2>Profiles</h2><p class="muted">One active account at a time.</p></div>
                <div class="head-actions">
                    <button class="ghost" data-action="save">Save current</button>
                    <button class="ghost" data-action="login">Sign in</button>
                </div>
            </div>
            ${rows || `
                <div class="empty">
                    <strong>No saved profiles</strong>
                    <span>Sign in to an account and save the current session.</span>
                    <button class="primary" data-action="login">Sign in</button>
                </div>`}
        </section>`;
}

function renderDashboardHtml(snapshot, nonce) {
    const active = snapshot.active || {};
    const keyring = snapshot.keyring || {};
    const initials = (active.label || active.email || '?').trim().slice(0, 1).toUpperCase();
    const conflictCount = Number(active.conflicts) || 0;
    const conflicts = conflictCount > 0 ? `
        <div class="banner warn">
            <strong>${conflictCount} store conflict${conflictCount === 1 ? '' : 's'}</strong>
            <span>${escapeHtml(active.conflictDetails || 'The stores disagree. Run Doctor before switching.')}</span>
            <button class="link" data-action="doctor">Run Doctor</button>
        </div>` : '';
    const keyringBadge = keyring.available
        ? `<span class="badge ok">Keyring managed</span>`
        : keyring.managed
            ? `<span class="badge warn">Keyring not found</span>`
            : `<span class="badge muted">Keyring unavailable</span>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<title>Antigravity Accounts</title>
<style>
    :root {
        color-scheme: light dark;
        --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
        --card: var(--vscode-editorWidget-background, rgba(127,127,127,.08));
        --border: var(--vscode-widget-border, rgba(127,127,127,.25));
        --muted: var(--vscode-descriptionForeground, rgba(127,127,127,.9));
        --fg: var(--vscode-foreground);
        --accent: var(--vscode-button-background, #4f8cff);
        --accent-fg: var(--vscode-button-foreground, #fff);
        --good: var(--vscode-testing-iconPassed, #3fb950);
        --warn: var(--vscode-editorWarning-foreground, #d29922);
        --bad: var(--vscode-errorForeground, #f85149);
        --bar-bg: var(--vscode-progressBar-background, rgba(127,127,127,.25));
    }
    * { box-sizing: border-box; }
    body {
        margin: 0; padding: 10px;
        font-family: var(--vscode-font-family, system-ui, sans-serif);
        font-size: 12px; color: var(--fg); background: transparent;
    }
    button {
        font: inherit; cursor: pointer; border: 1px solid var(--border);
        background: transparent; color: var(--fg); border-radius: 7px;
        padding: 5px 9px; transition: background .15s, border-color .15s;
    }
    button:hover:not(:disabled) { background: rgba(127,127,127,.12); }
    button:disabled { cursor: default; opacity: .5; }
    button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
    button.primary:hover:not(:disabled) { filter: brightness(1.08); }
    button.ghost { background: rgba(127,127,127,.06); }
    button.link { border: 0; padding: 0; color: var(--vscode-textLink-foreground, #4f8cff); background: none; text-decoration: underline; }
    .hero, .card {
        border: 1px solid var(--border); border-radius: 12px;
        background: var(--card); padding: 12px; margin-bottom: 10px;
    }
    .hero { background: linear-gradient(145deg, rgba(79,140,255,.13), rgba(147,51,234,.08)); }
    .brand { display: flex; align-items: center; gap: 7px; font-weight: 700; letter-spacing: .02em; }
    .brand .dot { width: 9px; height: 9px; border-radius: 50%; background: linear-gradient(135deg, #22d3ee, #f59e0b); box-shadow: 0 0 0 3px rgba(79,140,255,.18); }
    .version { margin-left: auto; font-weight: 500; color: var(--muted); font-size: 10px; }
    .account { display: flex; align-items: center; gap: 10px; margin-top: 11px; }
    .avatar {
        width: 36px; height: 36px; flex: 0 0 36px; border-radius: 11px;
        display: grid; place-items: center; font-weight: 700; font-size: 15px;
        background: linear-gradient(135deg, rgba(34,211,238,.28), rgba(245,158,11,.28));
        border: 1px solid var(--border);
    }
    .avatar.small { width: 30px; height: 30px; flex-basis: 30px; border-radius: 9px; font-size: 12px; }
    .account-main { min-width: 0; flex: 1; }
    .account-name { font-size: 13px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .account-email { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
    .badge {
        display: inline-flex; align-items: center; gap: 4px;
        border-radius: 999px; padding: 2px 7px; font-size: 10px; font-weight: 650;
        border: 1px solid var(--border); color: var(--muted);
    }
    .badge.ok { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, transparent); }
    .badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
    .badge.bad { color: var(--bad); }
    .badge.live { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, transparent); }
    .badge.muted { opacity: .8; }
    .section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
    .head-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
    h2 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
    .muted { color: var(--muted); font-size: 10.5px; line-height: 1.4; margin: 2px 0 0; }
    .banner { border: 1px solid var(--border); border-radius: 9px; padding: 8px 9px; margin: 8px 0; display: flex; flex-direction: column; gap: 3px; }
    .banner.warn { border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 9%, transparent); }
    .banner strong { font-size: 11px; }
    .banner span { color: var(--muted); font-size: 10.5px; line-height: 1.4; }
    .banner .link { align-self: flex-start; margin-top: 2px; }
    .quota-group + .quota-group { margin-top: 11px; }
    .quota-group-title { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; }
    .quota-row + .quota-row { margin-top: 9px; }
    .quota-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .quota-label { font-size: 11px; }
    .quota-value { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .quota-value.good { color: var(--good); } .quota-value.warn { color: var(--warn); } .quota-value.bad { color: var(--bad); }
    .bar { height: 6px; border-radius: 999px; background: var(--bar-bg); overflow: hidden; margin: 4px 0 3px; }
    .bar > span { display: block; height: 100%; border-radius: 999px; background: var(--accent); }
    .bar > span.good { background: var(--good); } .bar > span.warn { background: var(--warn); } .bar > span.bad { background: var(--bad); }
    .quota-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 10px; }
    .quota-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
    .quota-foot .muted { max-width: 75%; }
    .profile-row { display: flex; align-items: center; gap: 9px; padding: 8px 0; border-top: 1px solid var(--border); }
    .profile-row:first-of-type { border-top: 0; }
    .profile-row.is-active { background: color-mix(in srgb, var(--good) 7%, transparent); margin: 0 -5px; padding: 8px 5px; border-radius: 8px; }
    .profile-main { min-width: 0; flex: 1; }
    .profile-name { font-size: 11.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .profile-email { color: var(--muted); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; color: var(--muted); padding: 6px 0; }
    .empty strong { color: var(--fg); font-size: 11.5px; }
    .empty button { margin-top: 3px; }
    .footer { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
    .footer button { flex: 1 1 auto; }
    @media (min-width: 420px) { .profile-row { gap: 12px; } }
</style>
</head>
<body>
    <section class="hero">
        <div class="brand"><span class="dot"></span><span>Antigravity Accounts</span><span class="version">v${escapeHtml(snapshot.version || '')}</span></div>
        <div class="account">
            <div class="avatar">${escapeHtml(initials)}</div>
            <div class="account-main">
                <div class="account-name">${escapeHtml(active.label || active.email || 'No Account')}</div>
                <div class="account-email">${escapeHtml(active.email || 'Signed out')}</div>
            </div>
            <button class="ghost" data-action="refresh" title="Refresh dashboard">↻</button>
        </div>
        <div class="chips">
            ${active.email ? '<span class="badge ok">Active</span>' : '<span class="badge muted">Signed out</span>'}
            ${keyringBadge}
            ${conflictCount ? `<span class="badge warn">${conflictCount} conflict${conflictCount === 1 ? '' : 's'}</span>` : '<span class="badge ok">Stores aligned</span>'}
        </div>
    </section>
    ${conflicts}
    ${renderQuota(snapshot)}
    ${renderProfiles(snapshot)}
    <div class="footer">
        <button class="ghost" data-action="doctor">Doctor</button>
        <button class="ghost" data-action="diagnostics">Diagnostics</button>
        <button class="ghost" data-action="save">Save current</button>
        <button class="ghost" data-action="login">Sign in</button>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.addEventListener('click', event => {
            const button = event.target.closest('[data-action]');
            if (!button || button.disabled) return;
            const action = button.dataset.action;
            if (action === 'switch') {
                vscode.postMessage({ command: 'switch', email: button.dataset.email, label: button.dataset.label });
            } else {
                vscode.postMessage({ command: action });
            }
        });
    </script>
</body>
</html>`;
}

module.exports = {
    escapeHtml,
    renderDashboardHtml
};
