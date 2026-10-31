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

function withDbAt(targetPath, callback) {
    const db = new DatabaseSync(targetPath);
    try {
        return callback(db);
    } finally {
        db.close();
    }
}

function createDbAt(targetPath) {
    if (!DatabaseSync) return;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    withDbAt(targetPath, db => {
        db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    });
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

test('snapshotActiveAccount refuses to save while stores disagree', async () => {
    resetState();
    writeToken('cliToken', makeToken('stale-cli@example.com', 'cli-access', 'cli-refresh'));
    writeToken('standaloneToken', makeToken('ide@example.com', 'ide-access', 'ide-refresh'));

    assert.throws(
        () => tokenManager.snapshotActiveAccount('IDE'),
        /stores disagree/i
    );
});

test('readCurrentFileTokens filters tokens that belong to another account', async () => {
    resetState();
    writeToken('cliToken', makeToken('stale-cli@example.com', 'cli-access', 'cli-refresh'));
    writeToken('standaloneToken', makeToken('ide@example.com', 'ide-access', 'ide-refresh'));

    const fileTokens = tokenManager.readCurrentFileTokens('ide@example.com');
    assert.strictEqual(fileTokens.cliToken.token.access_token, 'ide-access');
    assert.strictEqual(fileTokens.standaloneToken.token.access_token, 'ide-access');
    assert.strictEqual(fileTokens.cliToken.id_token_email, 'ide@example.com');
    assert.strictEqual(fileTokens.standaloneToken.id_token_email, 'ide@example.com');
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

test('restoreProfile preserves database auth keys that the profile does not contain', async () => {
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
    assert.strictEqual(saved.complete, true);

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
    assert.deepStrictEqual(JSON.parse(readDbValue('antigravityUnifiedStateSync.oauthToken')), { token: 'stale-b' });
});

test('snapshotActiveAccount captures the complete database token and restores all auth keys', async () => {
    if (!DatabaseSync) return;
    resetState();

    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'full@example.com', apiKey: 'full-key' }),
        'google.google-antigravity': JSON.stringify({
            'antigravity-storage': {
                'agy.onboarding.lastLoginUsername': 'full@example.com',
                otherSetting: 'from-full'
            }
        }),
        'antigravityUnifiedStateSync.oauthToken': JSON.stringify({ token: 'full-oauth' }),
        'antigravityUnifiedStateSync.userStatus': JSON.stringify({ plan: 'full' }),
        'antigravityUnifiedStateSync.modelCredits': JSON.stringify({ credits: 42 })
    });
    writeToken('cliToken', makeToken('full@example.com'));
    const saved = tokenManager.snapshotActiveAccount('Full', 'full@example.com');

    assert.strictEqual(saved.complete, true);
    assert.ok(saved.db_tokens_by_path[dbPath]);
    assert.strictEqual(
        JSON.parse(saved.db_tokens_by_path[dbPath]['antigravityUnifiedStateSync.oauthToken']).token,
        'full-oauth'
    );

    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'other@example.com' }),
        'antigravityUnifiedStateSync.oauthToken': JSON.stringify({ token: 'other-oauth' }),
        'antigravityUnifiedStateSync.userStatus': JSON.stringify({ plan: 'other' }),
        'antigravityUnifiedStateSync.modelCredits': JSON.stringify({ credits: 1 })
    });

    tokenManager.restoreProfile(saved);

    assert.strictEqual(JSON.parse(readDbValue('antigravityAuthStatus')).email, 'full@example.com');
    assert.strictEqual(JSON.parse(readDbValue('antigravityUnifiedStateSync.oauthToken')).token, 'full-oauth');
    assert.strictEqual(JSON.parse(readDbValue('antigravityUnifiedStateSync.userStatus')).plan, 'full');
    assert.strictEqual(JSON.parse(readDbValue('antigravityUnifiedStateSync.modelCredits')).credits, 42);
});

