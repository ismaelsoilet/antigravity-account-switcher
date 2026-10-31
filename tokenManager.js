'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let DatabaseSync = null;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch {
    DatabaseSync = null;
}

const DB_AUTH_KEYS = [
    'antigravityUnifiedStateSync.oauthToken',
    'antigravityUnifiedStateSync.userStatus',
    'antigravityUnifiedStateSync.modelCredits',
    'antigravityAuthStatus',
    'google.google-antigravity'
];

const DB_SESSION_KEYS = DB_AUTH_KEYS.filter(key => key !== 'google.google-antigravity');
const FILE_CATEGORIES = ['standaloneToken', 'cliToken', 'oauthCreds'];
const FILE_KEY_ALIASES = {
    cliToken: 'cliToken',
    cli_token: 'cliToken',
    standaloneToken: 'standaloneToken',
    standalone_token: 'standaloneToken',
    oauthCreds: 'oauthCreds',
    oauth_creds: 'oauthCreds'
};
const EMAIL_REGEX = /^[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+$/;
const FILE_MODE = 0o600;
const VERSION = '1.7.3';
const SWITCH_STATE_FILE = 'antigravity_switch_state.json';
const SWITCH_LOCK_FILE = '.antigravity-switch.lock';
const SWITCH_LOCK_STALE_MS = 15000;
const SWITCH_LOCK_ATTEMPTS = 3;
const SWITCH_LOCK_RETRY_MS = 200;
const PROFILE_SCHEMA_VERSION = 2;

let lastLoadWarnings = [];

function isValidEmail(value) {
    if (!value || typeof value !== 'string') return false;
    return EMAIL_REGEX.test(value.trim());
}

function normalizeEmail(value) {
    return isValidEmail(value) ? value.trim().toLowerCase() : '';
}

function canonicalEmail(value) {
    const email = normalizeEmail(value);
    if (!email) return '';
    const [local, domain] = email.split('@');
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
        return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
    }
    return email;
}

