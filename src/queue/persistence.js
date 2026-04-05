/**
 * Gestione persistenza della coda (backup/restore)
 */

const fs = require('fs');
const { QUEUE_FILE } = require('../../config');
const { safeJSONParse } = require('../utils/sanitize');

// ─── Cache in-memory per evitare letture da disco ripetute ──
let _queueCache = null;

function _getQueueCache() {
    if (_queueCache === null) {
        _queueCache = safeJSONParse(QUEUE_FILE, {});
    }
    return _queueCache;
}

function _flushQueueCache() {
    if (_queueCache === null) return;
    try {
        const tmpFile = QUEUE_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(_queueCache, null, 2));
        fs.renameSync(tmpFile, QUEUE_FILE);
    } catch (e) {
        console.error('❌ [PERSISTENCE] Errore scrittura cache:', e.message);
    }
}

/**
 * Carica il backup della coda per una guild
 * @param {string} guildId - ID della guild
 * @returns {object|null} - Dati della coda o null se non esiste
 */
function loadQueueBackup(guildId) {
    const data = _getQueueCache();
    const backup = data[guildId];
    if (!backup) return null;

    // Validazione struttura
    if (!Array.isArray(backup.songs)) backup.songs = [];
    if (!Array.isArray(backup.history)) backup.history = [];
    if (typeof backup.playIndex !== 'number' || backup.playIndex < 0) backup.playIndex = 0;

    // Filtra canzoni invalide
    backup.songs = backup.songs.filter(s => s && typeof s === 'object' && s.url && s.title);
    backup.history = backup.history.filter(s => s && typeof s === 'object' && s.url && s.title);

    // Assicura playIndex nei limiti
    if (backup.songs.length > 0 && backup.playIndex >= backup.songs.length) {
        backup.playIndex = backup.songs.length - 1;
    }

    return backup;
}

/**
 * Salva il backup della coda per una guild
 * @param {string} guildId - ID della guild
 * @param {Array} songs - Array delle canzoni in coda
 * @param {Array} history - Array della cronologia
 * @param {number} playIndex - Indice corrente di riproduzione
 * @param {boolean} isPaused - Stato pausa
 * @param {boolean} loopEnabled - Stato loop
 * @param {boolean} fadeEnabled - Stato crossfade
 * @param {string|null} currentDeckLoaded - URL canzone caricata nel deck corrente
 * @param {string|null} dashboardMessageId - ID del messaggio embed della dashboard
 * @param {string|null} textChannelId - ID del canale testo dove è il dashboard
 */
function saveQueueBackup(guildId, songs, history, playIndex = 0, isPaused = false, loopEnabled = false, fadeEnabled = false, currentDeckLoaded = null, dashboardMessageId = null, textChannelId = null) {
    try {
        if ((!songs || songs.length === 0) && (!history || history.length === 0)) {
            deleteQueueBackup(guildId);
            return;
        }
        let data = _getQueueCache();
        const mapSong = s => ({
            title: s.title,
            url: s.url,
            thumbnail: s.thumbnail,
            isLive: s.isLive,
            requester: s.requester,
            duration: s.duration || 0
        });
        const safeSongs = songs ? songs.filter(s => s && s.title).map(mapSong) : [];
        const safeHistory = history ? history.filter(s => s && s.title).map(mapSong) : [];
        data[guildId] = {
            songs: safeSongs,
            history: safeHistory,
            playIndex: playIndex || 0,
            isPaused,
            loopEnabled,
            fadeEnabled,
            currentDeckLoaded,
            dashboardMessageId,
            textChannelId
        };
        _flushQueueCache();
    } catch (e) {
        console.error('❌ [PERSISTENCE] Errore salvataggio backup:', e.message);
    }
}