test('detectSessions reports conflicting homes and keeps the desired account stable', async () => {
    resetState();
    process.env.AGY_SWITCH_HOME = `${home}${path.delimiter}${secondHome}`;
    writeToken('standaloneToken', makeToken('wsl@example.com', 'wsl-access', 'wsl-refresh'));

    const secondTokenPath = tokenManager.getTokenFilePaths().standaloneToken[1];
    fs.mkdirSync(path.dirname(secondTokenPath), { recursive: true });
    fs.writeFileSync(secondTokenPath, JSON.stringify(makeToken('win@example.com', 'win-access', 'win-refresh')), 'utf-8');

    const session = tokenManager.detectSessions();
    assert.strictEqual(session.email, 'wsl@example.com');
    assert.strictEqual(session.stores.filter(store => store.category === 'standaloneToken').length, 2);
    assert.ok(session.conflicts.some(conflict => conflict.type === 'multiple-emails'));

    tokenManager.writeSwitchState({ targetEmail: 'win@example.com' });
    const stable = tokenManager.detectSessions();
    assert.strictEqual(stable.email, 'win@example.com');
    assert.ok(stable.conflicts.some(conflict => conflict.type === 'target-mismatch'));

    process.env.AGY_SWITCH_HOME = home;
    tokenManager.refreshPaths();
});

test('acquireSwitchLock blocks a concurrent switch and releases cleanly', async () => {
    resetState();
    const lock = tokenManager.acquireSwitchLock();
    try {
        assert.throws(
            () => tokenManager.acquireSwitchLock(),
            /Another account switch is in progress/i
        );
    } finally {
        lock.release();
    }
    const second = tokenManager.acquireSwitchLock();
    second.release();
});

test('restoreProfile rolls the token files back when a database write fails', async () => {
    if (!DatabaseSync || process.platform === 'win32') return;
    resetState();
    writeToken('cliToken', makeToken('old@example.com', 'old-access', 'old-refresh'));
    fs.chmodSync(dbPath, 0o444);

    try {
        assert.throws(
            () => tokenManager.restoreProfile({
                email: 'new@example.com',
                complete: false,
                db_tokens: {
                    antigravityAuthStatus: JSON.stringify({ email: 'new@example.com', apiKey: '' })
                },
                file_tokens: {
                    cliToken: makeToken('new@example.com', 'new-access', 'new-refresh')
                }
            }),
            /Could not write the Antigravity database/i
        );
    } finally {
        fs.chmodSync(dbPath, 0o600);
    }

    const cli = JSON.parse(fs.readFileSync(tokenPath('cliToken'), 'utf-8'));
    assert.strictEqual(cli.id_token_email, 'old@example.com');
    assert.strictEqual(cli.token.access_token, 'old-access');
});

test('restoreProfile writes and verifies token files in both homes', async () => {
    resetState();
    process.env.AGY_SWITCH_HOME = `${home}${path.delimiter}${secondHome}`;

    tokenManager.restoreProfile({
        email: 'both@example.com',
        complete: false,
        db_tokens: {},
        file_tokens: {
            standaloneToken: makeToken('both@example.com', 'both-access', 'both-refresh')
        }
    });

    const standalonePaths = tokenManager.getTokenFilePaths().standaloneToken;
    assert.strictEqual(standalonePaths.length, 2);
    for (const standalonePath of standalonePaths) {
        const token = JSON.parse(fs.readFileSync(standalonePath, 'utf-8'));
        assert.strictEqual(token.id_token_email, 'both@example.com');
        assert.strictEqual(token.token.access_token, 'both-access');
    }

    process.env.AGY_SWITCH_HOME = home;
    tokenManager.refreshPaths();
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

test('detectActiveSession reports signed out when only a database identity exists', async () => {
    if (!DatabaseSync) return;
    resetState();
    setDbRows({ antigravityAuthStatus: JSON.stringify({ email: 'dbonly@example.com', apiKey: '' }) });

    const session = tokenManager.detectActiveSession();
    assert.strictEqual(session.isActive, false);
    assert.strictEqual(session.hasToken, false);
    assert.strictEqual(session.email, '');
    assert.ok(session.stores.some(store => store.kind === 'database' && store.email === 'dbonly@example.com'));
    assert.strictEqual(session.conflicts.length, 0);
});

test('a non-token database value does not count as an OAuth session', async () => {
    if (!DatabaseSync) return;
    resetState();
    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'legacy@example.com', apiKey: '' }),
        'antigravityUnifiedStateSync.oauthToken': '{}'
    });

    let session = tokenManager.detectActiveSession();
    assert.strictEqual(session.isActive, false);
    assert.strictEqual(session.hasToken, false);

    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'legacy@example.com', apiKey: '' }),
        'antigravityUnifiedStateSync.oauthToken': 'serialized-proto-blob'
    });
    session = tokenManager.detectActiveSession();
    assert.strictEqual(session.isActive, true);
    assert.strictEqual(session.hasToken, true);
    assert.strictEqual(session.category, 'database');
});

