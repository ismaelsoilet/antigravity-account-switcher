/**
 * Antigravity Account Switcher - Token & Storage Manager
 * Comprehensive multi-store authentication management across:
 * - SQLite databases (state.vscdb)
 * - Standalone CLI & Desktop OAuth tokens (antigravity-oauth-token)
 * - Antigravity CdeAuthService tokens (jetski-standalone-oauth-token)
 * - Google OAuth credentials (oauth_creds.json)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let DatabaseSync;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
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

/**
 * Get primary home directory across WSL and Windows
 */
function getHomeDir() {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/**
 * Get all possible .gemini root directories (WSL and Windows host)
 */
function getGeminiDirs() {
    const dirs = [
        path.join(os.homedir(), '.gemini'),
        path.join(getHomeDir(), '.gemini'),
        '/home/ismaelsoilet/.gemini',
        '/mnt/c/Users/Ismael/.gemini'
    ];
    if (process.platform === 'win32' || process.env.USERPROFILE) {
        const winProfile = process.env.USERPROFILE || 'C:\\Users\\Ismael';
        dirs.push(path.join(winProfile, '.gemini'));
    }
    return [...new Set(dirs.filter(Boolean))];
}

/**
 * Get all token file paths categorized by token type
 */
function getTokenFilePaths() {
    const geminiDirs = getGeminiDirs();
    const paths = {
        cliToken: [],        // antigravity-oauth-token
        standaloneToken: [], // jetski-standalone-oauth-token
        oauthCreds: []       // oauth_creds.json
    };

    for (const gDir of geminiDirs) {
        paths.cliToken.push(path.join(gDir, 'antigravity-cli', 'antigravity-oauth-token'));
        paths.standaloneToken.push(path.join(gDir, 'jetski-standalone-oauth-token'));
        paths.oauthCreds.push(path.join(gDir, 'oauth_creds.json'));
    }

    return {
        cliToken: [...new Set(paths.cliToken)],
        standaloneToken: [...new Set(paths.standaloneToken)],
        oauthCreds: [...new Set(paths.oauthCreds)]
    };
}

/**
 * Get all SQLite database paths for Antigravity IDE and Antigravity Desktop
 */
function getDbPaths() {
    const paths = [
        '/mnt/c/Users/Ismael/AppData/Roaming/Antigravity IDE/User/globalStorage/state.vscdb',
        '/mnt/c/Users/Ismael/AppData/Roaming/Antigravity/User/globalStorage/state.vscdb'
    ];
    if (process.platform === 'win32' || process.env.APPDATA) {
        const appData = process.env.APPDATA || path.join(getHomeDir(), 'AppData', 'Roaming');
        paths.push(path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
        paths.push(path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
    }
    return [...new Set(paths.filter(p => {
        try {
            return fs.existsSync(p);
        } catch {
            return false;
        }
    }))];
}

/**
 * Get profile storage target file paths
 */
function getProfilesFilePaths() {
    const targets = [];
    for (const gDir of getGeminiDirs()) {
        targets.push(path.join(gDir, 'antigravity_profiles.json'));
    }
    return [...new Set(targets)];
}

/**
 * Decode JWT token payload safely without external dependencies
 */
function decodeJwtPayload(jwt) {
    if (!jwt || typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    try {
        let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4 !== 0) {
            base64 += '=';
        }
        const jsonStr = Buffer.from(base64, 'base64').toString('utf-8');
        return JSON.parse(jsonStr);
    } catch {
        return null;
    }
}

/**
 * Cascading active account email detection across all sources:
 * 1. antigravity-oauth-token (id_token_email or parsed id_token)
 * 2. oauth_creds.json (id_token payload)
 * 3. SQLite ItemTable: antigravityAuthStatus (JSON email)
 * 4. SQLite ItemTable: google.google-antigravity (jetski.onboarding.lastLoginUsername)
 * 5. Standalone token file
 */
function detectActiveEmail() {
    const filePaths = getTokenFilePaths();

    // 1. Check antigravity-cli/antigravity-oauth-token
    for (const p of filePaths.cliToken) {
        if (fs.existsSync(p)) {
            try {
                const content = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (content.id_token_email && content.id_token_email.includes('@')) {
                    return content.id_token_email.trim();
                }
                if (content.token && content.token.id_token) {
                    const payload = decodeJwtPayload(content.token.id_token);
                    if (payload && payload.email && payload.email.includes('@')) {
                        return payload.email.trim();
                    }
                }
            } catch {}
        }
    }

    // 2. Check oauth_creds.json
    for (const p of filePaths.oauthCreds) {
        if (fs.existsSync(p)) {
            try {
                const creds = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (creds.id_token) {
                    const payload = decodeJwtPayload(creds.id_token);
                    if (payload && payload.email && payload.email.includes('@')) {
                        return payload.email.trim();
                    }
                }
            } catch {}
        }
    }

    // 3. Check SQLite Databases
    const dbPaths = getDbPaths();
    if (DatabaseSync && dbPaths.length > 0) {
        for (const dbPath of dbPaths) {
            try {
                const db = new DatabaseSync(dbPath, { readOnly: true });
                // 3a. Check antigravityAuthStatus
                const authRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus');
                if (authRow && authRow.value) {
                    try {
                        const parsed = JSON.parse(authRow.value);
                        if (parsed.email && parsed.email.includes('@')) {
                            db.close();
                            return parsed.email.trim();
                        }
                    } catch {}
                }

                // 3b. Check google.google-antigravity
                const agRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('google.google-antigravity');
                if (agRow && agRow.value) {
                    try {
                        const parsed = JSON.parse(agRow.value);
                        const storage = parsed['antigravity-storage'];
                        if (storage && storage['jetski.onboarding.lastLoginUsername']) {
                            const em = storage['jetski.onboarding.lastLoginUsername'];
                            if (em && em.includes('@')) {
                                db.close();
                                return em.trim();
                            }
                        }
                    } catch {}
                }
                db.close();
            } catch {}
        }
    }

    return '';
}

/**
 * Load all saved profiles from disk
 */
function loadProfiles() {
    const targets = getProfilesFilePaths();
    for (const p of targets) {
        if (fs.existsSync(p)) {
            try {
                const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
                const clean = {};
                for (const [k, v] of Object.entries(raw)) {
                    const em = v.email || k;
                    if (em && em.includes('@')) {
                        clean[em] = {
                            email: em,
                            label: v.label || v.name || em.split('@')[0],
                            saved_at: v.saved_at || '',
                            db_tokens: v.db_tokens || v.tokens || {},
                            file_tokens: v.file_tokens || {},
                            tokens: v.tokens || v.db_tokens || {} // legacy compatibility
                        };
                    }
                }
                if (Object.keys(clean).length > 0) {
                    return clean;
                }
            } catch {}
        }
    }
    return {};
}

/**
 * Save profiles map atomically to all discovered paths
 */
function saveProfiles(profiles) {
    const targets = getProfilesFilePaths();
    const dataStr = JSON.stringify(profiles, null, 2);

    for (const p of targets) {
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, dataStr, 'utf-8');
        } catch {}
    }
}

/**
 * Read current SQLite database tokens
 */
function readCurrentDbTokens() {
    const tokens = {};
    const dbs = getDbPaths();
    if (DatabaseSync && dbs.length > 0) {
        for (const dbPath of dbs) {
            try {
                const db = new DatabaseSync(dbPath, { readOnly: true });
                const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
                for (const k of DB_AUTH_KEYS) {
                    if (!tokens[k]) {
                        const row = stmt.get(k);
                        if (row && row.value !== undefined) {
                            tokens[k] = row.value;
                        }
                    }
                }
                db.close();
            } catch {}
        }
    }
    return tokens;
}

/**
 * Read current file tokens from disk
 */
function readCurrentFileTokens() {
    const filePaths = getTokenFilePaths();
    const result = {
        cliToken: null,
        standaloneToken: null,
        oauthCreds: null
    };

    // 1. CLI Token
    for (const p of filePaths.cliToken) {
        if (fs.existsSync(p)) {
            try {
                result.cliToken = JSON.parse(fs.readFileSync(p, 'utf-8'));
                break;
            } catch {}
        }
    }

    // 2. Standalone Token
    for (const p of filePaths.standaloneToken) {
        if (fs.existsSync(p)) {
            try {
                result.standaloneToken = JSON.parse(fs.readFileSync(p, 'utf-8'));
                break;
            } catch {}
        }
    }

    // 3. OAuth Creds
    for (const p of filePaths.oauthCreds) {
        if (fs.existsSync(p)) {
            try {
                result.oauthCreds = JSON.parse(fs.readFileSync(p, 'utf-8'));
                break;
            } catch {}
        }
    }

    // If standalone token is missing but CLI token is present, generate standalone format
    if (!result.standaloneToken && result.cliToken && result.cliToken.token) {
        result.standaloneToken = {
            token: {
                access_token: result.cliToken.token.access_token,
                expiry: result.cliToken.token.expiry
            }
        };
    }

    return result;
}

/**
 * Create a complete snapshot of the active account
 */
function snapshotActiveAccount(label) {
    const email = detectActiveEmail();
    if (!email) {
        throw new Error('No active Antigravity Google session detected to snapshot.');
    }

    const dbTokens = readCurrentDbTokens();
    const fileTokens = readCurrentFileTokens();
    const displayLabel = (label && label.trim()) ? label.trim() : email.split('@')[0];

    const profiles = loadProfiles();
    profiles[email] = {
        email: email,
        label: displayLabel,
        saved_at: new Date().toISOString(),
        db_tokens: dbTokens,
        file_tokens: fileTokens,
        tokens: dbTokens // backwards compatibility
    };

    saveProfiles(profiles);
    return profiles[email];
}

/**
 * Write tokens to SQLite databases
 */
function writeTokensToDbs(dbTokens) {
    if (!dbTokens || typeof dbTokens !== 'object') return;
    const dbs = getDbPaths();
    if (DatabaseSync && dbs.length > 0) {
        for (const dbPath of dbs) {
            try {
                const db = new DatabaseSync(dbPath);
                const stmt = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
                for (const [k, v] of Object.entries(dbTokens)) {
                    if (v !== undefined && v !== null) {
                        stmt.run(k, String(v));
                    }
                }
                db.close();
            } catch (e) {
                console.error(`DatabaseSync write error for ${dbPath}:`, e);
            }
        }
    }
}

/**
 * Write file tokens atomically to all discovered paths
 */
function writeTokensToFiles(fileTokens) {
    if (!fileTokens || typeof fileTokens !== 'object') return;
    const filePaths = getTokenFilePaths();

    // 1. Write CLI Token (antigravity-oauth-token)
    if (fileTokens.cliToken) {
        const content = JSON.stringify(fileTokens.cliToken, null, 2);
        for (const p of filePaths.cliToken) {
            try {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, content, 'utf-8');
            } catch {}
        }
    }

    // 2. Write Standalone Token (jetski-standalone-oauth-token)
    let standaloneData = fileTokens.standaloneToken;
    if (!standaloneData && fileTokens.cliToken && fileTokens.cliToken.token) {
        standaloneData = {
            token: {
                access_token: fileTokens.cliToken.token.access_token,
                expiry: fileTokens.cliToken.token.expiry
            }
        };
    }

    if (standaloneData) {
        const content = JSON.stringify(standaloneData, null, 2);
        for (const p of filePaths.standaloneToken) {
            try {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, content, 'utf-8');
            } catch {}
        }
    }

    // 3. Write OAuth Creds (oauth_creds.json)
    if (fileTokens.oauthCreds) {
        const content = JSON.stringify(fileTokens.oauthCreds, null, 2);
        for (const p of filePaths.oauthCreds) {
            try {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, content, 'utf-8');
            } catch {}
        }
    }
}

