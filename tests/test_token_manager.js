'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-token-test-'));
const home = path.join(root, 'home');
const secondHome = path.join(root, 'home2');
const dbPath = path.join(root, 'db', 'state.vscdb');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(secondHome, { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

process.env.AGY_SWITCH_HOME = home;
process.env.AGY_SWITCH_DB_PATHS = dbPath;

let DatabaseSync = null;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch {}

const tokenManager = require('../tokenManager');

function withDb(callback) {
    const db = new DatabaseSync(dbPath);
    try {
        return callback(db);
    } finally {
        db.close();
    }
}

if (DatabaseSync) {
    withDb(db => db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)'));
}

function resetState() {
    fs.rmSync(path.join(home, '.gemini'), { recursive: true, force: true });
    fs.rmSync(path.join(secondHome, '.gemini'), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.mkdirSync(path.join(secondHome, '.gemini'), { recursive: true });
    process.env.AGY_SWITCH_HOME = home;
    process.env.AGY_SWITCH_DB_PATHS = dbPath;
    if (DatabaseSync) withDb(db => db.exec('DELETE FROM ItemTable'));
}

function setDbRows(rows) {
    if (!DatabaseSync) return;
    withDb(db => {
        db.exec('DELETE FROM ItemTable');
        const insert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
        for (const [key, value] of Object.entries(rows)) insert.run(key, value);
    });
}

function readDbValue(key) {
    if (!DatabaseSync) return null;
    return withDb(db => {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
        return row ? String(row.value) : null;
    });
}

function tokenPath(category) {
    return tokenManager.getTokenFilePaths()[category][0];
}

function writeToken(category, data) {
    const target = tokenPath(category);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data), 'utf-8');
}

function makeToken(email, access = 'access-token', refresh = 'refresh-token', expiry = '2099-01-01T00:00:00Z') {
    return {
        token: {
            access_token: access,
            refresh_token: refresh,
            token_type: 'Bearer',
            expiry
        },
        auth_method: 'consumer',
        id_token_email: email
    };
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('isValidEmail accepts valid addresses and rejects malformed ones', async () => {
    assert.strictEqual(tokenManager.isValidEmail('user@gmail.com'), true);
    assert.strictEqual(tokenManager.isValidEmail('engineer.alpha+dev@company.org'), true);
    assert.strictEqual(tokenManager.isValidEmail('not-an-email'), false);
    assert.strictEqual(tokenManager.isValidEmail('user@'), false);
    assert.strictEqual(tokenManager.isValidEmail('@domain.com'), false);
    assert.strictEqual(tokenManager.isValidEmail(null), false);
});

test('detectActiveSession reports signed out without token files', async () => {
    resetState();
    const session = tokenManager.detectActiveSession();
    assert.strictEqual(session.isActive, false);
    assert.strictEqual(session.hasToken, false);
    assert.strictEqual(session.email, '');
    assert.strictEqual(session.source, null);
});

test('detectActiveSession reads the CLI token and normalizes the email', async () => {
    resetState();
    writeToken('cliToken', makeToken('Mixed.Case@Example.com'));
    const session = tokenManager.detectActiveSession();
    assert.strictEqual(session.isActive, true);
    assert.strictEqual(session.hasToken, true);
    assert.strictEqual(session.email, 'mixed.case@example.com');
    assert.strictEqual(session.category, 'cliToken');
});

test('detectActiveSession falls back to the standalone token', async () => {
    resetState();
    writeToken('standaloneToken', makeToken('standalone@example.com'));
    const session = tokenManager.detectActiveSession();
    assert.strictEqual(session.email, 'standalone@example.com');
    assert.strictEqual(session.category, 'standaloneToken');
});

test('detectActiveSession prefers the IDE standalone token over a conflicting CLI token', async () => {
    resetState();
    writeToken('cliToken', makeToken('stale-cli@example.com', 'cli-access', 'cli-refresh'));
    writeToken('standaloneToken', makeToken('ide@example.com', 'ide-access', 'ide-refresh'));
    const session = tokenManager.detectActiveSession();
    assert.strictEqual(session.isActive, true);
    assert.strictEqual(session.email, 'ide@example.com');
    assert.strictEqual(session.category, 'standaloneToken');
});

test('snapshotActiveAccount drops file tokens that belong to another account', async () => {
    resetState();
    writeToken('cliToken', makeToken('stale-cli@example.com', 'cli-access', 'cli-refresh'));
    writeToken('standaloneToken', makeToken('ide@example.com', 'ide-access', 'ide-refresh'));

    const entry = tokenManager.snapshotActiveAccount('IDE');
    assert.strictEqual(entry.email, 'ide@example.com');
    assert.strictEqual(entry.file_tokens.cliToken.token.access_token, 'ide-access');
    assert.strictEqual(entry.file_tokens.standaloneToken.token.access_token, 'ide-access');
    assert.strictEqual(entry.file_tokens.cliToken.id_token_email, 'ide@example.com');
    assert.strictEqual(entry.file_tokens.standaloneToken.id_token_email, 'ide@example.com');
});

test('detectActiveSession understands root-level oauth_creds.json tokens', async () => {
    resetState();
    writeToken('oauthCreds', {
        access_token: 'oauth-access',
        refresh_token: 'oauth-refresh',
        expiry: '2099-01-01T00:00:00Z',
        id_token_email: 'oauth@example.com'
    });
    const session = tokenManager.detectActiveSession();
    assert.strictEqual(session.email, 'oauth@example.com');
    assert.strictEqual(session.category, 'oauthCreds');
});

test('expired access tokens are inactive unless a refresh token exists', async () => {
    resetState();
    writeToken('cliToken', makeToken('expired@example.com', 'expired-access', '', '2020-01-01T00:00:00Z'));
    assert.strictEqual(tokenManager.detectActiveSession().isActive, false);

    resetState();
    writeToken('cliToken', makeToken('refreshable@example.com', 'expired-access', 'refresh-token', '2020-01-01T00:00:00Z'));
    const session = tokenManager.detectActiveSession();
    assert.strictEqual(session.isActive, true);
    assert.strictEqual(session.email, 'refreshable@example.com');
});

test('detectActiveSession uses the database email when the token has none', async () => {
    if (!DatabaseSync) return;
    resetState();
    setDbRows({ antigravityAuthStatus: JSON.stringify({ email: 'db@example.com', apiKey: '' }) });
    writeToken('cliToken', { token: { access_token: 'access', refresh_token: 'refresh' } });
    const session = tokenManager.detectActiveSession();
    assert.strictEqual(session.email, 'db@example.com');
});

test('snapshotActiveAccount stores canonical tokens, synthesizes both files and uses 0600', async () => {
    resetState();
    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'work@company.com', apiKey: 'key' }),
        'google.google-antigravity': JSON.stringify({
            'antigravity-storage': {
                'agy.onboarding.lastLoginUsername': 'work@company.com',
                otherSetting: 'preserved'
            }
        })
    });
    writeToken('cliToken', makeToken('work@company.com'));

    const entry = tokenManager.snapshotActiveAccount('Work');
    assert.strictEqual(entry.email, 'work@company.com');
    assert.strictEqual(entry.label, 'Work');
    assert.ok(entry.file_tokens.cliToken);
    assert.ok(entry.file_tokens.standaloneToken);
    assert.strictEqual(entry.file_tokens.standaloneToken.token.refresh_token, 'refresh-token');

    const profiles = tokenManager.loadProfiles();
    assert.ok(profiles['work@company.com']);
    assert.strictEqual(profiles['work@company.com'].label, 'Work');
    assert.strictEqual(profiles['work@company.com'].file_tokens.standaloneToken.token.access_token, 'access-token');

    if (process.platform !== 'win32') {
        const profilePath = path.join(home, '.gemini', 'antigravity_profiles.json');
        assert.strictEqual(fs.statSync(profilePath).mode & 0o777, 0o600);
        assert.strictEqual(fs.statSync(tokenPath('cliToken')).mode & 0o777, 0o600);
    }
});