test('diffAgainstSwitchState classifies refresh, conflict and missing stores', async () => {
    resetState();
    writeToken('standaloneToken', makeToken('same@example.com', 'v1', 'r1'));
    tokenManager.writeSwitchState({
        targetEmail: 'same@example.com',
        files: tokenManager.getStoreSnapshot().files
    });

    writeToken('standaloneToken', makeToken('same@example.com', 'v2', 'r2'));
    let diff = tokenManager.diffAgainstSwitchState(tokenManager.readSwitchState());
    assert.strictEqual(diff.conflicts.length, 0);
    assert.ok(diff.refreshes.some(item => item.path === tokenPath('standaloneToken')));

    writeToken('standaloneToken', makeToken('other@example.com', 'v3', 'r3'));
    diff = tokenManager.diffAgainstSwitchState(tokenManager.readSwitchState());
    assert.ok(diff.conflicts.some(item => item.kind === 'file' && item.email === 'other@example.com'));

    fs.unlinkSync(tokenPath('standaloneToken'));
    diff = tokenManager.diffAgainstSwitchState(tokenManager.readSwitchState());
    assert.ok(diff.missing.some(item => item.path === tokenPath('standaloneToken')));
});

test('diffAgainstSwitchState reports a missing database', async () => {
    resetState();
    const missingDb = path.join(root, 'gone', 'state.vscdb');
    tokenManager.writeSwitchState({
        targetEmail: 'missing@example.com',
        files: [],
        databases: [{ path: missingDb, email: 'missing@example.com' }]
    });

    const diff = tokenManager.diffAgainstSwitchState(tokenManager.readSwitchState());
    assert.ok(diff.missing.some(item => item.kind === 'database' && item.path === missingDb));
});

test('restoreProfile skips a database without ItemTable instead of aborting', async () => {
    if (!DatabaseSync) return;
    resetState();
    const emptyDb = path.join(root, 'empty-db', 'state.vscdb');
    fs.mkdirSync(path.dirname(emptyDb), { recursive: true });
    fs.writeFileSync(emptyDb, '', 'utf-8');
    process.env.AGY_SWITCH_DB_PATHS = `${dbPath}${path.delimiter}${emptyDb}`;

    const result = tokenManager.restoreProfile({
        email: 'skip@example.com',
        complete: true,
        db_tokens: {
            antigravityAuthStatus: JSON.stringify({ email: 'skip@example.com', apiKey: '' })
        },
        file_tokens: {
            standaloneToken: makeToken('skip@example.com')
        }
    });

    assert.strictEqual(result.verification.ok, true);
    assert.ok((result.db.skippedPaths || []).some(item => item.includes(emptyDb)));
    process.env.AGY_SWITCH_DB_PATHS = dbPath;
});

test('snapshotActiveAccount keeps the incomplete-profile warning visible', async () => {
    resetState();
    writeToken('cliToken', makeToken('warn@example.com'));
    const entry = tokenManager.snapshotActiveAccount('Warn', 'warn@example.com');

    assert.strictEqual(entry.complete, false);
    assert.ok(tokenManager.getLastLoadWarnings().some(warning => /database/i.test(warning)));
});

test('restoreProfile reports a divergent second database', async () => {
    if (!DatabaseSync) return;
    resetState();
    const secondDb = path.join(root, 'db2', 'state.vscdb');
    createDbAt(secondDb);
    process.env.AGY_SWITCH_DB_PATHS = `${dbPath}${path.delimiter}${secondDb}`;

    setDbRows({ antigravityAuthStatus: JSON.stringify({ email: 'target@example.com' }) });
    withDbAt(secondDb, db => {
        db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
            .run('antigravityAuthStatus', JSON.stringify({ email: 'other@example.com' }));
    });
    writeToken('cliToken', makeToken('target@example.com'));

    assert.throws(
        () => tokenManager.restoreProfile({
            email: 'target@example.com',
            complete: false,
            db_tokens: {},
            file_tokens: { cliToken: makeToken('target@example.com') }
        }),
        /Switch verification failed/
    );

    process.env.AGY_SWITCH_DB_PATHS = dbPath;
});

