/**
 * Sistema di statistiche per il bot musicale
 * Traccia:
 *  - Tempo di ascolto per utente (solo mentre il bot canta, non in pausa)
 *  - Interazioni "aggiungi a playlist" per utente (server e personale)
 *  - Contatori globali: canzoni avviate e canzoni completate
 *
 * I timer di ascolto vengono mantenuti in memoria (activeListeners) e 
 * flush-ati su disco SOLO alla disconnessione del bot o allo shutdown.
 * I contatori (canzoni, playlist) vengono scritti immediatamente su disco.
 */

const fs = require('fs');
const path = require('path');
const { STATS_FILE } = require('../../config/paths');

// ─── Mappa in memoria dei timer attivi ──────────────────────
// guildId → Map<userId, startTimestamp>
const activeListeners = new Map();

// ─── Caricamento / Salvataggio ──────────────────────────────

function getDefaultStats() {
    return {
        users: {},
        global: {
            songsStarted: 0,
            songsCompleted: 0
        },
        lastUpdated: null
    };
}

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const raw = fs.readFileSync(STATS_FILE, 'utf-8');
            const data = JSON.parse(raw);
            // Assicura struttura base
            if (!data.users) data.users = {};
            if (!data.global) data.global = { songsStarted: 0, songsCompleted: 0 };
            if (!data.global.songsStarted) data.global.songsStarted = 0;
            if (!data.global.songsCompleted) data.global.songsCompleted = 0;
            return data;
        }
    } catch (e) {
        console.error('⚠️ [STATS] Errore caricamento stats:', e.message);
    }
    return getDefaultStats();
}