function uniqueStrings(values) {
    return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function tokenFingerprint(token) {
    const payload = getTokenPayload(token);
    if (!payload) return '';
    const secret = nonEmptyString(payload.refresh_token)
        ? payload.refresh_token
        : (nonEmptyString(payload.access_token) ? payload.access_token : '');
    if (!nonEmptyString(secret)) return '';
    return crypto.createHash('sha256').update(secret).digest('hex');
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readdirSafe(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

function isWindowsSystemUser(name) {
    return /^(public|default|default user|all users|desktop\.ini)$/i.test(name);
}

let resolvedWindowsHome = null;
let resolvedWindowsHomeAt = 0;

function resolveCurrentWindowsHome() {
    if (process.platform !== 'linux') return null;
    const now = Date.now();
    if (resolvedWindowsHome !== null && now - resolvedWindowsHomeAt < 60000) {
        return resolvedWindowsHome || null;
    }
    resolvedWindowsHomeAt = now;
    resolvedWindowsHome = '';

    try {
        const raw = execFileSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], {
            encoding: 'utf-8',
            timeout: 1500,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (!raw) return null;
        const converted = execFileSync('wslpath', ['-u', raw], {
            encoding: 'utf-8',
            timeout: 1500,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (converted && fs.existsSync(converted)) {
            resolvedWindowsHome = converted;
            return converted;
        }
    } catch {}
    return null;
}

function getWindowsHomeDirs() {
    if (process.platform === 'win32') return [];

    if (process.env.ANTIGRAVITY_WIN_HOME) {
        return process.env.ANTIGRAVITY_WIN_HOME.split(path.delimiter).filter(Boolean);
    }

    const current = resolveCurrentWindowsHome();
    if (current) return [current];

    const roots = [];
    if (process.platform === 'linux') roots.push('/mnt/c/Users');
    try {
        const parent = path.dirname(os.homedir());
        if (/[\\/]Users$/i.test(parent)) roots.push(parent);
    } catch {}

    const homes = [];
    for (const root of new Set(roots)) {
        for (const entry of readdirSafe(root)) {
            if (!entry.isDirectory() || isWindowsSystemUser(entry.name)) continue;
            const full = path.join(root, entry.name);
            const looksUsed = ['.gemini', '.antigravity-ide', '.antigravity']
                .some(name => fs.existsSync(path.join(full, name)));
            if (looksUsed) homes.push(full);
        }
    }
    return homes;
}

let homeCache = { key: null, value: null };

function getHomeCacheKey() {
    return `${process.env.AGY_SWITCH_HOME || ''}|${process.env.HOME || ''}|${os.homedir()}`;
}

function refreshPaths() {
    homeCache = { key: null, value: null };
    resolvedWindowsHome = null;
    resolvedWindowsHomeAt = 0;
}

function getAllCandidateHomeDirs() {
    const cacheKey = getHomeCacheKey();
    if (homeCache.key === cacheKey && homeCache.value) {
        return [...homeCache.value];
    }

    const explicit = process.env.AGY_SWITCH_HOME;
    if (explicit) {
        const homes = [...new Set(explicit.split(path.delimiter).map(item => item.trim()).filter(Boolean))];
        homeCache = { key: cacheKey, value: homes };
        return [...homes];
    }

    const candidates = [];
    for (const home of [os.homedir(), process.env.HOME, process.env.USERPROFILE]) {
        if (home) candidates.push(home);
    }
    candidates.push(...getWindowsHomeDirs());

    const valid = [];
    for (const home of new Set(candidates)) {
        try {
            if (fs.existsSync(home)) valid.push(path.resolve(home));
        } catch {}
    }
    homeCache = { key: cacheKey, value: [...new Set(valid)] };
    return [...homeCache.value];
}

function getGeminiDirs() {
    return [...new Set(getAllCandidateHomeDirs().map(home => path.join(home, '.gemini')))];
}

function getTokenFilePaths() {
    const paths = { cliToken: [], standaloneToken: [], oauthCreds: [] };
    for (const geminiDir of getGeminiDirs()) {
        paths.cliToken.push(path.join(geminiDir, 'antigravity-cli', 'antigravity-oauth-token'));
        paths.standaloneToken.push(path.join(geminiDir, 'jetski-standalone-oauth-token'));
        paths.oauthCreds.push(path.join(geminiDir, 'oauth_creds.json'));
    }
    return {
        cliToken: [...new Set(paths.cliToken)],
        standaloneToken: [...new Set(paths.standaloneToken)],
        oauthCreds: [...new Set(paths.oauthCreds)]
    };
}

function getDbPaths() {
    const explicit = process.env.AGY_SWITCH_DB_PATHS;
    if (explicit) {
        return [...new Set(explicit.split(path.delimiter).map(item => item.trim()).filter(Boolean))];
    }

    const candidates = [];
    for (const home of getAllCandidateHomeDirs()) {
        candidates.push(path.join(home, 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
        candidates.push(path.join(home, 'AppData', 'Roaming', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
        candidates.push(path.join(home, '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
        candidates.push(path.join(home, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
        candidates.push(path.join(home, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
        candidates.push(path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
    }
    if (process.env.APPDATA) {
        candidates.push(path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
        candidates.push(path.join(process.env.APPDATA, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
    }

    const valid = [];
    for (const candidate of new Set(candidates)) {
        try {
            if (fs.existsSync(candidate)) valid.push(candidate);
        } catch {}
    }
    return [...new Set(valid)];
}

function getProfilesFilePaths() {
    return [...new Set(getGeminiDirs().map(dir => path.join(dir, 'antigravity_profiles.json')))];
}

function getSwitchStatePaths() {
    return [...new Set(getGeminiDirs().map(dir => path.join(dir, SWITCH_STATE_FILE)))];
}

function getLockPaths() {
    return [...new Set(getGeminiDirs().map(dir => path.join(dir, SWITCH_LOCK_FILE)))];
}

function initialize() {
    refreshPaths();
    return {
        homes: getAllCandidateHomeDirs(),
        geminiDirs: getGeminiDirs(),
        dbPaths: getDbPaths(),
        tokenPaths: getTokenFilePaths()
    };
}

function isDbSupportAvailable() {
    return Boolean(DatabaseSync);
}

function statSafe(filePath) {
    try {
        return fs.statSync(filePath);
    } catch {
        return null;
    }
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function storeHomeLabel(filePath) {
    if (filePath.startsWith('/mnt/c/') || /^[A-Za-z]:[\\/]/.test(filePath)) return 'win';
    if (process.platform === 'win32') return 'win';
    return 'wsl';
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
        const end = Date.now() + ms;
        while (Date.now() < end) {}
    }
}

function acquireSwitchLock() {
    const targets = getLockPaths().sort();
    const acquired = [];

    const tryAcquire = () => {
        for (const lockPath of targets) {
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            try {
                const fd = fs.openSync(lockPath, 'wx', FILE_MODE);
                try {
                    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
                } finally {
                    fs.closeSync(fd);
                }
                acquired.push(lockPath);
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                const stat = statSafe(lockPath);
                if (stat && Date.now() - stat.mtimeMs > SWITCH_LOCK_STALE_MS) {
                    try {
                        fs.unlinkSync(lockPath);
                    } catch {}
                    const fd = fs.openSync(lockPath, 'wx', FILE_MODE);
                    try {
                        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
                    } finally {
                        fs.closeSync(fd);
                    }
                    acquired.push(lockPath);
                    continue;
                }
                throw new Error(`Another account switch is in progress (${lockPath}).`);
            }
        }
    };

    let lastError = null;
    for (let attempt = 0; attempt < SWITCH_LOCK_ATTEMPTS; attempt += 1) {
        try {
            tryAcquire();
            let released = false;
            return {
                release() {
                    if (released) return;
                    released = true;
                    for (const lockPath of acquired.reverse()) {
                        try {
                            fs.unlinkSync(lockPath);
                        } catch {}
                    }
                }
            };
        } catch (error) {
            lastError = error;
            for (const lockPath of acquired.splice(0)) {
                try {
                    fs.unlinkSync(lockPath);
                } catch {}
            }
            if (attempt < SWITCH_LOCK_ATTEMPTS - 1) sleepSync(SWITCH_LOCK_RETRY_MS);
        }
    }
    throw lastError || new Error('Could not acquire the account switch lock.');
}

function normalizeStoreCategory(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === 'cliToken' || raw === 'cli') return 'cliToken';
    if (raw === 'oauthCreds' || raw === 'oauth') return 'oauthCreds';
    return 'standaloneToken';
}

function getLastLoadWarnings() {
    return [...lastLoadWarnings];
}

function readSwitchState() {
    for (const statePath of getSwitchStatePaths()) {
        try {
            if (!fs.existsSync(statePath)) continue;
            const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {}
    }
    return {};
}

function writeSwitchState(state) {
    const data = JSON.stringify(state, null, 2);
    const written = [];
    const failed = [];
    for (const statePath of getSwitchStatePaths()) {
        try {
            writeFileAtomic(statePath, data, FILE_MODE);
            written.push(statePath);
        } catch (error) {
            failed.push(`${statePath}: ${error.message}`);
        }
    }
    if (failed.length > 0) {
        lastLoadWarnings.push(`Could not persist the switch state: ${failed.join(' | ')}`);
    }
    return { written, failed };
}

function clearSwitchState() {
    const failed = [];
    for (const statePath of getSwitchStatePaths()) {
        try {
            if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
        } catch (error) {
            failed.push(`${statePath}: ${error.message}`);
        }
    }
    return { failed };
}

function getStoreMtimeSignature() {
    const parts = [];
    for (const category of FILE_CATEGORIES) {
        for (const tokenPath of getTokenFilePaths()[category]) {
            const stat = statSafe(tokenPath);
            parts.push(`${tokenPath}:${stat ? stat.mtimeMs : 0}:${stat ? stat.size : 0}`);
        }
    }
    for (const dbPath of getDbPaths()) {
        const stat = statSafe(dbPath);
        parts.push(`${dbPath}:${stat ? stat.mtimeMs : 0}:${stat ? stat.size : 0}`);
    }
    return sha256(parts.join('|'));
}

function getStoreSnapshot() {
    const files = [];
    for (const category of FILE_CATEGORIES) {
        for (const tokenPath of getTokenFilePaths()[category]) {
            const stat = statSafe(tokenPath);
            if (!stat) {
                files.push({ path: tokenPath, category, exists: false, email: '', sha256: '', mtimeMs: 0 });
                continue;
            }
            let content = '';
            try {
                content = fs.readFileSync(tokenPath, 'utf-8');
            } catch {}
            const parsed = safeJsonParse(content);
            files.push({
                path: tokenPath,
                category,
                exists: true,
                email: parsed ? extractEmailFromToken(parsed) : '',
                sha256: sha256(content),
                mtimeMs: stat.mtimeMs
            });
        }
    }
    const databases = readDbStores().map(store => ({
        path: store.path,
        email: store.email,
        identityEmails: store.identityEmails || [],
        identityConflict: Boolean(store.identityConflict),
        hasOauthToken: Boolean(store.hasOauthToken),
        mtimeMs: store.mtimeMs
    }));
    return { files, databases };
}

function diffAgainstSwitchState(state) {
    const targetEmail = state && state.targetEmail ? state.targetEmail : '';
    if (!targetEmail) {
        return { targetEmail: '', refreshes: [], conflicts: [], missing: [] };
    }

    const snapshot = getStoreSnapshot();
    const expected = new Map((state.files || []).map(file => [file.path, file]));
    const refreshes = [];
    const conflicts = [];
    const missing = [];

    const targetCanonical = canonicalEmail(targetEmail);

    for (const file of snapshot.files) {
        const previous = expected.get(file.path);
        if (!previous || !previous.exists) {
            if (file.exists && file.email && canonicalEmail(file.email) !== targetCanonical) {
                conflicts.push({
                    kind: 'file',
                    path: file.path,
                    category: file.category,
                    email: file.email,
                    expectedEmail: targetEmail
                });
            }
            continue;
        }
        if (!file.exists) {
            missing.push({ kind: 'file', path: file.path, category: file.category });
            continue;
        }
        if (file.email && canonicalEmail(file.email) !== targetCanonical) {
            conflicts.push({
                kind: 'file',
                path: file.path,
                category: file.category,
                email: file.email,
                expectedEmail: targetEmail
            });
            continue;
        }
        if (file.sha256 !== previous.sha256) {
            refreshes.push({
                kind: 'file',
                path: file.path,
                category: file.category,
                email: file.email,
                expectedEmail: targetEmail
            });
        }
    }

    for (const database of snapshot.databases) {
        const currentEmails = (database.identityEmails || []).length > 0
            ? database.identityEmails
            : (database.email ? [database.email] : []);
        if (currentEmails.length > 1 || currentEmails.some(email => canonicalEmail(email) !== targetCanonical)) {
            conflicts.push({
                kind: 'database',
                path: database.path,
                email: currentEmails.join(', '),
                emails: currentEmails,
                expectedEmail: targetEmail
            });
        }
    }

    for (const expectedDatabase of (state.databases || [])) {
        if (!snapshot.databases.some(database => database.path === expectedDatabase.path)) {
            missing.push({ kind: 'database', path: expectedDatabase.path });
        }
    }

    return { targetEmail, refreshes, conflicts, missing };
}

function buildSwitchState(entry, verification) {
    const snapshot = getStoreSnapshot();
    return {
        version: 1,
        targetEmail: entry.email,
        targetLabel: entry.label || entry.email.split('@')[0],
        appliedAt: new Date().toISOString(),
        pid: process.pid,
        platform: process.platform,
        complete: Boolean(entry.complete),
        files: snapshot.files,
        databases: snapshot.databases,
        verification: {
            ok: Boolean(verification && verification.ok),
            files: verification ? verification.files : [],
            missingFiles: verification ? verification.missingFiles : [],
            databases: verification ? verification.dbs : []
        }
    };
}

function decodeJwtPayload(jwt) {
    if (!jwt || typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    try {
        let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4 !== 0) base64 += '=';
        return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    } catch {
        return null;
    }
}

function getTokenPayload(content) {
    if (!content || typeof content !== 'object') return null;
    return content.token && typeof content.token === 'object' ? content.token : content;
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function parseExpiry(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value > 1e12 ? value : value * 1000);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const numeric = Number(trimmed);
        if (Number.isFinite(numeric)) {
            return new Date(numeric > 1e12 ? numeric : numeric * 1000);
        }
        const parsed = new Date(trimmed);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
}

function isAccessTokenExpired(content) {
    const payload = getTokenPayload(content);
    if (!payload) return false;
    const expiry = parseExpiry(payload.expiry ?? payload.expires_at ?? payload.expiresAt);
    return expiry ? expiry.getTime() <= Date.now() : false;
}

function hasTokenStrings(content) {
    const payload = getTokenPayload(content);
    if (!payload) return false;
    return nonEmptyString(payload.access_token) || nonEmptyString(payload.refresh_token);
}

function hasUsableTokens(content) {
    const payload = getTokenPayload(content);
    if (!payload) return false;
    if (nonEmptyString(payload.refresh_token)) return true;
    if (!nonEmptyString(payload.access_token)) return false;
    return !isAccessTokenExpired(content);
}

function extractEmailFromToken(content) {
    if (!content || typeof content !== 'object') return '';
    if (isValidEmail(content.id_token_email)) return normalizeEmail(content.id_token_email);
    if (isValidEmail(content.email)) return normalizeEmail(content.email);

    const payload = getTokenPayload(content);
    if (payload && payload.id_token) {
        const decoded = decodeJwtPayload(payload.id_token);
        if (decoded && isValidEmail(decoded.email)) return normalizeEmail(decoded.email);
    }
    if (content.id_token) {
        const decoded = decodeJwtPayload(content.id_token);
        if (decoded && isValidEmail(decoded.email)) return normalizeEmail(decoded.email);
    }
    return '';
}

function toText(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf-8');
    return String(value);
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function readDbStore(dbPath) {
    if (!DatabaseSync) return null;
    let db;
    try {
        db = openDatabase(dbPath, true, 1000);
        const statement = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
        const tokens = {};
        for (const key of DB_AUTH_KEYS) {
            const row = statement.get(key);
            const text = row ? toText(row.value) : null;
            if (text !== null) tokens[key] = text;
        }

        let authStatusEmail = '';
        const status = safeJsonParse(tokens['antigravityAuthStatus'] || '');
        if (status && isValidEmail(status.email)) authStatusEmail = normalizeEmail(status.email);

        const onboardingEmails = [];
        const google = safeJsonParse(tokens['google.google-antigravity'] || '');
        const storage = google && google['antigravity-storage'];
        if (storage && typeof storage === 'object') {
            for (const key of [
                'agy.onboarding.lastLoginUsername',
                'jetski.onboarding.lastLoginUsername',
                'onboarding.lastLoginUsername',
                'lastLoginUsername'
            ]) {
                if (isValidEmail(storage[key])) onboardingEmails.push(normalizeEmail(storage[key]));
            }
        }

        const identityEmails = uniqueStrings([authStatusEmail, ...onboardingEmails]);
        const identityConflict = identityEmails.length > 1;
        const email = identityConflict ? '' : (identityEmails[0] || '');

        const stat = statSafe(dbPath);
        const rawOauthToken = tokens['antigravityUnifiedStateSync.oauthToken'];
        const hasOauthToken = typeof rawOauthToken === 'string'
            && rawOauthToken.trim().length > 2
            && rawOauthToken.trim() !== '{}'
            && rawOauthToken.trim() !== 'null';
        const hasIdentity = Boolean(tokens['antigravityAuthStatus'] || tokens['google.google-antigravity']);
        return {
            path: dbPath,
            kind: 'database',
            category: 'database',
            home: storeHomeLabel(dbPath),
            email,
            authStatusEmail,
            identityEmails,
            identityConflict,
            tokens,
            mtimeMs: stat ? stat.mtimeMs : 0,
            size: stat ? stat.size : 0,
            usable: true,
            hasToken: hasOauthToken,
            hasIdentity,
            hasOauthToken,
            needsEmail: !email
        };
    } catch {
        return null;
    } finally {
        try {
            if (db) db.close();
        } catch {}
    }
}

function readDbStores() {
    return getDbPaths().map(readDbStore).filter(Boolean);
}

function readCurrentDbTokensByPath() {
    const output = {};
    for (const store of readDbStores()) output[store.path] = store.tokens;
    return output;
}

function readTokenStore(category, tokenPath) {
    const stat = statSafe(tokenPath);
    if (!stat || !stat.isFile()) return null;
    let content;
    try {
        content = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    } catch {
        return null;
    }
    if (!hasTokenStrings(content)) return null;
    const email = extractEmailFromToken(content);
    return {
        path: tokenPath,
        kind: 'file',
        category,
        home: storeHomeLabel(tokenPath),
        email,
        canonicalEmail: canonicalEmail(email),
        fingerprint: tokenFingerprint(content),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        usable: hasUsableTokens(content),
        hasToken: true,
        needsEmail: !email
    };
}

function readFileStores() {
    const output = [];
    const paths = getTokenFilePaths();
    for (const category of FILE_CATEGORIES) {
        for (const tokenPath of paths[category]) {
            const store = readTokenStore(category, tokenPath);
            if (store) output.push(store);
        }
    }
    return output;
}

function selectPrimaryStore(stores, targetEmail, preferredStore) {
    if (!stores.length) return null;
    if (targetEmail) {
        const wanted = canonicalEmail(targetEmail);
        const exact = stores.find(store => canonicalEmail(store.email) === wanted);
        if (exact) return exact;
    }
    const order = normalizeStoreCategory(preferredStore) === 'cliToken'
        ? ['cliToken', 'standaloneToken', 'oauthCreds']
        : ['standaloneToken', 'cliToken', 'oauthCreds'];
    for (const category of order) {
        const hit = stores.find(store => store.category === category && store.email);
        if (hit) return hit;
    }
    const withEmail = stores.find(store => store.email);
    if (withEmail) return withEmail;
    return stores[0];
}

function detectSessions(options = {}) {
    const dbStores = readDbStores();
    const dbIdentityEmails = uniqueStrings(dbStores.flatMap(store => store.identityEmails || []));
    const dbEmail = dbIdentityEmails.length === 1 ? dbIdentityEmails[0] : '';
    const fileStores = readFileStores().map(store => (
        !store.email && dbEmail
            ? { ...store, email: dbEmail, canonicalEmail: canonicalEmail(dbEmail), needsEmail: false }
            : store
    ));
    const stores = [...fileStores, ...dbStores];
    const usable = stores.filter(store => store.usable && store.hasToken && !store.identityConflict);

    const identityEntries = [];
    for (const store of stores) {
        const emails = store.kind === 'database'
            ? (store.identityEmails || [])
            : (store.email ? [store.email] : []);
        for (const email of emails) {
            identityEntries.push({
                path: store.path,
                category: store.category,
                home: store.home,
                email
            });
        }
    }

    const state = readSwitchState();
    const primary = selectPrimaryStore(
        usable,
        state.targetEmail || '',
        options.preferredStore || 'standaloneToken'
    );

    const emails = uniqueStrings(identityEntries.map(entry => entry.email));
    const conflicts = [];
    if (emails.length > 1) {
        conflicts.push({ type: 'multiple-emails', emails, stores: identityEntries });
    }
    for (const store of stores) {
        if (store.identityConflict) {
            conflicts.push({
                type: 'database-identity-mismatch',
                path: store.path,
                home: store.home,
                emails: store.identityEmails || []
            });
        }
    }
    if (state.targetEmail && emails.some(email => email !== state.targetEmail)) {
        conflicts.push({
            type: 'target-mismatch',
            targetEmail: state.targetEmail,
            emails,
            stores: identityEntries.filter(entry => entry.email !== state.targetEmail)
        });
    }

    return {
        isActive: Boolean(primary && primary.usable && primary.email),
        hasToken: Boolean(primary && primary.hasToken),
        needsEmail: Boolean(primary && primary.needsEmail),
        email: primary ? primary.email : '',
        canonicalEmail: primary ? canonicalEmail(primary.email) : '',
        source: primary ? primary.path : null,
        category: primary ? primary.category : null,
        fingerprint: primary ? primary.fingerprint : '',
        mtimeMs: primary ? primary.mtimeMs : 0,
        targetEmail: state.targetEmail || '',
        stores: stores.map(store => ({
            path: store.path,
            kind: store.kind,
            category: store.category,
            home: store.home,
            email: store.email,
            canonicalEmail: store.canonicalEmail || '',
            fingerprint: store.fingerprint || '',
            authStatusEmail: store.authStatusEmail || '',
            identityEmails: store.identityEmails || [],
            identityConflict: Boolean(store.identityConflict),
            mtimeMs: store.mtimeMs,
            size: store.size,
            usable: store.usable,
            hasToken: store.hasToken,
            hasIdentity: Boolean(store.hasIdentity),
            hasOauthToken: Boolean(store.hasOauthToken),
            needsEmail: store.needsEmail
        })),
        conflicts
    };
}

function detectActiveSession(options) {
    return detectSessions(options);
}

function detectActiveEmail() {
    return detectActiveSession().email;
}

function normalizeFileTokens(raw) {
    const output = { cliToken: null, standaloneToken: null, oauthCreds: null };
    if (!raw || typeof raw !== 'object') return output;

    for (const [key, value] of Object.entries(raw)) {
        const canonical = FILE_KEY_ALIASES[key];
        if (!canonical) continue;
        let token = value;
        if (typeof token === 'string') token = safeJsonParse(token);
        if (!token || typeof token !== 'object') continue;
        if (!hasTokenStrings(token)) continue;
        output[canonical] = clone(token);
    }

    if (!output.standaloneToken && output.cliToken) {
        output.standaloneToken = clone(output.cliToken);
    }
    if (!output.cliToken && output.standaloneToken) {
        output.cliToken = clone(output.standaloneToken);
    }
    return output;
}

function normalizeDbTokens(raw) {
    const output = {};
    if (!raw || typeof raw !== 'object') return output;
    for (const [key, value] of Object.entries(raw)) {
        if (value === null || value === undefined) continue;
        const text = toText(value);
        if (text !== null) output[key] = text;
    }
    return output;
}

function normalizeProfileEntry(raw, fallbackKey) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const email = normalizeEmail(raw.email || fallbackKey);
    if (!email) return null;

    const dbTokens = normalizeDbTokens(raw.db_tokens || raw.tokens);
    const fileTokens = normalizeFileTokens(raw.file_tokens);
    const label = typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim()
        : (typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : email.split('@')[0]);

    const aliases = Array.isArray(raw.aliases)
        ? uniqueStrings(raw.aliases.filter(isValidEmail).map(normalizeEmail))
        : [];
    const fingerprints = {};
    if (raw.fingerprints && typeof raw.fingerprints === 'object' && !Array.isArray(raw.fingerprints)) {
        for (const [key, value] of Object.entries(raw.fingerprints)) {
            const canonical = FILE_KEY_ALIASES[key];
            if (canonical && typeof value === 'string' && value.trim()) {
                fingerprints[canonical] = value.trim();
            }
        }
    }

    return {
        ...raw,
        email,
        label,
        saved_at: typeof raw.saved_at === 'string' ? raw.saved_at : '',
        aliases,
        fingerprints,
        account_id: typeof raw.account_id === 'string' ? raw.account_id.trim() : '',
        db_tokens: dbTokens,
        file_tokens: fileTokens,
        tokens: dbTokens
    };
}

function profileIdentitySet(profile) {
    const set = new Set();
    if (profile.email) set.add(`email:${canonicalEmail(profile.email)}`);
    for (const alias of profile.aliases || []) {
        if (isValidEmail(alias)) set.add(`email:${canonicalEmail(alias)}`);
    }
    for (const fingerprint of Object.values(profile.fingerprints || {})) {
        if (fingerprint) set.add(`fp:${fingerprint}`);
    }
    if (profile.account_id) set.add(`id:${profile.account_id}`);
    return set;
}

function findProfileByIdentity(profiles, entry) {
    const wanted = profileIdentitySet(entry);
    if (wanted.size === 0) return null;
    for (const profile of Object.values(profiles)) {
        const existing = profileIdentitySet(profile);
        if ([...wanted].some(key => existing.has(key))) return profile;
    }
    return null;
}

function mergeProfileEntries(existing, incoming) {
    const newer = (incoming.saved_at || '') >= (existing.saved_at || '') ? incoming : existing;
    const older = newer === incoming ? existing : incoming;
    const primaryEmail = String(existing.email || '').toLowerCase();
    const aliases = uniqueStrings([
        ...(existing.aliases || []),
        ...(incoming.aliases || []),
        existing.email,
        incoming.email
    ]).filter(alias => alias.toLowerCase() !== primaryEmail);

    return {
        ...older,
        ...newer,
        email: existing.email,
        label: existing.label || incoming.label,
        aliases,
        fingerprints: { ...(existing.fingerprints || {}), ...(incoming.fingerprints || {}) },
        account_id: existing.account_id || incoming.account_id,
        db_tokens: newer.db_tokens || older.db_tokens,
        db_tokens_by_path: newer.db_tokens_by_path || older.db_tokens_by_path,
        file_tokens: newer.file_tokens || older.file_tokens,
        tokens: newer.tokens || older.tokens,
        complete: newer.complete !== undefined ? newer.complete : older.complete,
        saved_at: newer.saved_at || older.saved_at
    };
}

function normalizeProfilesMap(profiles) {
    const byEmail = {};
    if (!profiles || typeof profiles !== 'object') return byEmail;
    for (const [key, value] of Object.entries(profiles)) {
        const entry = normalizeProfileEntry(value, key);
        if (!entry) continue;
        const previous = byEmail[entry.email];
        if (!previous || (entry.saved_at && (!previous.saved_at || entry.saved_at >= previous.saved_at))) {
            byEmail[entry.email] = entry;
        }
    }

    const output = {};
    const ordered = Object.values(byEmail).sort((left, right) => (
        String(right.saved_at || '').localeCompare(String(left.saved_at || ''))
    ));
    for (const profile of ordered) {
        const existing = findProfileByIdentity(output, profile);
        if (existing && existing.email !== profile.email) {
            output[existing.email] = mergeProfileEntries(existing, profile);
        } else {
            output[profile.email] = profile;
        }
    }
    return output;
}

function loadProfiles() {
    lastLoadWarnings = [];
    for (const profilePath of getProfilesFilePaths()) {
        let rawText;
        try {
            if (!fs.existsSync(profilePath)) continue;
            rawText = fs.readFileSync(profilePath, 'utf-8');
        } catch (error) {
            lastLoadWarnings.push(`Could not read vault ${profilePath}: ${error.message}`);
            continue;
        }

        let raw;
        try {
            raw = JSON.parse(rawText);
        } catch (error) {
            lastLoadWarnings.push(`Vault is not valid JSON (${profilePath}): ${error.message}`);
            continue;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            lastLoadWarnings.push(`Vault has an unexpected format: ${profilePath}`);
            continue;
        }

        return normalizeProfilesMap(raw);
    }
    return {};
}

function writeFileAtomic(filePath, content, mode = FILE_MODE) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );

    let fd = null;
    try {
        fd = fs.openSync(tempPath, 'w', mode);
        fs.writeFileSync(fd, content, 'utf-8');
        try {
            fs.fsyncSync(fd);
        } catch {}
        fs.closeSync(fd);
        fd = null;
        try {
            fs.chmodSync(tempPath, mode);
        } catch {}
        fs.renameSync(tempPath, filePath);
        try {
            fs.chmodSync(filePath, mode);
        } catch {}
    } catch (error) {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {}
        }
        try {
            fs.unlinkSync(tempPath);
        } catch {}
        throw error;
    }
}

function backupExistingVault(filePath) {
    let content;
    try {
        if (!fs.existsSync(filePath)) return;
        content = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return;
    }

    const valid = safeJsonParse(content) !== null;
    const backupPath = valid
        ? `${filePath}.bak`
        : `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileAtomic(backupPath, content, FILE_MODE);
}

function saveProfiles(profiles) {
    const normalized = normalizeProfilesMap(profiles);
    const data = JSON.stringify(normalized, null, 2);
    const targets = getProfilesFilePaths();
    if (targets.length === 0) {
        throw new Error('No Antigravity vault path is available.');
    }

    const written = [];
    const failed = [];
    for (const target of targets) {
        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            backupExistingVault(target);
            writeFileAtomic(target, data, FILE_MODE);
            written.push(target);
        } catch (error) {
            failed.push(`${target}: ${error.message}`);
        }
    }

    if (written.length === 0) {
        throw new Error(`Could not write the profile vault. ${failed.join(' | ')}`);
    }
    if (failed.length > 0) {
        throw new Error(`Profile vault was only partially written. ${failed.join(' | ')}`);
    }
    return { written };
}

function openDatabase(dbPath, readOnly, busyTimeout = 5000) {
    const db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
    try {
        db.exec(`PRAGMA busy_timeout = ${Number(busyTimeout) || 5000}`);
    } catch {}
    return db;
}

function readCurrentDbTokens() {
    const tokens = {};
    if (!DatabaseSync) return tokens;
    for (const store of readDbStores()) {
        for (const key of DB_AUTH_KEYS) {
            if (Object.prototype.hasOwnProperty.call(tokens, key)) continue;
            const value = store.tokens[key];
            if (value !== undefined && value !== null) tokens[key] = value;
        }
    }
    return tokens;
}

function readCurrentFileTokens(activeEmail) {
    const paths = getTokenFilePaths();
    const result = { cliToken: null, standaloneToken: null, oauthCreds: null };
    const wantedEmail = activeEmail ? normalizeEmail(activeEmail) : '';

    for (const category of FILE_CATEGORIES) {
        for (const tokenPath of paths[category]) {
            try {
                if (!fs.existsSync(tokenPath)) continue;
                const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
                if (!parsed || typeof parsed !== 'object' || !hasTokenStrings(parsed)) continue;
                const tokenEmail = extractEmailFromToken(parsed);
                if (wantedEmail && tokenEmail && tokenEmail !== wantedEmail) continue;
                result[category] = parsed;
                break;
            } catch {
                // Try the next candidate.
            }
        }
    }

    if (!result.standaloneToken && result.cliToken) {
        result.standaloneToken = clone(result.cliToken);
    }
    if (!result.cliToken && result.standaloneToken) {
        result.cliToken = clone(result.standaloneToken);
    }
    return result;
}

function patchTokenEmail(fileTokens, email) {
    for (const category of ['cliToken', 'standaloneToken']) {
        const token = fileTokens[category];
        if (token && typeof token === 'object') token.id_token_email = email;
    }
}

function patchDbIdentity(dbTokens, email) {
    if (!email) return dbTokens;

    let agData = {};
    if (dbTokens['google.google-antigravity']) {
        const parsed = safeJsonParse(dbTokens['google.google-antigravity']);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) agData = parsed;
    }
    if (!agData['antigravity-storage'] || typeof agData['antigravity-storage'] !== 'object') {
        agData['antigravity-storage'] = {};
    }
    const storage = agData['antigravity-storage'];
    storage['agy.onboarding.lastLoginUsername'] = email;
    storage['jetski.onboarding.lastLoginUsername'] = email;
    storage['agy.onboarding.lastLoginIsGcpTos'] = 'false';
    storage['jetski.onboarding.lastLoginIsGcpTos'] = 'false';
    dbTokens['google.google-antigravity'] = JSON.stringify(agData);

    let status = {};
    if (dbTokens['antigravityAuthStatus']) {
        const parsed = safeJsonParse(dbTokens['antigravityAuthStatus']);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) status = parsed;
    }
    status.email = email;
    if (typeof status.apiKey !== 'string') status.apiKey = '';
    dbTokens['antigravityAuthStatus'] = JSON.stringify(status);
    return dbTokens;
}

function buildDbTokensForRestore(profileDbTokens, currentDbTokens, email) {
    const output = { ...profileDbTokens };

    let agData = {};
    const agRaw = profileDbTokens['google.google-antigravity'] ?? currentDbTokens['google.google-antigravity'];
    if (agRaw) {
        const parsed = safeJsonParse(agRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) agData = parsed;
    }
    if (!agData['antigravity-storage'] || typeof agData['antigravity-storage'] !== 'object') {
        agData['antigravity-storage'] = {};
    }
    agData['antigravity-storage']['agy.onboarding.lastLoginUsername'] = email;
    agData['antigravity-storage']['jetski.onboarding.lastLoginUsername'] = email;
    agData['antigravity-storage']['agy.onboarding.lastLoginIsGcpTos'] = 'false';
    agData['antigravity-storage']['jetski.onboarding.lastLoginIsGcpTos'] = 'false';
    output['google.google-antigravity'] = JSON.stringify(agData);

    let status = {};
    if (profileDbTokens['antigravityAuthStatus']) {
        const parsed = safeJsonParse(profileDbTokens['antigravityAuthStatus']);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) status = parsed;
    }
    status.email = email;
    if (typeof status.apiKey !== 'string') status.apiKey = '';
    output['antigravityAuthStatus'] = JSON.stringify(status);

    return output;
}

function writeTokensToDbs(dbTokens, options = {}) {
    const {
        replaceSessionKeys = false,
        deleteKeys = [],
        dbPaths = null
    } = options;
    const paths = Array.isArray(dbPaths) ? dbPaths : getDbPaths();
    if (paths.length === 0) {
        return { skipped: true, written: [], failed: [] };
    }
    if (!DatabaseSync) {
        throw new Error('This Antigravity host does not provide the node:sqlite runtime required to update the IDE database.');
    }

    const keysToDelete = replaceSessionKeys
        ? DB_SESSION_KEYS
        : DB_SESSION_KEYS.filter(key => deleteKeys.includes(key));

    const written = [];
    const failed = [];
    const skipped = [];
    for (const dbPath of paths) {
        let db;
        try {
            db = openDatabase(dbPath, false);
            db.exec('BEGIN IMMEDIATE');
            if (keysToDelete.length > 0) {
                const deleteStatement = db.prepare('DELETE FROM ItemTable WHERE key = ?');
                for (const key of keysToDelete) deleteStatement.run(key);
            }
            const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
            for (const [key, value] of Object.entries(dbTokens)) {
                if (value === null || value === undefined) continue;
                upsert.run(key, toText(value));
            }
            db.exec('COMMIT');
            written.push(dbPath);
        } catch (error) {
            try {
                if (db) db.exec('ROLLBACK');
            } catch {}
            if (/no such table:\s*ItemTable/i.test(error.message)) {
                skipped.push(`${dbPath}: missing ItemTable`);
            } else {
                failed.push(`${dbPath}: ${error.message}`);
            }
        } finally {
            try {
                if (db) db.close();
            } catch {}
        }
    }

    if (written.length === 0 && failed.length === 0) {
        return { skipped: true, written: [], failed: [], skipped };
    }
    if (written.length === 0) {
        throw new Error(`Could not write the Antigravity database. ${failed.join(' | ')}`);
    }
    if (failed.length > 0) {
        throw new Error(`Antigravity database was only partially written. ${failed.join(' | ')}`);
    }
    return { skipped: false, written, failed, skipped };
}

function writeDbSnapshot(dbPath, tokens) {
    if (!DatabaseSync) throw new Error('node:sqlite is unavailable.');
    let db;
    try {
        db = openDatabase(dbPath, false, 5000);
        db.exec('BEGIN IMMEDIATE');
        const deleteStatement = db.prepare('DELETE FROM ItemTable WHERE key = ?');
        const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
        for (const key of DB_AUTH_KEYS) {
            const value = tokens[key];
            if (value === null || value === undefined) {
                deleteStatement.run(key);
            } else {
                upsert.run(key, toText(value));
            }
        }
        db.exec('COMMIT');
    } catch (error) {
        try {
            if (db) db.exec('ROLLBACK');
        } catch {}
        throw error;
    } finally {
        try {
            if (db) db.close();
        } catch {}
    }
}

function writeTokensToFiles(fileTokens, email) {
    const normalized = normalizeFileTokens(fileTokens);
    if (email) patchTokenEmail(normalized, email);

    const paths = getTokenFilePaths();
    const written = [];
    const removed = [];
    const failed = [];

    for (const category of FILE_CATEGORIES) {
        const token = normalized[category];
        const targets = paths[category];

        if (!token) {
            for (const target of targets) {
                try {
                    if (fs.existsSync(target)) {
                        fs.unlinkSync(target);
                        removed.push(target);
                    }
                } catch (error) {
                    failed.push(`${target}: ${error.message}`);
                }
            }
            continue;
        }

        const content = JSON.stringify(token, null, 2);
        for (const target of targets) {
            try {
                writeFileAtomic(target, content, FILE_MODE);
                written.push(target);
            } catch (error) {
                failed.push(`${target}: ${error.message}`);
            }
        }
    }

    if (failed.length > 0) {
        throw new Error(`Could not update OAuth token files. ${failed.join(' | ')}`);
    }
    return { written, removed, failed };
}

function normalizeDbTokensByPath(raw) {
    const output = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return output;
    for (const [dbPath, tokens] of Object.entries(raw)) {
        if (!tokens || typeof tokens !== 'object') continue;
        const normalized = normalizeDbTokens(tokens);
        if (Object.keys(normalized).length > 0) output[dbPath] = normalized;
    }
    return output;
}

function mergeDbTokensByPath(byPath) {
    const output = {};
    for (const tokens of Object.values(byPath)) {
        for (const [key, value] of Object.entries(tokens)) {
            if (!Object.prototype.hasOwnProperty.call(output, key)) output[key] = value;
        }
    }
    return output;
}

function captureCurrentState() {
    const files = {};
    for (const category of FILE_CATEGORIES) {
        for (const tokenPath of getTokenFilePaths()[category]) {
            const stat = statSafe(tokenPath);
            if (!stat) {
                files[tokenPath] = { exists: false };
                continue;
            }
            try {
                files[tokenPath] = {
                    exists: true,
                    content: fs.readFileSync(tokenPath, 'utf-8'),
                    mode: stat.mode & 0o777
                };
            } catch {
                files[tokenPath] = { exists: null };
            }
        }
    }

    const databases = {};
    for (const store of readDbStores()) {
        const tokens = {};
        for (const key of DB_AUTH_KEYS) {
            tokens[key] = Object.prototype.hasOwnProperty.call(store.tokens, key) ? store.tokens[key] : null;
        }
        databases[store.path] = tokens;
    }
    return { files, databases };
}

function restoreCapturedState(captured) {
    const failed = [];
    for (const [filePath, value] of Object.entries(captured.files || {})) {
        try {
            if (value.exists === true) {
                writeFileAtomic(filePath, value.content, value.mode || FILE_MODE);
            } else if (value.exists === false && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (error) {
            failed.push(`${filePath}: ${error.message}`);
        }
    }
    for (const [dbPath, tokens] of Object.entries(captured.databases || {})) {
        try {
            writeDbSnapshot(dbPath, tokens);
        } catch (error) {
            failed.push(`${dbPath}: ${error.message}`);
        }
    }
    if (failed.length > 0) {
        lastLoadWarnings.push(`Rollback was incomplete: ${failed.join(' | ')}`);
    }
    return { failed };
}

function verifyRestore(entry) {
    const email = entry.email;
    const wanted = canonicalEmail(email);
    const fileStores = readFileStores();
    const files = fileStores.map(store => ({
        path: store.path,
        category: store.category,
        email: store.email,
        matches: canonicalEmail(store.email) === wanted
    }));

    const missingFiles = [];
    for (const category of FILE_CATEGORIES) {
        if (!entry.file_tokens || !entry.file_tokens[category]) continue;
        for (const tokenPath of getTokenFilePaths()[category]) {
            if (!fs.existsSync(tokenPath)) missingFiles.push({ path: tokenPath, category });
        }
    }

    const dbs = readDbStores().map(store => {
        const identityEmails = store.identityEmails || [];
        return {
            path: store.path,
            email: store.email,
            identityEmails,
            hasOauthToken: Boolean(store.hasOauthToken),
            matches: identityEmails.length === 0
                || (identityEmails.length === 1 && canonicalEmail(identityEmails[0]) === wanted)
        };
    });

    const filesOk = files.every(file => !file.email || file.matches) && missingFiles.length === 0;
    const dbsOk = dbs.every(database => database.matches);
    return { ok: filesOk && dbsOk, files, missingFiles, dbs };
}

function writeProfileDbTokens(entry, email) {
    const dbPaths = getDbPaths();
    if (dbPaths.length === 0) {
        return { skipped: true, written: [], failed: [], reason: 'no Antigravity database found' };
    }

    const byPath = normalizeDbTokensByPath(entry.db_tokens_by_path);
    const merged = normalizeDbTokens(entry.db_tokens);
    if (Object.keys(byPath).length === 0 && Object.keys(merged).length === 0) {
        return { skipped: true, written: [], failed: [], reason: 'profile has no database tokens' };
    }

    const written = [];
    const failed = [];
    const skippedPaths = [];
    for (const dbPath of dbPaths) {
        const tokens = byPath[dbPath] || merged;
        if (Object.keys(tokens).length === 0) continue;
        const current = readDbStore(dbPath);
        if (!current) {
            skippedPaths.push(`${dbPath}: unreadable database or missing ItemTable`);
            continue;
        }
        const prepared = buildDbTokensForRestore(tokens, current.tokens, email);
        try {
            const result = writeTokensToDbs(prepared, { dbPaths: [dbPath] });
            written.push(...result.written);
            if (result.skipped) skippedPaths.push(...result.skipped);
        } catch (error) {
            failed.push(error.message);
        }
    }

    if (written.length === 0 && failed.length > 0) {
        throw new Error(`Could not write the Antigravity database. ${failed.join(' | ')}`);
    }
    if (failed.length > 0) {
        throw new Error(`Antigravity database was only partially written. ${failed.join(' | ')}`);
    }
    return {
        skipped: written.length === 0 && skippedPaths.length > 0,
        written,
        failed,
        skippedPaths
    };
}

function makeUniqueLabel(profiles, email, requestedLabel) {
    let candidate = String(requestedLabel || '').trim() || email.split('@')[0];
    const taken = new Set(
        Object.values(profiles)
            .filter(profile => canonicalEmail(profile.email) !== canonicalEmail(email))
            .map(profile => String(profile.label || '').trim().toLowerCase())
            .filter(Boolean)
    );
    if (!taken.has(candidate.toLowerCase())) return candidate;
    let index = 2;
    while (taken.has(`${candidate} ${index}`.toLowerCase())) index += 1;
    return `${candidate} ${index}`;
}

function snapshotActiveAccount(customLabel, manualEmail) {
    const lock = acquireSwitchLock();
    try {
        const session = detectActiveSession();
        if (!session.hasToken) {
            throw new Error('No active Antigravity session was detected. Sign in first.');
        }

        const requestedEmail = manualEmail ? normalizeEmail(manualEmail) : '';
        if (manualEmail && !requestedEmail) {
            throw new Error('The provided email address is not valid.');
        }

        const blockingConflicts = (session.conflicts || []).filter(
            conflict => conflict.type === 'multiple-emails' || conflict.type === 'database-identity-mismatch'
        );
        if (blockingConflicts.length > 0) {
            const detail = blockingConflicts.map(conflict => (
                conflict.type === 'database-identity-mismatch'
                    ? `${conflict.path}: ${conflict.emails.join(' vs ')}`
                    : `emails: ${conflict.emails.join(' vs ')}`
            )).join(' | ');
            throw new Error(`The Antigravity stores disagree about the active account (${detail}). Resolve the conflict before saving a profile.`);
        }

        const evidenceEmails = uniqueStrings(session.stores.flatMap(store => (
            store.kind === 'database' ? (store.identityEmails || []) : [store.email]
        )));
        const email = requestedEmail || session.email;
        if (!email) {
            throw new Error('An active session was found, but its email could not be determined. Sign in again or provide the email explicitly.');
        }

        const profiles = loadProfiles();
        if (requestedEmail) {
            const wanted = canonicalEmail(requestedEmail);
            const evidenceMatch = evidenceEmails.some(candidate => canonicalEmail(candidate) === wanted);
            const existingIdentity = findProfileByIdentity(profiles, { email: requestedEmail });
            if (!evidenceMatch && !existingIdentity && evidenceEmails.length > 0) {
                throw new Error(`The active session belongs to ${evidenceEmails.join(', ')}, not ${requestedEmail}.`);
            }
        }

        const dbPaths = getDbPaths();
        if (dbPaths.length > 0 && !DatabaseSync) {
            throw new Error('This Antigravity host does not provide the node:sqlite runtime required to snapshot the IDE database.');
        }

        const dbStores = readDbStores();
        const conflictingDbs = dbStores.filter(store => store.identityConflict);
        if (conflictingDbs.length > 0) {
            const detail = conflictingDbs.map(store => `${store.path}: ${store.identityEmails.join(' vs ')}`).join(' | ');
            throw new Error(`The Antigravity database contains conflicting identities (${detail}). Sign in again before saving a profile.`);
        }

        const matchingStores = dbStores.filter(store => (
            (store.identityEmails || []).some(candidate => canonicalEmail(candidate) === canonicalEmail(email))
        ));
        if (dbStores.length > 0 && matchingStores.length === 0) {
            lastLoadWarnings.push(
                'No database matched the active email; the profile was saved without database identity. Sign in live and save it again.'
            );
        }
        const selectedStores = matchingStores;
        const dbTokensByPath = {};
        for (const store of selectedStores) {
            const tokens = normalizeDbTokens(store.tokens);
            patchDbIdentity(tokens, email);
            if (Object.keys(tokens).length > 0) dbTokensByPath[store.path] = tokens;
        }
        const dbTokens = mergeDbTokensByPath(dbTokensByPath);
        const hasDbIdentity = Object.values(dbTokensByPath).some(
            tokens => Boolean(tokens['antigravityAuthStatus'] || tokens['google.google-antigravity'])
        );
        if (dbStores.length > 0 && !hasDbIdentity) {
            lastLoadWarnings.push(
                'Profile saved without an Antigravity database identity (antigravityAuthStatus); sign in live and save it again before switching.'
            );
        }

        const fileTokens = readCurrentFileTokens(email);
        if (!fileTokens.cliToken && !fileTokens.standaloneToken && !fileTokens.oauthCreds) {
            throw new Error('No OAuth token files were found for the active session.');
        }
        patchTokenEmail(fileTokens, email);
        const hasFileTokens = Boolean(fileTokens.cliToken || fileTokens.standaloneToken || fileTokens.oauthCreds);
        const complete = hasFileTokens && (dbStores.length === 0 || hasDbIdentity);
        const fingerprints = {};
        for (const category of FILE_CATEGORIES) {
            if (!fileTokens[category]) continue;
            const fingerprint = tokenFingerprint(fileTokens[category]);
            if (fingerprint) fingerprints[category] = fingerprint;
        }
        const accountId = fingerprints.standaloneToken
            || fingerprints.cliToken
            || fingerprints.oauthCreds
            || canonicalEmail(email);

        for (const category of FILE_CATEGORIES) {
            for (const tokenPath of getTokenFilePaths()[category]) {
                try {
                    if (fs.existsSync(tokenPath)) fs.chmodSync(tokenPath, FILE_MODE);
                } catch {}
            }
        }

        const previous = profiles[email] || {};
        const aliases = uniqueStrings([
            ...(previous.aliases || []),
            email
        ]).filter(alias => alias.toLowerCase() !== email.toLowerCase());
        const rawLabel = customLabel && customLabel.trim()
            ? customLabel.trim()
            : (previous.label || email.split('@')[0]);
        let entry = {
            ...previous,
            schema: PROFILE_SCHEMA_VERSION,
            email,
            label: makeUniqueLabel(profiles, email, rawLabel),
            saved_at: new Date().toISOString(),
            complete,
            aliases,
            account_id: previous.account_id || accountId,
            fingerprints: { ...(previous.fingerprints || {}), ...fingerprints },
            db_tokens: dbTokens,
            db_tokens_by_path: dbTokensByPath,
            file_tokens: fileTokens,
            tokens: dbTokens
        };

        const existing = findProfileByIdentity(profiles, entry);
        if (existing && existing.email.toLowerCase() !== email.toLowerCase()) {
            entry = mergeProfileEntries(existing, entry);
            profiles[existing.email] = entry;
            delete profiles[email];
            lastLoadWarnings.push(
                `Merged ${email} into the existing profile ${existing.email} because they share the same identity.`
            );
        } else {
            profiles[email] = entry;
        }
        saveProfiles(profiles);

        for (const [dbPath, tokens] of Object.entries(dbTokensByPath)) {
            try {
                writeTokensToDbs(tokens, { dbPaths: [dbPath] });
            } catch (error) {
                lastLoadWarnings.push(`Could not persist the database identity for ${dbPath}: ${error.message}`);
            }
        }

        return entry;
    } finally {
        lock.release();
    }
}

function buildLoginProfile(candidate, label) {
    if (!candidate || !candidate.path) {
        throw new Error('No fresh login token was found.');
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(candidate.path, 'utf-8'));
    } catch (error) {
        throw new Error(`Could not read the fresh login token: ${error.message}`);
    }
    if (!hasTokenStrings(parsed)) {
        throw new Error('The fresh login token is not usable.');
    }
    const email = normalizeEmail(candidate.email) || extractEmailFromToken(parsed);
    if (!email) {
        throw new Error('Could not determine the email of the fresh login.');
    }
    const category = FILE_KEY_ALIASES[candidate.category] || 'standaloneToken';
    const fileTokens = normalizeFileTokens({ [category]: parsed });
    patchTokenEmail(fileTokens, email);

    const dbTokensByPath = {};
    for (const store of readDbStores()) {
        const tokens = normalizeDbTokens(store.tokens);
        patchDbIdentity(tokens, email);
        if (Object.keys(tokens).length > 0) dbTokensByPath[store.path] = tokens;
    }
    const dbTokens = mergeDbTokensByPath(dbTokensByPath);
    const hasDbIdentity = Object.values(dbTokensByPath).some(
        tokens => Boolean(tokens['antigravityAuthStatus'] || tokens['google.google-antigravity'])
    );
    const complete = getDbPaths().length === 0 || hasDbIdentity;

    const fingerprints = {};
    for (const key of FILE_CATEGORIES) {
        if (!fileTokens[key]) continue;
        const fingerprint = tokenFingerprint(fileTokens[key]);
        if (fingerprint) fingerprints[key] = fingerprint;
    }
    const accountId = fingerprints.standaloneToken
        || fingerprints.cliToken
        || fingerprints.oauthCreds
        || canonicalEmail(email);
    const profiles = loadProfiles();
    const rawLabel = label && label.trim() ? label.trim() : email.split('@')[0];

    return {
        schema: PROFILE_SCHEMA_VERSION,
        email,
        label: makeUniqueLabel(profiles, email, rawLabel),
        saved_at: new Date().toISOString(),
        complete,
        aliases: [],
        account_id: accountId,
        fingerprints,
        db_tokens: dbTokens,
        db_tokens_by_path: dbTokensByPath,
        file_tokens: fileTokens,
        tokens: dbTokens
    };
}

function switchToLoginSession(candidate, label) {
    const entry = buildLoginProfile(candidate, label);
    const result = restoreProfile(entry);

    const profiles = loadProfiles();
    const existing = findProfileByIdentity(profiles, entry);
    let savedEntry = entry;
    if (existing && existing.email.toLowerCase() !== entry.email.toLowerCase()) {
        savedEntry = mergeProfileEntries(existing, entry);
        profiles[existing.email] = savedEntry;
        delete profiles[entry.email];
    } else {
        savedEntry = { ...entry, saved_at: new Date().toISOString() };
        profiles[entry.email] = savedEntry;
    }
    saveProfiles(profiles);
    return { entry: savedEntry, result };
}

function refreshProfileMetadata(entry, verification) {
    if (!verification || !verification.ok) return null;
    const profiles = loadProfiles();
    const existing = findProfileByIdentity(profiles, { email: entry.email });
    if (!existing) return null;

    const email = entry.email;
    const wanted = canonicalEmail(email);
    const fileTokens = readCurrentFileTokens(email);
    if (!fileTokens.cliToken && !fileTokens.standaloneToken && !fileTokens.oauthCreds) {
        return null;
    }
    patchTokenEmail(fileTokens, email);

    const dbTokensByPath = {};
    for (const store of readDbStores()) {
        const identityEmails = store.identityEmails || [];
        if (!identityEmails.some(candidate => canonicalEmail(candidate) === wanted)) continue;
        const tokens = normalizeDbTokens(store.tokens);
        patchDbIdentity(tokens, email);
        if (Object.keys(tokens).length > 0) dbTokensByPath[store.path] = tokens;
    }
    const dbTokens = mergeDbTokensByPath(dbTokensByPath);
    const fingerprints = {};
    for (const category of FILE_CATEGORIES) {
        if (!fileTokens[category]) continue;
        const fingerprint = tokenFingerprint(fileTokens[category]);
        if (fingerprint) fingerprints[category] = fingerprint;
    }
    const accountId = fingerprints.standaloneToken
        || fingerprints.cliToken
        || fingerprints.oauthCreds
        || canonicalEmail(email);
    const complete = getDbPaths().length === 0 || Object.keys(dbTokensByPath).length > 0;

    const refreshed = {
        ...existing,
        schema: PROFILE_SCHEMA_VERSION,
        email: existing.email,
        complete,
        fingerprints: { ...(existing.fingerprints || {}), ...fingerprints },
        account_id: existing.account_id || accountId,
        db_tokens: dbTokens,
        db_tokens_by_path: dbTokensByPath,
        file_tokens: fileTokens,
        tokens: dbTokens
    };
    profiles[existing.email] = refreshed;
    try {
        saveProfiles(profiles);
    } catch (error) {
        lastLoadWarnings.push(`Could not refresh the profile metadata: ${error.message}`);
    }
    return refreshed;
}

function restoreProfile(profile) {
    const entry = normalizeProfileEntry(profile, profile && profile.email);
    if (!entry) {
        throw new Error('Invalid or incomplete profile.');
    }

    const lock = acquireSwitchLock();
    let captured = null;
    try {
        captured = captureCurrentState();
        const fileResult = writeTokensToFiles(entry.file_tokens, entry.email);
        const dbResult = writeProfileDbTokens(entry, entry.email);
        const verification = verifyRestore(entry);

        if (!verification.ok) {
            const diverged = [
                ...verification.files.filter(file => file.email && !file.matches)
                    .map(file => `${file.path}=${file.email}`),
                ...verification.dbs.filter(database => !database.matches)
                    .map(database => `${database.path}=${(database.identityEmails || []).join(' vs ')}`),
                ...verification.missingFiles.map(file => `${file.path}=missing`)
            ];
            throw new Error(`Switch verification failed after writing. ${diverged.join(' | ') || 'stores did not converge'}`);
        }

        writeSwitchState(buildSwitchState(entry, verification));
        const refreshedProfile = refreshProfileMetadata(entry, verification);
        return {
            email: entry.email,
            db: dbResult,
            files: fileResult,
            verification,
            complete: Boolean(entry.complete),
            profile: refreshedProfile
        };
    } catch (error) {
        if (captured) {
            const rollback = restoreCapturedState(captured);
            if (rollback.failed.length > 0) {
                throw new Error(`${error.message} (rollback incomplete: ${rollback.failed.join(' | ')})`);
            }
        }
        throw error;
    } finally {
        lock.release();
    }
}

function clearAllSessionTokens() {
    const lock = acquireSwitchLock();
    try {
        return clearAllSessionTokensUnlocked();
    } finally {
        lock.release();
    }
}

function clearAllSessionTokensUnlocked() {
    const failed = [];

    if (DatabaseSync) {
        for (const dbPath of getDbPaths()) {
            let db;
            try {
                db = openDatabase(dbPath, false);
                db.exec('BEGIN IMMEDIATE');
                const deleteStatement = db.prepare('DELETE FROM ItemTable WHERE key = ?');
                for (const key of DB_SESSION_KEYS) deleteStatement.run(key);

                const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('google.google-antigravity');
                const raw = row ? toText(row.value) : null;
                if (raw) {
                    const parsed = safeJsonParse(raw);
                    if (parsed && parsed['antigravity-storage']) {
                        const storage = parsed['antigravity-storage'];
                        delete storage['agy.onboarding.lastLoginUsername'];
                        delete storage['jetski.onboarding.lastLoginUsername'];
                        delete storage['onboarding.lastLoginUsername'];
                        delete storage['lastLoginUsername'];
                        delete storage['agy.onboarding.lastLoginIsGcpTos'];
                        delete storage['jetski.onboarding.lastLoginIsGcpTos'];
                        db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
                            .run('google.google-antigravity', JSON.stringify(parsed));
                    }
                }
                db.exec('COMMIT');
            } catch (error) {
                try {
                    if (db) db.exec('ROLLBACK');
                } catch {}
                failed.push(`${dbPath}: ${error.message}`);
            } finally {
                try {
                    if (db) db.close();
                } catch {}
            }
        }
    }

    if (!DatabaseSync && getDbPaths().length > 0) {
        failed.push('node:sqlite is unavailable; database session keys were not cleared.');
    }

    const paths = getTokenFilePaths();
    for (const category of FILE_CATEGORIES) {
        for (const tokenPath of paths[category]) {
            try {
                if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
            } catch (error) {
                failed.push(`${tokenPath}: ${error.message}`);
            }
        }
    }

    const stateResult = clearSwitchState();
    for (const failure of stateResult.failed) failed.push(failure);

    if (failed.length > 0) {
        throw new Error(`Could not clear every session store. ${failed.join(' | ')}`);
    }
}

function getDiagnostics() {
    const profiles = loadProfiles();
    const warnings = getLastLoadWarnings();
    const session = detectActiveSession();
    const state = readSwitchState();
    return {
        version: VERSION,
        platform: process.platform,
        node: process.version,
        sqliteAvailable: isDbSupportAvailable(),
        dbPaths: getDbPaths(),
        tokenPaths: getTokenFilePaths(),
        profilePaths: getProfilesFilePaths(),
        activeSession: session,
        stores: session.stores,
        conflicts: session.conflicts,
        switchState: state,
        storeDiff: diffAgainstSwitchState(state),
        savedProfiles: Object.keys(profiles),
        profileCompleteness: Object.fromEntries(Object.entries(profiles).map(([email, profile]) => [
            email,
            {
                complete: Boolean(profile.complete),
                saved_at: profile.saved_at || '',
                aliases: profile.aliases || [],
                account_id: profile.account_id || '',
                fingerprints: Object.keys(profile.fingerprints || {}),
                dbPaths: Object.keys(profile.db_tokens_by_path || {})
            }
        ])),
        vaultWarnings: warnings
    };
}

module.exports = {
    DB_AUTH_KEYS,
    FILE_CATEGORIES,
    EMAIL_REGEX,
    VERSION,
    isValidEmail,
    normalizeEmail,
    canonicalEmail,
    tokenFingerprint,
    delay,
    initialize,
    refreshPaths,
    getAllCandidateHomeDirs,
    getGeminiDirs,
    getTokenFilePaths,
    getDbPaths,
    getProfilesFilePaths,
    getSwitchStatePaths,
    isDbSupportAvailable,
    getLastLoadWarnings,
    decodeJwtPayload,
    detectSessions,
    detectActiveSession,
    detectActiveEmail,
    normalizeFileTokens,
    normalizeDbTokens,
    normalizeProfileEntry,
    loadProfiles,
    saveProfiles,
    readCurrentDbTokens,
    readCurrentDbTokensByPath,
    readCurrentFileTokens,
    readDbStores,
    patchTokenEmail,
    patchDbIdentity,
    writeFileAtomic,
    writeTokensToDbs,
    writeTokensToFiles,
    captureCurrentState,
    restoreCapturedState,
    verifyRestore,
    readSwitchState,
    writeSwitchState,
    clearSwitchState,
    getStoreSnapshot,
    getStoreMtimeSignature,
    diffAgainstSwitchState,
    acquireSwitchLock,
    snapshotActiveAccount,
    buildLoginProfile,
    switchToLoginSession,
    restoreProfile,
    clearAllSessionTokens,
    getDiagnostics
};