test('canonicalEmail collapses Gmail aliases and dots', async () => {
    assert.strictEqual(tokenManager.canonicalEmail('User.Name+work@googlemail.com'), 'username@gmail.com');
    assert.strictEqual(tokenManager.canonicalEmail('User.Name@example.com'), 'user.name@example.com');
});

test('detectSessions reports a database with two identities and snapshot refuses', async () => {
    if (!DatabaseSync) return;
    resetState();
    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'auth@example.com' }),
        'google.google-antigravity': JSON.stringify({
            'antigravity-storage': { 'agy.onboarding.lastLoginUsername': 'onboard@example.com' }
        })
    });
    writeToken('cliToken', makeToken('auth@example.com'));

    const session = tokenManager.detectActiveSession();
    assert.ok(session.conflicts.some(conflict => conflict.type === 'database-identity-mismatch'));
    assert.throws(
        () => tokenManager.snapshotActiveAccount('Mixed', 'auth@example.com'),
        /conflicting identities|stores disagree/i
    );
});

test('loadProfiles merges Gmail aliases into one profile', async () => {
    resetState();
    const profilePath = path.join(home, '.gemini', 'antigravity_profiles.json');
    fs.writeFileSync(profilePath, JSON.stringify({
        'user@gmail.com': {
            email: 'user@gmail.com',
            label: 'Primary',
            saved_at: '2026-01-02T00:00:00Z',
            db_tokens: {},
            file_tokens: { cliToken: makeToken('user@gmail.com') }
        },
        'user+work@gmail.com': {
            email: 'user+work@gmail.com',
            label: 'Work',
            saved_at: '2026-01-01T00:00:00Z',
            db_tokens: {},
            file_tokens: { cliToken: makeToken('user+work@gmail.com') }
        }
    }), 'utf-8');

    const profiles = tokenManager.loadProfiles();
    assert.deepStrictEqual(Object.keys(profiles), ['user@gmail.com']);
    assert.ok(profiles['user@gmail.com'].aliases.includes('user+work@gmail.com'));
});

test('loadProfiles merges profiles that share a refresh-token fingerprint', async () => {
    resetState();
    const first = makeToken('one@example.com', 'a1', 'same-refresh');
    const second = makeToken('two@example.com', 'a2', 'same-refresh');
    const fingerprint = tokenManager.tokenFingerprint(first);
    const profilePath = path.join(home, '.gemini', 'antigravity_profiles.json');
    fs.writeFileSync(profilePath, JSON.stringify({
        'one@example.com': {
            email: 'one@example.com',
            label: 'One',
            saved_at: '2026-01-02T00:00:00Z',
            db_tokens: {},
            file_tokens: { standaloneToken: first },
            fingerprints: { standaloneToken: fingerprint }
        },
        'two@example.com': {
            email: 'two@example.com',
            label: 'Two',
            saved_at: '2026-01-01T00:00:00Z',
            db_tokens: {},
            file_tokens: { standaloneToken: second },
            fingerprints: { standaloneToken: fingerprint }
        }
    }), 'utf-8');

    const profiles = tokenManager.loadProfiles();
    assert.deepStrictEqual(Object.keys(profiles), ['one@example.com']);
    assert.ok(profiles['one@example.com'].aliases.includes('two@example.com'));
});

test('snapshotActiveAccount makes duplicate labels unique', async () => {
    resetState();
    writeToken('cliToken', makeToken('first@example.com'));
    const first = tokenManager.snapshotActiveAccount('Work', 'first@example.com');
    assert.strictEqual(first.label, 'Work');

    writeToken('cliToken', makeToken('second@example.com', 'access-2', 'refresh-2'));
    const second = tokenManager.snapshotActiveAccount('Work', 'second@example.com');
    assert.strictEqual(second.label, 'Work 2');
});