function saveStats(data) {
    try {
        // Assicura che la directory esista
        const dir = path.dirname(STATS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        data.lastUpdated = new Date().toISOString();
        fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('❌ [STATS] Errore salvataggio stats:', e.message);
    }
}

function ensureUser(data, userId, discordUser = null) {
    if (!data.users[userId]) {
        data.users[userId] = {
            listeningTimeMs: 0,
            serverPlaylistAdds: 0,
            personalPlaylistAdds: 0
        };
    }
    // Migrazione: assicura tutti i campi
    const u = data.users[userId];
    if (typeof u.listeningTimeMs !== 'number') u.listeningTimeMs = 0;
    if (typeof u.serverPlaylistAdds !== 'number') u.serverPlaylistAdds = 0;
    if (typeof u.personalPlaylistAdds !== 'number') u.personalPlaylistAdds = 0;
    
    // Aggiungi info Discord se fornite
    if (discordUser) {
        u.username = discordUser.username;
        u.global_name = discordUser.globalName || null;
        u.avatar = discordUser.avatar;
        u.discriminator = discordUser.discriminator;
    }
    return u;
}

// ─── Timer di ascolto ───────────────────────────────────────

/**
 * Inizia a tracciare il tempo di ascolto di un utente in una guild.
 * Se l'utente è già tracciato, non fa nulla (evita doppio conteggio).
 */
function startListening(guildId, userId) {
    if (!guildId || !userId) return;
    let guildMap = activeListeners.get(guildId);
    if (!guildMap) {
        guildMap = new Map();
        activeListeners.set(guildId, guildMap);
    }
    // Se già tracciato, ignora
    if (guildMap.has(userId)) return;
    guildMap.set(userId, Date.now());
}

/**
 * Ferma il tracciamento per un singolo utente e accumula il tempo nella stats in memoria.
 * Ritorna i ms accumulati (o 0 se non era tracciato).
 * NON salva su disco — il salvataggio avviene separatamente.
 */
function stopListening(guildId, userId) {
    if (!guildId || !userId) return 0;
    const guildMap = activeListeners.get(guildId);
    if (!guildMap || !guildMap.has(userId)) return 0;

    const startTime = guildMap.get(userId);
    guildMap.delete(userId);
    if (guildMap.size === 0) activeListeners.delete(guildId);

    const elapsed = Math.max(0, Date.now() - startTime);

    // Accumula nel file stats (carica, aggiorna, salva subito NO — lo facciamo in batch)
    // Usiamo un buffer intermedio per evitare I/O per ogni singolo stop
    // Il flush effettivo su disco avviene in flushGuildAndSave o flushAllGuildsAndSave
    if (!stopListening._pendingTime) stopListening._pendingTime = {};
    if (!stopListening._pendingTime[userId]) stopListening._pendingTime[userId] = 0;
    stopListening._pendingTime[userId] += elapsed;

    return elapsed;
}

// Buffer statico per il tempo pendente (non ancora scritto su disco)
stopListening._pendingTime = {};

/**
 * Avvia il tracciamento per tutti gli umani nel canale vocale del bot.
 * Da chiamare quando il bot inizia a suonare o resume da pausa.
 */
function startAllListeners(guildId, voiceChannel) {
    if (!guildId || !voiceChannel || !voiceChannel.members) return;
    try {
        voiceChannel.members.forEach(member => {
            if (!member.user.bot) {
                startListening(guildId, member.user.id);
            }
        });
    } catch (e) {
        console.warn('⚠️ [STATS] Errore startAllListeners:', e.message);
    }
}

/**
 * Ferma il tracciamento per tutti gli utenti attivi in una guild.
 * NON salva su disco — accumula solo i tempi nel buffer pendente.
 */
function stopAllListeners(guildId) {
    if (!guildId) return;
    const guildMap = activeListeners.get(guildId);
    if (!guildMap || guildMap.size === 0) return;

    // Copia le chiavi prima di iterare (evita modifiche durante iterazione)
    const userIds = [...guildMap.keys()];
    for (const userId of userIds) {
        stopListening(guildId, userId);
    }
}

/**
 * Scrive su disco tutti i tempi pendenti accumulati + salva il file stats.
 * Da chiamare alla disconnessione del bot da un canale o allo shutdown.
 */
function flushPendingAndSave() {
    try {
        const pending = stopListening._pendingTime;
        if (!pending || Object.keys(pending).length === 0) return;

        const data = loadStats();
        for (const [userId, ms] of Object.entries(pending)) {
            if (ms > 0) {
                ensureUser(data, userId);
                data.users[userId].listeningTimeMs += ms;
            }
        }
        saveStats(data);

        // Reset buffer
        stopListening._pendingTime = {};
    } catch (e) {
        console.error('❌ [STATS] Errore flushPendingAndSave:', e.message);
    }
}

/**
 * Ferma tutti i timer attivi per una guild specifica, poi flush su disco.
 * Usato alla disconnessione del bot da un canale vocale.
 */
function flushGuildAndSave(guildId) {
    stopAllListeners(guildId);
    flushPendingAndSave();
}

/**
 * Ferma TUTTI i timer attivi su TUTTE le guild, poi flush su disco.
 * Usato allo shutdown del programma (SIGINT, uncaughtException).
 */
function flushAllGuildsAndSave() {
    try {
        const guildIds = [...activeListeners.keys()];
        for (const guildId of guildIds) {
            stopAllListeners(guildId);
        }
        flushPendingAndSave();
        console.log(`📊 [STATS] Flush completo di tutte le guild (${guildIds.length} attive)`);
    } catch (e) {
        console.error('❌ [STATS] Errore flushAllGuildsAndSave:', e.message);
    }
}

// ─── Contatori globali canzoni ──────────────────────────────

function incrementSongsStarted() {
    try {
        const data = loadStats();
        data.global.songsStarted = (data.global.songsStarted || 0) + 1;
        saveStats(data);
    } catch (e) {
        console.error('⚠️ [STATS] Errore incrementSongsStarted:', e.message);
    }
}

function incrementSongsCompleted() {
    try {
        const data = loadStats();
        data.global.songsCompleted = (data.global.songsCompleted || 0) + 1;
        saveStats(data);
    } catch (e) {
        console.error('⚠️ [STATS] Errore incrementSongsCompleted:', e.message);
    }
}

// ─── Contatori interazioni playlist ─────────────────────────

/**
 * Registra un'aggiunta a playlist (solo aggiunte, non rimozioni).
 * @param {string} userId
 * @param {'server'|'personal'} type
 * @param {object} discordUser - Opzionale, info Discord dell'utente
 */
function recordPlaylistAdd(userId, type, discordUser = null) {
    try {
        if (!userId || !type) return;
        const data = loadStats();
        ensureUser(data, userId, discordUser);
        if (type === 'server') {
            data.users[userId].serverPlaylistAdds = (data.users[userId].serverPlaylistAdds || 0) + 1;
        } else if (type === 'personal') {
            data.users[userId].personalPlaylistAdds = (data.users[userId].personalPlaylistAdds || 0) + 1;
        }
        saveStats(data);
    } catch (e) {
        console.error('⚠️ [STATS] Errore recordPlaylistAdd:', e.message);
    }
}

/**
 * Aggiorna le informazioni Discord di un utente nelle statistiche
 * @param {string} userId
 * @param {object} discordUser - Oggetto utente Discord
 */
function updateUserDiscordInfo(userId, discordUser) {
    try {
        if (!userId || !discordUser) return;
        const data = loadStats();
        ensureUser(data, userId, discordUser);
        saveStats(data);
    } catch (e) {
        console.error('⚠️ [STATS] Errore updateUserDiscordInfo:', e.message);
    }
}

// ─── Debug / Utility ────────────────────────────────────────

/**
 * Restituisce lo stato corrente dei timer attivi (per debug).
 */
function getActiveListenersDebug() {
    const result = {};
    activeListeners.forEach((guildMap, guildId) => {
        result[guildId] = {};
        guildMap.forEach((startTime, userId) => {
            result[guildId][userId] = {
                startTime: new Date(startTime).toISOString(),
                elapsedMs: Date.now() - startTime
            };
        });
    });
    return result;
}

module.exports = {
    // Caricamento
    loadStats,
    saveStats,

    // Timer ascolto
    startListening,
    stopListening,
    startAllListeners,
    stopAllListeners,
    flushGuildAndSave,
    flushAllGuildsAndSave,
    flushPendingAndSave,

    // Contatori canzoni
    incrementSongsStarted,
    incrementSongsCompleted,

    // Contatori playlist
    recordPlaylistAdd,
    
    // Info Discord
    updateUserDiscordInfo,

    // Debug
    getActiveListenersDebug
};
