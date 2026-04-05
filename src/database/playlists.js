/**
 * Gestione database playlist (server e utenti)
 * Supporta playlist multiple per utente con migrazione automatica dal formato legacy
 */

const fs = require('fs');
const { PLAYLIST_FILE } = require('../../config');
const { safeJSONParse } = require('../utils/sanitize');
const { DEFAULT_PLAYLIST_NAME, MAX_PLAYLIST_NAME_LENGTH } = require('../../config');

// ─── Cache singleton per evitare race condition read-modify-write ──────
let _dbCache = null;
let _dbDirty = false;
let _dbFlushTimer = null;
const DB_FLUSH_INTERVAL_MS = 2000; // Flush su disco ogni 2 secondi se dirty

/**
 * Carica il database delle playlist
 * @returns {object} - { server: [], users: {} }
 */
function loadDatabase() {
    if (_dbCache) return _dbCache;
    _dbCache = safeJSONParse(PLAYLIST_FILE, { server: [], users: {} });
    return _dbCache;
}

/**
 * Salva il database delle playlist
 * Marca la cache come dirty e schedula un flush su disco.
 * @param {object} data - Dati da salvare (deve essere lo stesso riferimento della cache)
 */
function saveDatabase(data) {
    _dbCache = data;
    _dbDirty = true;
    if (!_dbFlushTimer) {
        _dbFlushTimer = setTimeout(() => {
            _flushToFile();
        }, DB_FLUSH_INTERVAL_MS);
    }
}

/**
 * Forza la scrittura immediata su disco (per shutdown).
 */
function flushDatabaseSync() {
    if (_dbFlushTimer) {
        clearTimeout(_dbFlushTimer);
        _dbFlushTimer = null;
    }
    _flushToFile();
}

function _flushToFile() {
    _dbFlushTimer = null;
    if (!_dbDirty || !_dbCache) return;
    try {
        const tmpFile = PLAYLIST_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(_dbCache, null, 2));
        fs.renameSync(tmpFile, PLAYLIST_FILE);
        _dbDirty = false;
    } catch (e) {
        console.error('❌ [DATABASE] Errore salvataggio playlist:', e.message);
    }
}

/**
 * Migra i dati utente dal formato legacy (array) al nuovo formato (oggetto con playlists).
 * Se i dati sono già nel nuovo formato, li restituisce invariati.
 * @param {Array|Object} userData - Dati utente (array legacy o oggetto nuovo)
 * @returns {Object} - { playlists: { Generale: [...], ... }, activePlaylist: 'Generale' }
 */
function migrateUserData(userData) {
    if (Array.isArray(userData)) {
        // Formato legacy: singolo array → diventa playlist "Generale"
        return { playlists: { [DEFAULT_PLAYLIST_NAME]: userData }, activePlaylist: DEFAULT_PLAYLIST_NAME };
    }
    if (userData && typeof userData === 'object' && userData.playlists) {
        // Già nel nuovo formato — assicura che 'Generale' esista
        if (!userData.playlists[DEFAULT_PLAYLIST_NAME]) {
            userData.playlists[DEFAULT_PLAYLIST_NAME] = [];
        }
        if (!userData.activePlaylist || !userData.playlists[userData.activePlaylist]) {
            userData.activePlaylist = DEFAULT_PLAYLIST_NAME;
        }
        return userData;
    }
    // Dati non validi → struttura vuota
    return { playlists: { [DEFAULT_PLAYLIST_NAME]: [] }, activePlaylist: DEFAULT_PLAYLIST_NAME };
}

/**
 * Ottiene i dati utente nel nuovo formato, con migrazione automatica.
 * Modifica db.users[userId] in-place se necessario.
 * @param {Object} db - Database completo
 * @param {string} userId - ID utente Discord
 * @returns {Object} - { playlists: {...}, activePlaylist: '...' }
 */
function getUserData(db, userId) {
    if (!db.users) db.users = {};
    if (!db.users[userId]) {
        db.users[userId] = { playlists: { [DEFAULT_PLAYLIST_NAME]: [] }, activePlaylist: DEFAULT_PLAYLIST_NAME };
    } else {
        db.users[userId] = migrateUserData(db.users[userId]);
    }
    return db.users[userId];
}

/**
 * Ottiene l'array di canzoni di una specifica playlist utente.
 * @param {Object} db - Database completo
 * @param {string} userId - ID utente Discord
 * @param {string} playlistName - Nome della playlist
 * @returns {Array} - Array di canzoni
 */
function getUserPlaylist(db, userId, playlistName) {
    const data = getUserData(db, userId);
    return data.playlists[playlistName] || [];
}

/**
 * Ottiene il nome della playlist attiva per un utente.
 * @param {Object} db - Database completo
 * @param {string} userId - ID utente Discord
 * @returns {string} - Nome della playlist attiva
 */
function getActivePlaylistName(db, userId) {
    const data = getUserData(db, userId);
    return data.activePlaylist || DEFAULT_PLAYLIST_NAME;
}

/**
 * Imposta la playlist attiva per un utente.
 * @param {Object} db - Database completo
 * @param {string} userId - ID utente Discord
 * @param {string} name - Nome della playlist da attivare
 */
function setActivePlaylist(db, userId, name) {
    const data = getUserData(db, userId);
    if (data.playlists[name]) {
        data.activePlaylist = name;
    }
}

/**
 * Ottiene l'elenco dei nomi di tutte le playlist di un utente.
 * La playlist 'Generale' è sempre prima.
 * @param {Object} db - Database completo
 * @param {string} userId - ID utente Discord
 * @returns {string[]} - Nomi delle playlist
 */
function getUserPlaylistNames(db, userId) {
    const data = getUserData(db, userId);
    const names = Object.keys(data.playlists);
    // Assicura che Generale sia sempre prima
    const sorted = [DEFAULT_PLAYLIST_NAME, ...names.filter(n => n !== DEFAULT_PLAYLIST_NAME)];
    return sorted;
}

/**
 * Valida un nome di playlist.
 * @param {string} name - Nome da validare
 * @returns {{ valid: boolean, error?: string }} - Risultato validazione
 */
function validatePlaylistName(name) {
    if (!name || typeof name !== 'string') return { valid: false, error: 'Il nome non può essere vuoto.' };
    const trimmed = name.trim();
    if (trimmed.length === 0) return { valid: false, error: 'Il nome non può essere vuoto.' };
    if (trimmed.length > MAX_PLAYLIST_NAME_LENGTH) return { valid: false, error: `Il nome non può superare ${MAX_PLAYLIST_NAME_LENGTH} caratteri.` };
    if (trimmed.includes('_')) return { valid: false, error: 'Il nome non può contenere underscore (_).' };
    // Permetti alfanumerici, spazi, trattini, accenti e altri caratteri unicode comuni
    const nameRegex = new RegExp(`^[^\\n\\r_]{1,${MAX_PLAYLIST_NAME_LENGTH}}$`);
    if (!nameRegex.test(trimmed)) return { valid: false, error: 'Il nome contiene caratteri non validi.' };
    return { valid: true };
}

module.exports = {
    loadDatabase,
    saveDatabase,
    flushDatabaseSync,
    migrateUserData,
    getUserData,
    getUserPlaylist,
    getActivePlaylistName,
    setActivePlaylist,
    getUserPlaylistNames,
    validatePlaylistName
};