test('snapshotActiveAccount rejects an email that contradicts the database identity', async () => {
    if (!DatabaseSync) return;
    resetState();
    setDbRows({ antigravityAuthStatus: JSON.stringify({ email: 'db@example.com' }) });
    writeToken('cliToken', { token: { access_token: 'a', refresh_token: 'r' } });

    assert.throws(
        () => tokenManager.snapshotActiveAccount('Ghost', 'ghost@example.com'),
        /belongs to db@example.com/i
    );
    const entry = tokenManager.snapshotActiveAccount('Db', 'db@example.com');
    assert.strictEqual(entry.email, 'db@example.com');
});

test('switchToLoginSession applies a fresh login to every store', async () => {
    if (!DatabaseSync) return;
    resetState();
    writeToken('cliToken', makeToken('old@example.com', 'old-a', 'old-r'));
    writeToken('standaloneToken', makeToken('new@example.com', 'new-a', 'new-r'));
    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'old@example.com' }),
        'google.google-antigravity': JSON.stringify({
            'antigravity-storage': { 'agy.onboarding.lastLoginUsername': 'old@example.com' }
        })
    });

    const candidate = {
        path: tokenPath('standaloneToken'),
        category: 'standaloneToken',
        email: 'new@example.com'
    };
    const { entry } = tokenManager.switchToLoginSession(candidate, 'New');
    assert.strictEqual(entry.email, 'new@example.com');

    for (const category of ['cliToken', 'standaloneToken']) {
        for (const tokenPathValue of tokenManager.getTokenFilePaths()[category]) {
            const token = JSON.parse(fs.readFileSync(tokenPathValue, 'utf-8'));
            assert.strictEqual(token.id_token_email, 'new@example.com');
        }
    }
    assert.strictEqual(JSON.parse(readDbValue('antigravityAuthStatus')).email, 'new@example.com');
    const session = tokenManager.detectActiveSession();
    assert.strictEqual(session.conflicts.length, 0);
    assert.ok(tokenManager.loadProfiles()['new@example.com']);
});

test('restoreProfile refreshes legacy profile metadata', async () => {
    if (!DatabaseSync) return;
    resetState();
    setDbRows({
        antigravityAuthStatus: JSON.stringify({ email: 'legacy@example.com' }),
        'google.google-antigravity': JSON.stringify({
            'antigravity-storage': { 'agy.onboarding.lastLoginUsername': 'legacy@example.com' }
        })
    });
    writeToken('cliToken', makeToken('legacy@example.com'));
    const profilePath = path.join(home, '.gemini', 'antigravity_profiles.json');
    fs.writeFileSync(profilePath, JSON.stringify({
        'legacy@example.com': {
            email: 'legacy@example.com',
            label: 'Legacy',
            saved_at: '2026-01-01T00:00:00Z',
            db_tokens: {},
            file_tokens: { cliToken: makeToken('legacy@example.com') }
        }
    }), 'utf-8');

    const entry = tokenManager.loadProfiles()['legacy@example.com'];
    tokenManager.restoreProfile(entry);

    const refreshed = tokenManager.loadProfiles()['legacy@example.com'];
    assert.ok(refreshed.fingerprints.cliToken);
    assert.ok(refreshed.account_id);
    assert.ok(refreshed.db_tokens_by_path[dbPath]);
    assert.strictEqual(refreshed.complete, true);
});

test('classifySurfaceCommand identifies Antigravity surfaces', async () => {
    assert.strictEqual(tokenManager.classifySurfaceCommand('C:\\Apps\\Antigravity.exe').kind, 'desktop-win');
    assert.strictEqual(tokenManager.classifySurfaceCommand('C:\\Apps\\Antigravity IDE.exe').kind, 'ide-win');
    assert.strictEqual(
        tokenManager.classifySurfaceCommand('/home/u/.antigravity-server/bin/2.28.2/language_server --standalone --app_data_dir antigravity').kind,
        'desktop-wsl'
    );
    assert.strictEqual(
        tokenManager.classifySurfaceCommand('/home/u/.antigravity-ide-server/bin/2.6.0/node /out/server-main.js --start-server').kind,
        'ide-wsl'
    );
    assert.strictEqual(
        tokenManager.classifySurfaceCommand('/home/u/.gemini/bin/agy --hub --hub-port=45530').kind,
        'agent-hub'
    );
    assert.strictEqual(tokenManager.classifySurfaceCommand('/home/u/.gemini/bin/agy').kind, 'cli');
    assert.strictEqual(tokenManager.classifySurfaceCommand('node other.js'), null);
    assert.strictEqual(
        tokenManager.classifySurfaceCommand('C:\\Apps\\Antigravity IDE.exe --type=renderer --user-data-dir=C:\\x'),
        null
    );
    assert.strictEqual(
        tokenManager.classifySurfaceCommand('/home/u/.antigravity-ide-server/bin/2.6.0/node /out/bootstrap-fork --type=extensionHost'),
        null
    );
});

