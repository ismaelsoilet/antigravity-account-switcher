/**
 * Antigravity Account Switcher - Token & Storage Engine (v2.0)
 * Deep multi-store authentication management across:
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

const EMAIL_REGEX = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/;

/**
 * Return all potential home directories across WSL and Windows
 */
function getAllCandidateHomeDirs() {
    const list = [];

    // Current environment home
    try {
        if (os.homedir()) list.push(os.homedir());
    } catch {}
    if (process.env.HOME) list.push(process.env.HOME);
    if (process.env.USERPROFILE) list.push(process.env.USERPROFILE);

    // Cross-environment known paths
    list.push('/home/ismaelsoilet');
    list.push('/mnt/c/Users/Ismael');
    list.push('C:\\Users\\Ismael');
    list.push('\\\\wsl.localhost\\Ubuntu-24.04\\home\\ismaelsoilet');
    list.push('\\\\wsl$\\Ubuntu-24.04\\home\\ismaelsoilet');

    const valid = [];
    for (const p of [...new Set(list)]) {
        if (!p) continue;
        try {
            if (fs.existsSync(p)) {
                valid.push(p);
            }
        } catch {}
    }
    return valid;
}

/**
 * Get all .gemini directory paths across environments
 */
function getGeminiDirs() {
    const dirs = [];
    for (const h of getAllCandidateHomeDirs()) {
        const g = path.join(h, '.gemini');
        try {
            if (fs.existsSync(g)) {
                dirs.push(g);
            } else {
                // Also candidate for creation
                dirs.push(g);
            }
        } catch {
            dirs.push(g);
        }
    }
    return [...new Set(dirs)];
}

/**
 * Get token file paths categorized by token type
 */