/**
 * Restore an account profile across all stores
 */
function restoreProfile(profile) {
    if (!profile) {
        throw new Error('Invalid profile: null or undefined');
    }

    // 1. Write SQLite DB tokens
    const dbTokens = profile.db_tokens || profile.tokens || {};
    writeTokensToDbs(dbTokens);

    // 2. Write file tokens
    const fileTokens = profile.file_tokens || {};
    writeTokensToFiles(fileTokens);
}

/**
 * Clear all session tokens from databases and files (logout state)
 */
function clearAllSessionTokens() {
    // 1. Clean SQLite databases
    const dbs = getDbPaths();
    if (DatabaseSync && dbs.length > 0) {
        for (const dbPath of dbs) {
            try {
                const db = new DatabaseSync(dbPath);
                const stmt = db.prepare('DELETE FROM ItemTable WHERE key = ?');
                for (const k of DB_AUTH_KEYS) {
                    if (k !== 'google.google-antigravity') {
                        stmt.run(k);
                    }
                }
                const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('google.google-antigravity');
                if (row && row.value) {
                    try {
                        const data = JSON.parse(row.value);
                        if (data['antigravity-storage']) {
                            delete data['antigravity-storage']['jetski.onboarding.lastLoginUsername'];
                            delete data['antigravity-storage']['jetski.onboarding.lastLoginIsGcpTos'];
                            db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('google.google-antigravity', JSON.stringify(data));
                        }
                    } catch {}
                }
                db.close();
            } catch {}
        }
    }

    // 2. Remove token files
    const filePaths = getTokenFilePaths();
    for (const list of [filePaths.cliToken, filePaths.standaloneToken, filePaths.oauthCreds]) {
        for (const p of list) {
            try {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                }
            } catch {}
        }
    }
}

module.exports = {
    DB_AUTH_KEYS,
    getHomeDir,
    getGeminiDirs,
    getTokenFilePaths,
    getDbPaths,
    getProfilesFilePaths,
    decodeJwtPayload,
    detectActiveEmail,
    loadProfiles,
    saveProfiles,
    readCurrentDbTokens,
    readCurrentFileTokens,
    snapshotActiveAccount,
    writeTokensToDbs,
    writeTokensToFiles,
    restoreProfile,
    clearAllSessionTokens
};