test('evaluateSurfaces marks stale and duplicate surfaces', async () => {
    const report = tokenManager.evaluateSurfaces([
        { pid: 1, kind: 'desktop-wsl', label: 'Desktop', startedAtMs: 1000 },
        { pid: 2, kind: 'desktop-wsl', label: 'Desktop', startedAtMs: 2600 },
        { pid: 3, kind: 'ide-wsl', label: 'IDE', startedAtMs: 3000 }
    ], new Date(2500).toISOString());

    assert.strictEqual(report.stale.length, 1);
    assert.strictEqual(report.stale[0].pid, 1);
    assert.deepStrictEqual(report.duplicates, [{ kind: 'desktop-wsl', count: 2 }]);
});

test('getDoctorReport flags a stale surface during a conflict', async () => {
    resetState();
    writeToken('standaloneToken', makeToken('ide@example.com'));
    writeToken('cliToken', makeToken('stale@example.com'));
    tokenManager.writeSwitchState({
        targetEmail: 'ide@example.com',
        appliedAt: new Date(Date.now() - 60000).toISOString()
    });

    const report = tokenManager.getDoctorReport({
        preferredStore: 'standaloneToken',
        keyring: { available: false },
        surfaces: [{
            pid: 123,
            kind: 'desktop-wsl',
            label: 'Antigravity Desktop 2.0 (WSL backend)',
            startedAtMs: Date.now() - 120000,
            source: 'test'
        }]
    });

    assert.strictEqual(report.ok, false);
    assert.ok(report.warnings.some(warning => warning.code === 'stale-surface'));
    assert.ok(report.warnings.some(warning => warning.code === 'store-conflict'));
});

test('parseKeyringReport keeps only redacted metadata', async () => {
    const report = tokenManager.parseKeyringReport({
        Found: true,
        TargetName: 'gemini:antigravity',
        UserName: 'antigravity',
        BlobLength: 579,
        Emails: ['other@example.com'],
        HasRefresh: true,
        HasAccess: true,
        HasIdToken: true
    });

    assert.strictEqual(report.available, true);
    assert.strictEqual(report.email, 'other@example.com');
    assert.strictEqual(report.hasRefreshToken, true);
    assert.strictEqual(report.managed, false);
    assert.ok(!('raw' in report));
    assert.ok(!JSON.stringify(report).includes('refresh_token'));
});

test('getDoctorReport flags a keyring mismatch', async () => {
    resetState();
    writeToken('standaloneToken', makeToken('ide@example.com'));

    const report = tokenManager.getDoctorReport({
        preferredStore: 'standaloneToken',
        surfaces: [],
        keyring: {
            available: true,
            provider: 'windows-credential-manager',
            target: 'gemini:antigravity',
            email: 'other@example.com'
        }
    });

    assert.strictEqual(report.ok, false);
    assert.ok(report.warnings.some(warning => warning.code === 'keyring-mismatch'));
});

test('getPermissionWarnings flags group-readable token files', async () => {
    if (process.platform === 'win32') return;
    resetState();
    writeToken('cliToken', makeToken('perm@example.com'));
    fs.chmodSync(tokenPath('cliToken'), 0o644);

    assert.ok(tokenManager.getPermissionWarnings().some(warning => warning.path === tokenPath('cliToken')));
    fs.chmodSync(tokenPath('cliToken'), 0o600);
    assert.ok(!tokenManager.getPermissionWarnings().some(warning => warning.path === tokenPath('cliToken')));
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