test('snapshotActiveAccount rejects a manual email that does not own the session', async () => {
    resetState();
    writeToken('cliToken', makeToken('real@example.com'));
    assert.throws(
        () => tokenManager.snapshotActiveAccount('Ghost', 'ghost@example.com'),
        /active session belongs/i
    );

    resetState();
    assert.throws(
        () => tokenManager.snapshotActiveAccount('Ghost', 'ghost@example.com'),
        /no active antigravity session/i
    );
});

test('loadProfiles migrates snake_case legacy profiles and restore writes the files', async () => {
    resetState();
    const profilePath = path.join(home, '.gemini', 'antigravity_profiles.json');
    fs.writeFileSync(profilePath, JSON.stringify({
        'legacy@example.com': {
            email: 'legacy@example.com',
            name: 'Legacy',
            saved_at: '2026-01-01T00:00:00Z',
            tokens: {},
            file_tokens: {
                cli_token: makeToken('legacy@example.com', 'legacy-access', 'legacy-refresh'),
                standalone_token: null,
                oauth_creds: null
            }
        }
    }), 'utf-8');

    const profiles = tokenManager.loadProfiles();
    const entry = profiles['legacy@example.com'];
    assert.ok(entry);
    assert.strictEqual(entry.label, 'Legacy');
    assert.strictEqual(entry.file_tokens.cliToken.token.access_token, 'legacy-access');
    assert.strictEqual(entry.file_tokens.standaloneToken.token.refresh_token, 'legacy-refresh');

    tokenManager.restoreProfile(entry);
    const cli = JSON.parse(fs.readFileSync(tokenPath('cliToken'), 'utf-8'));
    const standalone = JSON.parse(fs.readFileSync(tokenPath('standaloneToken'), 'utf-8'));
    assert.strictEqual(cli.id_token_email, 'legacy@example.com');
    assert.strictEqual(standalone.token.access_token, 'legacy-access');
});

