'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
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

let lastLoadWarnings = [];

function isValidEmail(value) {
    if (!value || typeof value !== 'string') return false;
    return EMAIL_REGEX.test(value.trim());
}

function normalizeEmail(value) {
    return isValidEmail(value) ? value.trim().toLowerCase() : '';
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

function getAllCandidateHomeDirs() {
    const explicit = process.env.AGY_SWITCH_HOME;
    if (explicit) {
        return [...new Set(explicit.split(path.delimiter).map(item => item.trim()).filter(Boolean))];
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
    return [...new Set(valid)];
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

function isDbSupportAvailable() {
    return Boolean(DatabaseSync);
}

function getLastLoadWarnings() {
    return [...lastLoadWarnings];
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

function getEmailFromDbs() {
    if (!DatabaseSync) return '';
    for (const dbPath of getDbPaths()) {
        let db;
        try {
            db = new DatabaseSync(dbPath, { readOnly: true });
            db.exec('PRAGMA busy_timeout = 5000');
            const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus');
            const raw = row ? toText(row.value) : null;
            const parsed = raw ? safeJsonParse(raw) : null;
            if (parsed && isValidEmail(parsed.email)) return normalizeEmail(parsed.email);
        } catch {
            // Ignore unreadable databases; detection falls back to signed out.
        } finally {
            try {
                if (db) db.close();
            } catch {}
        }
    }
    return '';
}

function detectActiveSession() {
    const filePaths = getTokenFilePaths();

    for (const category of FILE_CATEGORIES) {
        for (const tokenPath of filePaths[category]) {
            let content;
            try {
                if (!fs.existsSync(tokenPath)) continue;
                content = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
            } catch {
                continue;
            }
            if (!hasTokenStrings(content) || !hasUsableTokens(content)) continue;

            let email = extractEmailFromToken(content);
            if (!email) email = getEmailFromDbs();
            return {
                isActive: true,
                hasToken: true,
                needsEmail: !email,
                email,
                source: tokenPath,
                category
            };
        }
    }

    return {
        isActive: false,
        hasToken: false,
        needsEmail: false,
        email: '',
        source: null,
        category: null
    };
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

    return {
        ...raw,
        email,
        label,
        saved_at: typeof raw.saved_at === 'string' ? raw.saved_at : '',
        db_tokens: dbTokens,
        file_tokens: fileTokens,
        tokens: dbTokens
    };
}

function normalizeProfilesMap(profiles) {
    const output = {};
    if (!profiles || typeof profiles !== 'object') return output;
    for (const [key, value] of Object.entries(profiles)) {
        const entry = normalizeProfileEntry(value, key);
        if (!entry) continue;
        const previous = output[entry.email];
        if (!previous || (entry.saved_at && (!previous.saved_at || entry.saved_at >= previous.saved_at))) {
            output[entry.email] = entry;
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

function openDatabase(dbPath, readOnly) {
    const db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
    try {
        db.exec('PRAGMA busy_timeout = 5000');
    } catch {}
    return db;
}

function readCurrentDbTokens() {
    const tokens = {};
    if (!DatabaseSync) return tokens;

    for (const dbPath of getDbPaths()) {
        let db;
        try {
            db = openDatabase(dbPath, true);
            const statement = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
            for (const key of DB_AUTH_KEYS) {
                if (Object.prototype.hasOwnProperty.call(tokens, key)) continue;
                const row = statement.get(key);
                const text = row ? toText(row.value) : null;
                if (text !== null) tokens[key] = text;
            }
        } catch {
            // Database may be locked or still being initialized; other stores are still used.
        } finally {
            try {
                if (db) db.close();
            } catch {}
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
    const { replaceSessionKeys = false } = options;
    const paths = getDbPaths();
    if (paths.length === 0) {
        return { skipped: true, written: [], failed: [] };
    }
    if (!DatabaseSync) {
        throw new Error('This Antigravity host does not provide the node:sqlite runtime required to update the IDE database.');
    }

    const written = [];
    const failed = [];
    for (const dbPath of paths) {
        let db;
        try {
            db = openDatabase(dbPath, false);
            db.exec('BEGIN IMMEDIATE');
            if (replaceSessionKeys) {
                const deleteStatement = db.prepare('DELETE FROM ItemTable WHERE key = ?');
                for (const key of DB_SESSION_KEYS) deleteStatement.run(key);
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
            failed.push(`${dbPath}: ${error.message}`);
        } finally {
            try {
                if (db) db.close();
            } catch {}
        }
    }

    if (written.length === 0) {
        throw new Error(`Could not write the Antigravity database. ${failed.join(' | ')}`);
    }
    if (failed.length > 0) {
        throw new Error(`Antigravity database was only partially written. ${failed.join(' | ')}`);
    }
    return { skipped: false, written, failed };
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

function snapshotActiveAccount(customLabel, manualEmail) {
    const session = detectActiveSession();
    if (!session.hasToken) {
        throw new Error('No active Antigravity session was detected. Sign in first.');
    }

    const requestedEmail = manualEmail ? normalizeEmail(manualEmail) : '';
    if (manualEmail && !requestedEmail) {
        throw new Error('The provided email address is not valid.');
    }
    if (requestedEmail && session.email && requestedEmail !== session.email) {
        throw new Error(`The active session belongs to ${session.email}. Sign in as ${requestedEmail} before saving that profile.`);
    }

    const email = requestedEmail || session.email;
    if (!email) {
        throw new Error('An active session was found, but its email could not be determined. Sign in again or provide the email explicitly.');
    }

    const dbPaths = getDbPaths();
    if (dbPaths.length > 0 && !DatabaseSync) {
        throw new Error('This Antigravity host does not provide the node:sqlite runtime required to snapshot the IDE database.');
    }

    const dbTokens = readCurrentDbTokens();
    if (Object.keys(dbTokens).length > 0) patchDbIdentity(dbTokens, email);

    const fileTokens = readCurrentFileTokens(email);
    if (!fileTokens.cliToken && !fileTokens.standaloneToken && !fileTokens.oauthCreds) {
        throw new Error('No OAuth token files were found for the active session.');
    }
    patchTokenEmail(fileTokens, email);

    for (const category of FILE_CATEGORIES) {
        for (const tokenPath of getTokenFilePaths()[category]) {
            try {
                if (fs.existsSync(tokenPath)) fs.chmodSync(tokenPath, FILE_MODE);
            } catch {}
        }
    }

    const profiles = loadProfiles();
    const previous = profiles[email] || {};
    const label = customLabel && customLabel.trim() ? customLabel.trim() : (previous.label || email.split('@')[0]);
    const entry = {
        ...previous,
        email,
        label,
        saved_at: new Date().toISOString(),
        db_tokens: dbTokens,
        file_tokens: fileTokens,
        tokens: dbTokens
    };
    profiles[email] = entry;
    saveProfiles(profiles);

    if (Object.keys(dbTokens).length > 0) {
        try {
            writeTokensToDbs(dbTokens);
        } catch (error) {
            lastLoadWarnings.push(`Could not persist the database identity: ${error.message}`);
        }
    }

    return entry;
}

function restoreProfile(profile) {
    const entry = normalizeProfileEntry(profile, profile && profile.email);
    if (!entry) {
        throw new Error('Invalid or incomplete profile.');
    }

    const email = entry.email;
    const dbTokens = normalizeDbTokens(entry.db_tokens);
    let dbResult = { skipped: true, written: [], failed: [] };
    if (Object.keys(dbTokens).length > 0) {
        const currentDbTokens = readCurrentDbTokens();
        const prepared = buildDbTokensForRestore(dbTokens, currentDbTokens, email);
        dbResult = writeTokensToDbs(prepared, { replaceSessionKeys: true });
    }

    const fileResult = writeTokensToFiles(entry.file_tokens, email);
    return { email, db: dbResult, files: fileResult };
}

function clearAllSessionTokens() {
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

    if (failed.length > 0) {
        throw new Error(`Could not clear every session store. ${failed.join(' | ')}`);
    }
}

function getDiagnostics() {
    const profiles = loadProfiles();
    const warnings = getLastLoadWarnings();
    return {
        platform: process.platform,
        node: process.version,
        sqliteAvailable: isDbSupportAvailable(),
        dbPaths: getDbPaths(),
        tokenPaths: getTokenFilePaths(),
        profilePaths: getProfilesFilePaths(),
        activeSession: detectActiveSession(),
        savedProfiles: Object.keys(profiles),
        vaultWarnings: warnings
    };
}

module.exports = {
    DB_AUTH_KEYS,
    FILE_CATEGORIES,
    EMAIL_REGEX,
    isValidEmail,
    normalizeEmail,
    delay,
    getAllCandidateHomeDirs,
    getGeminiDirs,
    getTokenFilePaths,
    getDbPaths,
    getProfilesFilePaths,
    isDbSupportAvailable,
    getLastLoadWarnings,
    decodeJwtPayload,
    detectActiveSession,
    detectActiveEmail,
    normalizeFileTokens,
    normalizeDbTokens,
    normalizeProfileEntry,
    loadProfiles,
    saveProfiles,
    readCurrentDbTokens,
    readCurrentFileTokens,
    patchTokenEmail,
    patchDbIdentity,
    writeFileAtomic,
    writeTokensToDbs,
    writeTokensToFiles,
    snapshotActiveAccount,
    restoreProfile,
    clearAllSessionTokens,
    getDiagnostics
};
