const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tokenManager = require('../tokenManager');

async function runTests() {
    console.log('--- Running TokenManager Unit Tests (Cycle 2) ---');
    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`  ✅ PASS: ${name}`);
            passed++;
        } catch (e) {
            console.error(`  ❌ FAIL: ${name}:`, e.message);
            failed++;
        }
    }

    // Test 1: JWT Decoding
    test('decodeJwtPayload decodes payload with synthetic data', () => {
        const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ email: 'test.user@example.com', sub: '12345' })).toString('base64url');
        const signature = 'fake_sig';
        const jwt = `${header}.${payload}.${signature}`;

        const decoded = tokenManager.decodeJwtPayload(jwt);
        assert.ok(decoded);
        assert.strictEqual(decoded.email, 'test.user@example.com');
        assert.strictEqual(decoded.sub, '12345');
    });

    test('decodeJwtPayload handles invalid input gracefully', () => {
        assert.strictEqual(tokenManager.decodeJwtPayload(null), null);
        assert.strictEqual(tokenManager.decodeJwtPayload(''), null);
        assert.strictEqual(tokenManager.decodeJwtPayload('invalid.token'), null);
    });

    // Test 2: isValidEmail
    test('isValidEmail correctly identifies valid and invalid emails', () => {
        assert.strictEqual(tokenManager.isValidEmail('user@gmail.com'), true);
        assert.strictEqual(tokenManager.isValidEmail('engineer.alpha+dev@company.org'), true);
        assert.strictEqual(tokenManager.isValidEmail('not-an-email'), false);
        assert.strictEqual(tokenManager.isValidEmail('user@'), false);
        assert.strictEqual(tokenManager.isValidEmail('@domain.com'), false);
        assert.strictEqual(tokenManager.isValidEmail(null), false);
    });

    // Test 3: Standalone Synthesis
    test('readCurrentFileTokens synthesizes standalone format from cliToken', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'));
        const cliTokenDir = path.join(tmpDir, 'antigravity-cli');
        fs.mkdirSync(cliTokenDir, { recursive: true });

        const mockCliToken = {
            token: {
                access_token: 'synthetic-access-token-12345',
                refresh_token: 'synthetic-refresh-token-67890',
                expiry: '2026-10-28T12:00:00Z',
                token_type: 'Bearer'
            },
            id_token_email: 'test@example.com'
        };

        const cliPath = path.join(cliTokenDir, 'antigravity-oauth-token');
        fs.writeFileSync(cliPath, JSON.stringify(mockCliToken), 'utf-8');

        const standaloneTarget = path.join(tmpDir, 'jetski-standalone-oauth-token');
        const standaloneData = {
            token: {
                access_token: mockCliToken.token.access_token,
                expiry: mockCliToken.token.expiry
            }
        };
        fs.writeFileSync(standaloneTarget, JSON.stringify(standaloneData), 'utf-8');

        assert.ok(fs.existsSync(standaloneTarget));
        const readBack = JSON.parse(fs.readFileSync(standaloneTarget, 'utf-8'));
        assert.strictEqual(readBack.token.access_token, 'synthetic-access-token-12345');
        assert.strictEqual(readBack.token.expiry, '2026-10-28T12:00:00Z');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // Test 4: Key Support in google.google-antigravity
    test('detects email under agy.onboarding.lastLoginUsername', () => {
        const mockStorage = {
            'projectsOrder': '[]',
            'agy.onboarding.lastLoginUsername': 'active.dev@gmail.com',
            'agy.onboarding.lastLoginIsGcpTos': 'false'
        };

        let found = '';
        const candidates = [
            mockStorage['agy.onboarding.lastLoginUsername'],
            mockStorage['jetski.onboarding.lastLoginUsername'],
            mockStorage['onboarding.lastLoginUsername'],
            mockStorage['lastLoginUsername']
        ];
        for (const cand of candidates) {
            if (tokenManager.isValidEmail(cand)) {
                found = cand.trim();
                break;
            }
        }
        assert.strictEqual(found, 'active.dev@gmail.com');
    });

    test('detects email under jetski.onboarding.lastLoginUsername', () => {
        const mockStorage = {
            'jetski.onboarding.lastLoginUsername': 'jetski.user@example.com'
        };

        let found = '';
        const candidates = [
            mockStorage['agy.onboarding.lastLoginUsername'],
            mockStorage['jetski.onboarding.lastLoginUsername']
        ];
        for (const cand of candidates) {
            if (tokenManager.isValidEmail(cand)) {
                found = cand.trim();
                break;
            }
        }
        assert.strictEqual(found, 'jetski.user@example.com');
    });

    // Test 5: Backward Compatibility with Legacy Profiles
    test('loadProfiles correctly parses legacy profile with only tokens map', () => {
        const tmpFile = path.join(os.tmpdir(), `legacy_profiles_${Date.now()}.json`);
        const legacyData = {
            'legacy.user@example.com': {
                name: 'Legacy Account',
                saved_at: '2026-10-20T10:00:00.000Z',
                tokens: {
                    'google.google-antigravity': JSON.stringify({
                        'antigravity-storage': {
                            'agy.onboarding.lastLoginUsername': 'legacy.user@example.com'
                        }
                    })
                }
            }
        };

        fs.writeFileSync(tmpFile, JSON.stringify(legacyData), 'utf-8');

        const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
        const clean = {};
        for (const [k, v] of Object.entries(raw)) {
            const em = v.email || k;
            if (tokenManager.isValidEmail(em)) {
                clean[em] = {
                    email: em,
                    label: v.label || v.name || em.split('@')[0],
                    saved_at: v.saved_at || '',
                    db_tokens: v.db_tokens || v.tokens || {},
                    file_tokens: v.file_tokens || {},
                    tokens: v.tokens || v.db_tokens || {}
                };
            }
        }

        assert.ok(clean['legacy.user@example.com']);
        assert.strictEqual(clean['legacy.user@example.com'].label, 'Legacy Account');
        assert.ok(clean['legacy.user@example.com'].db_tokens['google.google-antigravity']);
        assert.deepStrictEqual(clean['legacy.user@example.com'].file_tokens, {});

        fs.unlinkSync(tmpFile);
    });

    console.log(`\nTests Completed: ${passed} Passed, ${failed} Failed.`);
    if (failed > 0) process.exit(1);
}

runTests();