test('restoreProfile replaces a stale CLI token when the profile only saved standalone', async () => {
    resetState();
    writeToken('cliToken', makeToken('old@example.com', 'old-access', 'old-refresh'));
    writeToken('standaloneToken', makeToken('old@example.com', 'old-access', 'old-refresh'));

    tokenManager.saveProfiles({
        'new@example.com': {
            email: 'new@example.com',
            label: 'New',
            db_tokens: {},
            file_tokens: {
                cliToken: null,
                standaloneToken: makeToken('new@example.com', 'new-access', 'new-refresh'),
                oauthCreds: null
            }
        }
    });

    const profiles = tokenManager.loadProfiles();
    tokenManager.restoreProfile(profiles['new@example.com']);

    const cli = JSON.parse(fs.readFileSync(tokenPath('cliToken'), 'utf-8'));
    const standalone = JSON.parse(fs.readFileSync(tokenPath('standaloneToken'), 'utf-8'));
    assert.strictEqual(cli.id_token_email, 'new@example.com');
    assert.strictEqual(cli.token.access_token, 'new-access');
    assert.strictEqual(standalone.token.access_token, 'new-access');
    assert.strictEqual(tokenManager.detectActiveSession().email, 'new@example.com');
});

test('restoreProfile removes token categories that the profile does not contain', async () => {
    resetState();
    writeToken('cliToken', makeToken('old@example.com'));
    writeToken('standaloneToken', makeToken('old@example.com'));

    tokenManager.restoreProfile({
        email: 'oauth@example.com',
        db_tokens: {},
        file_tokens: {
            oauthCreds: {
                access_token: 'oauth-access',
                refresh_token: 'oauth-refresh',
                id_token_email: 'oauth@example.com'
            }
        }
    });

    assert.strictEqual(fs.existsSync(tokenPath('cliToken')), false);
    assert.strictEqual(fs.existsSync(tokenPath('standaloneToken')), false);
    assert.strictEqual(tokenManager.detectActiveSession().email, 'oauth@example.com');
});