// Funzione privata per eliminare il backup (usata internamente da saveQueueBackup)
function deleteQueueBackup(guildId) {
    try {
        let data = _getQueueCache();
        if (data[guildId]) {
            delete data[guildId];
            _flushQueueCache();
        }
    } catch (e) {
        console.error('❌ [PERSISTENCE] Errore eliminazione backup:', e.message);
    }
}

// ─── Debounce per saveQueueState ────────────────────────────
const _saveTimers = new Map();   // guildId -> timeoutId
const _savePending = new Map();  // guildId -> serverQueue reference
const _lastSaveTime = new Map(); // guildId -> timestamp
const SAVE_DEBOUNCE_MS = 2000;

function _doSaveQueueState(guildId, serverQueue) {
    saveQueueBackup(
        guildId,
        serverQueue.songs,
        serverQueue.history,
        serverQueue.playIndex || 0,
        serverQueue.isPaused,
        serverQueue.loopEnabled,
        serverQueue.fadeEnabled,
        serverQueue.currentDeckLoaded,
        serverQueue.dashboardMessageId || null,
        serverQueue.textChannelId || null
    );
}

/**
 * Salva lo stato corrente della coda con debounce (max 1 scrittura ogni 2s per guild).
 * @param {string} guildId - ID della guild
 * @param {object} serverQueue - Oggetto coda del server
 */
function saveQueueState(guildId, serverQueue) {
    if (!serverQueue) return;

    _savePending.set(guildId, serverQueue);

    const now = Date.now();
    const lastSave = _lastSaveTime.get(guildId) || 0;

    if (now - lastSave >= SAVE_DEBOUNCE_MS) {
        // Abbastanza tempo passato, scrivi subito
        if (_saveTimers.has(guildId)) {
            clearTimeout(_saveTimers.get(guildId));
            _saveTimers.delete(guildId);
        }
        _savePending.delete(guildId);
        _lastSaveTime.set(guildId, now);
        _doSaveQueueState(guildId, serverQueue);
    } else if (!_saveTimers.has(guildId)) {
        // Troppo presto, schedula scrittura differita
        const delay = SAVE_DEBOUNCE_MS - (now - lastSave);
        _saveTimers.set(guildId, setTimeout(() => {
            _saveTimers.delete(guildId);
            const sq = _savePending.get(guildId);
            _savePending.delete(guildId);
            if (sq) {
                _lastSaveTime.set(guildId, Date.now());
                _doSaveQueueState(guildId, sq);
            }
        }, delay));
    }
    // Se timer già pendente, _savePending è già aggiornato con l'ultimo stato
}

/**
 * Salva immediatamente bypassando il debounce (per shutdown/crash).
 * @param {string} guildId
 * @param {object} serverQueue
 */
function saveQueueStateImmediate(guildId, serverQueue) {
    if (!serverQueue) return;
    if (_saveTimers.has(guildId)) {
        clearTimeout(_saveTimers.get(guildId));
        _saveTimers.delete(guildId);
    }
    _savePending.delete(guildId);
    _doSaveQueueState(guildId, serverQueue);
}

/**
 * Flush di tutti i salvataggi pendenti (chiamare durante shutdown).
 */
function flushPendingSaves() {
    for (const [, timer] of _saveTimers) clearTimeout(timer);
    _saveTimers.clear();
    for (const [guildId, sq] of _savePending) {
        _doSaveQueueState(guildId, sq);
    }
    _savePending.clear();
}

/**
 * Pulisce timer e stato pendente per una guild (da chiamare su guildDelete)
 */
function cleanupGuild(guildId) {
    if (_saveTimers.has(guildId)) {
        clearTimeout(_saveTimers.get(guildId));
        _saveTimers.delete(guildId);
    }
    _savePending.delete(guildId);
    _lastSaveTime.delete(guildId);
}

module.exports = {
    loadQueueBackup,
    saveQueueBackup,
    deleteQueueBackup,
    saveQueueState,
    saveQueueStateImmediate,
    flushPendingSaves,
    cleanupGuild
};
