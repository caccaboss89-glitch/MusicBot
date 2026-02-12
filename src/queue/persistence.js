/**
 * Gestione persistenza della coda (backup/restore)
 */

const fs = require('fs');
const { QUEUE_FILE } = require('../../config');
const { safeJSONParse } = require('../utils/sanitize');

/**
 * Carica il backup della coda per una guild
 * @param {string} guildId - ID della guild
 * @returns {object|null} - Dati della coda o null se non esiste
 */
function loadQueueBackup(guildId) {
    const data = safeJSONParse(QUEUE_FILE, {});
    return data[guildId] || null;
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
        let data = safeJSONParse(QUEUE_FILE, {});
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
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('❌ [PERSISTENCE] Errore salvataggio backup:', e.message);
    }
}

// Funzione privata per eliminare il backup (usata internamente da saveQueueBackup)
function deleteQueueBackup(guildId) {
    try {
        let data = safeJSONParse(QUEUE_FILE, {});
        if (data[guildId]) {
            delete data[guildId];
            fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));
        }
    } catch (e) {
        console.error('❌ [PERSISTENCE] Errore eliminazione backup:', e.message);
    }
}

/**
 * Salva lo stato corrente della coda (wrapper conveniente)
 * @param {string} guildId - ID della guild
 * @param {object} serverQueue - Oggetto coda del server
 */
function saveQueueState(guildId, serverQueue) {
    if (!serverQueue) return;
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

module.exports = {
    loadQueueBackup,
    saveQueueBackup,
    deleteQueueBackup,
    saveQueueState
};
