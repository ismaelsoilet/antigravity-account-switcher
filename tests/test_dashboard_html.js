'use strict';

const assert = require('assert');
const { escapeHtml, renderDashboardHtml } = require('../dashboardHtml');

const snapshot = {
    version: '1.8.2',
    active: {
        email: 'user@example.com',
        label: 'Work',
        conflicts: 0,
        conflictDetails: ''
    },
    keyring: {
        available: true,
        managed: true,
        email: 'user@example.com'
    },
    profiles: [
        { email: 'user@example.com', label: 'Work', active: true, keyring: true, complete: true },
        {
            email: 'other@example.com',
            label: '<script>alert(1)</script>',
            active: false,
            keyring: false,
            complete: false
        }
    ],
    quota: {
        available: true,
        live: true,
        rateLimited: false,
        models: [
            {
                label: 'Gemini Models — Weekly Limit Remaining',
                remainingPercent: 51,
                exhausted: false,
                resetAt: '2099-01-01T00:00:00Z'
            }
        ],
        signals: []
    }
};

const html = renderDashboardHtml(snapshot, 'abc123');
assert.ok(html.includes('Antigravity Accounts'));
assert.ok(html.includes('51%'));
assert.ok(html.includes('Work'));
assert.ok(html.includes('Keyring managed'));
assert.ok(html.includes('data-action="switch"'));
assert.ok(html.includes('data-action="openSettings"'));
assert.ok(html.includes("script-src 'nonce-abc123'"));
assert.ok(html.includes('--bar-bg: rgba(127,127,127,.18)'));
assert.ok(!html.includes('--bar-bg: var(--vscode-progressBar-background'));
assert.ok(!html.includes('<script>alert(1)</script>'));
assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert.ok(!html.includes('refresh_token'));

const empty = renderDashboardHtml({
    version: '1.8.2',
    active: {},
    keyring: { available: false, managed: false },
    profiles: [],
    quota: { available: false, models: [], signals: [], rateLimited: false }
}, 'def456');
assert.ok(empty.includes('No local quota data'));
assert.ok(empty.includes('Open Settings &gt; View Usage'));
assert.ok(!empty.includes('data-action="switch"'));
assert.strictEqual(escapeHtml('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');

console.log('Dashboard HTML tests passed');