function getTokenFilePaths() {
    const geminiDirs = getGeminiDirs();
    const paths = {
        cliToken: [],
        standaloneToken: [],
        oauthCreds: []
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
 * Get all possible SQLite state.vscdb paths across Windows and WSL
 */
function getDbPaths() {
    const candidates = [
        '/mnt/c/Users/Ismael/AppData/Roaming/Antigravity IDE/User/globalStorage/state.vscdb',
        '/mnt/c/Users/Ismael/AppData/Roaming/Antigravity/User/globalStorage/state.vscdb',
        'C:\\Users\\Ismael\\AppData\\Roaming\\Antigravity IDE\\User\\globalStorage\\state.vscdb',
        'C:\\Users\\Ismael\\AppData\\Roaming\\Antigravity\\User\\globalStorage\\state.vscdb'
    ];

    if (process.env.APPDATA) {
        candidates.push(path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
        candidates.push(path.join(process.env.APPDATA, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
    }

    const valid = [];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                valid.push(p);
            }
        } catch {}
    }
    return [...new Set(valid)];
}

/**
 * Get all profile file paths
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
 * Helper to test if a string is a valid email address
 */
function isValidEmail(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    return trimmed.length > 5 && EMAIL_REGEX.test(trimmed);
}

/**
 * Cascading active account email detection across all sources:
 * 1. SQLite google.google-antigravity (agy.onboarding.lastLoginUsername, jetski.onboarding.lastLoginUsername, or any email in storage)
 * 2. SQLite antigravityAuthStatus (email)
 * 3. SQLite google.geminicodeassist (chatThreads keys)
 * 4. File token antigravity-cli/antigravity-oauth-token (id_token_email or decoded JWT)
 * 5. File token oauth_creds.json (decoded JWT id_token)
 */
function detectActiveEmail() {
    // 1. Check SQLite Databases first (direct IDE active session)
    const dbPaths = getDbPaths();
    if (DatabaseSync && dbPaths.length > 0) {
        for (const dbPath of dbPaths) {
            try {
                const db = new DatabaseSync(dbPath, { readOnly: true });

                // 1a. Check google.google-antigravity
                const agRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('google.google-antigravity');
                if (agRow && agRow.value) {
                    try {
                        const parsed = JSON.parse(agRow.value);
                        const storage = parsed['antigravity-storage'] || {};

                        // Check known keys first
                        const explicitCandidates = [
                            storage['agy.onboarding.lastLoginUsername'],
                            storage['jetski.onboarding.lastLoginUsername'],
                            storage['onboarding.lastLoginUsername'],
                            storage['lastLoginUsername']
                        ];
                        for (const cand of explicitCandidates) {
                            if (isValidEmail(cand)) {
                                db.close();
                                return cand.trim();
                            }
                        }

                        // Deep scan of all string values in antigravity-storage
                        for (const val of Object.values(storage)) {
                            if (isValidEmail(val)) {
                                db.close();
                                return String(val).trim();
                            }
                        }
                    } catch {}
                }

                // 1b. Check antigravityAuthStatus
                const authRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus');
                if (authRow && authRow.value) {
                    try {
                        const parsed = JSON.parse(authRow.value);
                        if (isValidEmail(parsed.email)) {
                            db.close();
                            return parsed.email.trim();
                        }
                    } catch {}
                }

                // 1c. Check google.geminicodeassist
                const gcaRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('google.geminicodeassist');
                if (gcaRow && gcaRow.value) {
                    try {
                        const parsed = JSON.parse(gcaRow.value);
                        const threads = parsed['geminiCodeAssist.chatThreads'];
                        if (threads && typeof threads === 'object') {
                            for (const key of Object.keys(threads)) {
                                if (isValidEmail(key)) {
                                    db.close();
                                    return key.trim();
                                }
                            }
                        }
                    } catch {}
                }

                db.close();
            } catch {}
        }
    }

    // 2. Check token files (CLI & standalone tokens)
    const filePaths = getTokenFilePaths();

    // 2a. Check antigravity-cli/antigravity-oauth-token
    for (const p of filePaths.cliToken) {
        try {
            if (fs.existsSync(p)) {
                const content = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (isValidEmail(content.id_token_email)) {
                    return content.id_token_email.trim();
                }
                if (content.token && content.token.id_token) {
                    const payload = decodeJwtPayload(content.token.id_token);
                    if (payload && isValidEmail(payload.email)) {
                        return payload.email.trim();
                    }
                }
            }
        } catch {}
    }

    // 2b. Check oauth_creds.json
    for (const p of filePaths.oauthCreds) {
        try {
            if (fs.existsSync(p)) {
                const creds = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (creds.id_token) {
                    const payload = decodeJwtPayload(creds.id_token);
                    if (payload && isValidEmail(payload.email)) {
                        return payload.email.trim();
                    }
                }
            }
        } catch {}
    }

    return '';
}

/**
 * Load all saved profiles from disk
 */
function loadProfiles() {
    const targets = getProfilesFilePaths();
    for (const p of targets) {
        try {
            if (fs.existsSync(p)) {
                const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
                const clean = {};
                for (const [k, v] of Object.entries(raw)) {
                    const em = v.email || k;
                    if (isValidEmail(em)) {
                        clean[em] = {
                            email: em.trim(),
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
            }
        } catch {}
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
        try {
            if (fs.existsSync(p)) {
                result.cliToken = JSON.parse(fs.readFileSync(p, 'utf-8'));
                break;
            }
        } catch {}
    }

    // 2. Standalone Token
    for (const p of filePaths.standaloneToken) {
        try {
            if (fs.existsSync(p)) {
                result.standaloneToken = JSON.parse(fs.readFileSync(p, 'utf-8'));
                break;
            }
        } catch {}
    }

    // 3. OAuth Creds
    for (const p of filePaths.oauthCreds) {
        try {
            if (fs.existsSync(p)) {
                result.oauthCreds = JSON.parse(fs.readFileSync(p, 'utf-8'));
                break;
            }
        } catch {}
    }

    // Synthesize standalone token from CLI token if missing
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
 * Create a complete snapshot of the active account.
 * Supports manual email fallback if provided by user.
 */
function snapshotActiveAccount(customLabel, manualEmail) {
    const email = (manualEmail && manualEmail.trim()) || detectActiveEmail();
    if (!email || !isValidEmail(email)) {
        throw new Error('No valid Google Account email provided or detected.');
    }

    const cleanEmail = email.trim();
    const dbTokens = readCurrentDbTokens();
    const fileTokens = readCurrentFileTokens();
    const displayLabel = (customLabel && customLabel.trim()) ? customLabel.trim() : cleanEmail.split('@')[0];

    // Ensure google.google-antigravity contains the correct email keys
    let agData = {};
    if (dbTokens['google.google-antigravity']) {
        try {
            agData = JSON.parse(dbTokens['google.google-antigravity']);
        } catch {}
    }
    if (!agData['antigravity-storage']) {
        agData['antigravity-storage'] = {};
    }
    agData['antigravity-storage']['agy.onboarding.lastLoginUsername'] = cleanEmail;
    agData['antigravity-storage']['jetski.onboarding.lastLoginUsername'] = cleanEmail;
    agData['antigravity-storage']['agy.onboarding.lastLoginIsGcpTos'] = 'false';
    agData['antigravity-storage']['jetski.onboarding.lastLoginIsGcpTos'] = 'false';
    dbTokens['google.google-antigravity'] = JSON.stringify(agData);

    // Ensure antigravityAuthStatus has email
    if (!dbTokens['antigravityAuthStatus']) {
        dbTokens['antigravityAuthStatus'] = JSON.stringify({ email: cleanEmail, apiKey: '' });
    }

    // Ensure cliToken has email
    if (fileTokens.cliToken) {
        fileTokens.cliToken.id_token_email = cleanEmail;
    }

    const profiles = loadProfiles();
    profiles[cleanEmail] = {
        email: cleanEmail,
        label: displayLabel,
        saved_at: new Date().toISOString(),
        db_tokens: dbTokens,
        file_tokens: fileTokens,
        tokens: dbTokens // backwards compatibility
    };

    saveProfiles(profiles);

    // Also persist injected keys back to active DB so it is recognized immediately
    writeTokensToDbs(dbTokens);

    return profiles[cleanEmail];
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

    const email = profile.email;

    // 1. Prepare and patch DB tokens
    const dbTokens = Object.assign({}, profile.db_tokens || profile.tokens || {});

    // Ensure google.google-antigravity contains the target email in all known keys
    let agData = {};
    if (dbTokens['google.google-antigravity']) {
        try {
            agData = JSON.parse(dbTokens['google.google-antigravity']);
        } catch {}
    }
    if (!agData['antigravity-storage']) {
        agData['antigravity-storage'] = {};
    }
    agData['antigravity-storage']['agy.onboarding.lastLoginUsername'] = email;
    agData['antigravity-storage']['jetski.onboarding.lastLoginUsername'] = email;
    agData['antigravity-storage']['agy.onboarding.lastLoginIsGcpTos'] = 'false';
    agData['antigravity-storage']['jetski.onboarding.lastLoginIsGcpTos'] = 'false';
    dbTokens['google.google-antigravity'] = JSON.stringify(agData);

    // Ensure antigravityAuthStatus matches
    if (!dbTokens['antigravityAuthStatus']) {
        dbTokens['antigravityAuthStatus'] = JSON.stringify({ email: email, apiKey: '' });
    }

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
                            delete data['antigravity-storage']['agy.onboarding.lastLoginUsername'];
                            delete data['antigravity-storage']['jetski.onboarding.lastLoginUsername'];
                            delete data['antigravity-storage']['agy.onboarding.lastLoginIsGcpTos'];
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
    EMAIL_REGEX,
    isValidEmail,
    getAllCandidateHomeDirs,
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