test('restoreProfile clears stale database auth keys and preserves unrelated settings', async () => {
    if (!DatabaseSync) return;
    resetState();

    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'a@example.com', apiKey: 'a-key' }),
        'google.google-antigravity': JSON.stringify({
            'antigravity-storage': {
                'agy.onboarding.lastLoginUsername': 'a@example.com',
                otherSetting: 'from-a'
            }
        }),
        'antigravityUnifiedStateSync.userStatus': JSON.stringify({ plan: 'a' })
    });
    writeToken('cliToken', makeToken('a@example.com'));
    const saved = tokenManager.snapshotActiveAccount('A', 'a@example.com');

    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'b@example.com', apiKey: 'b-key' }),
        'google.google-antigravity': JSON.stringify({
            'antigravity-storage': {
                'agy.onboarding.lastLoginUsername': 'b@example.com',
                otherSetting: 'from-b'
            }
        }),
        'antigravityUnifiedStateSync.oauthToken': JSON.stringify({ token: 'stale-b' })
    });

    tokenManager.restoreProfile(saved);

    const status = JSON.parse(readDbValue('antigravityAuthStatus'));
    const google = JSON.parse(readDbValue('google.google-antigravity'));
    assert.strictEqual(status.email, 'a@example.com');
    assert.strictEqual(google['antigravity-storage']['agy.onboarding.lastLoginUsername'], 'a@example.com');
    assert.strictEqual(google['antigravity-storage'].otherSetting, 'from-a');
    assert.strictEqual(readDbValue('antigravityUnifiedStateSync.oauthToken'), null);
});

test('loadProfiles backs up a corrupt vault before overwriting it', async () => {
    resetState();
    writeToken('cliToken', makeToken('recover@example.com'));
    const profilePath = path.join(home, '.gemini', 'antigravity_profiles.json');
    fs.writeFileSync(profilePath, 'this is not json', 'utf-8');

    const before = tokenManager.loadProfiles();
    assert.deepStrictEqual(before, {});
    assert.ok(tokenManager.getLastLoadWarnings().length > 0);

    tokenManager.snapshotActiveAccount('Recovered', 'recover@example.com');
    const backups = fs.readdirSync(path.join(home, '.gemini')).filter(name => name.includes('.corrupt-'));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(home, '.gemini', backups[0]), 'utf-8'), 'this is not json');
    assert.ok(tokenManager.loadProfiles()['recover@example.com']);
});

test('an intentionally empty vault does not fall through to a stale second copy', async () => {
    resetState();
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity_profiles.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(secondHome, '.gemini', 'antigravity_profiles.json'), JSON.stringify({
        'stale@example.com': {
            email: 'stale@example.com',
            label: 'Stale',
            db_tokens: {},
            file_tokens: { cliToken: makeToken('stale@example.com') }
        }
    }), 'utf-8');

    process.env.AGY_SWITCH_HOME = `${home}${path.delimiter}${secondHome}`;
    assert.deepStrictEqual(tokenManager.loadProfiles(), {});
    process.env.AGY_SWITCH_HOME = home;
});

test('clearAllSessionTokens removes token files and database session keys', async () => {
    if (!DatabaseSync) return;
    resetState();
    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'clear@example.com', apiKey: '' }),
        'google.google-antigravity': JSON.stringify({
            'antigravity-storage': {
                'agy.onboarding.lastLoginUsername': 'clear@example.com',
                keepMe: 'yes'
            }
        }),
        'antigravityUnifiedStateSync.modelCredits': JSON.stringify({ credits: 10 })
    });
    writeToken('cliToken', makeToken('clear@example.com'));
    writeToken('standaloneToken', makeToken('clear@example.com'));

    tokenManager.clearAllSessionTokens();

    assert.strictEqual(fs.existsSync(tokenPath('cliToken')), false);
    assert.strictEqual(fs.existsSync(tokenPath('standaloneToken')), false);
    assert.strictEqual(readDbValue('antigravityAuthStatus'), null);
    assert.strictEqual(readDbValue('antigravityUnifiedStateSync.modelCredits'), null);
    const google = JSON.parse(readDbValue('google.google-antigravity'));
    assert.strictEqual(google['antigravity-storage']['agy.onboarding.lastLoginUsername'], undefined);
    assert.strictEqual(google['antigravity-storage'].keepMe, 'yes');
});

async function runTests() {
    console.log('--- Antigravity Account Switcher tests ---');
    let passed = 0;
    let failed = 0;

    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  PASS: ${name}`);
            passed++;
        } catch (error) {
            console.error(`  FAIL: ${name}`);
            console.error(error.stack || error.message);
            failed++;
        }
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
}

runTests();
