/**
 * Gestione centralizzata della coda musicale
 * Queste funzioni DEVONO essere usate OVUNQUE per evitare bug di sincronizzazione
 * 
 * TRANSAZIONI: Le operazioni critiche sono wrappate con state versioning e rollback support
 */

const { sanitizeTitle, areSameSong } = require('../utils/sanitize');
const { saveQueueState } = require('./persistence');
const { disconnectTimers } = require('../state/globals');
const { stateVersionManager } = require('../state/StateVersion');
const { DISCONNECT_TIMEOUT_MS } = require('../../config');

// Funzioni utility per la gestione della coda

/**
 * Verifica se il bot è solo nel canale vocale
 * @param {object} serverQueue - Coda del server
 * @returns {boolean} - true se il bot è solo o non c'è canale
 */
function isBotAloneInChannel(serverQueue) {
    if (!serverQueue || !serverQueue.voiceChannel) return true;
    try {
        const channel = serverQueue.voiceChannel;
        if (!channel || !channel.members) return true;
        return channel.members.size <= 1;
    } catch (e) {
        console.warn(`⚠️ [BOT-ALONE-CHECK] Errore: ${e.message}`);
        return true;
    }
}

/**
 * Pulisci la coda terminata prima di aggiungere nuova musica
 * @param {object} serverQueue - Coda del server
 */
function clearFinishedQueue(serverQueue) {
    if (!serverQueue) return;
    if (!serverQueue.currentDeckLoaded) {
        const hadContent = serverQueue.songs.length > 0 || (serverQueue.history && serverQueue.history.length > 0);
        if (hadContent) {
            console.log(`🧹 [QUEUE-CLEAR] Pulizia coda terminata per nuova musica`);
            serverQueue.songs = [];
            serverQueue.history = [];
            serverQueue.playIndex = 0;
        }
    }
}

/**
 * Ottieni la canzone corrente tramite playIndex
 * @param {object} serverQueue - Coda del server
 * @returns {object|null}
 */
/**
 * Ottieni la canzone corrente.
 *
 * FONTE DI VERITÀ: se il mixer è attivo e il deck corrente ha un binding valido,
 * l'indice "reale" della canzone in riproduzione è quello legato al deck attivo,
 * non il semplice playIndex (che in rarissime finestre di race potrebbe essere
 * temporaneamente disallineato). Il binding è validato per URL: se non è più valido
 * si ricade su playIndex, quindi nel peggiore dei casi il comportamento è identico
 * a prima. Questo garantisce che l'embed mostri SEMPRE ciò che suona sul mixer.
 *
 * @param {object} serverQueue - Coda del server
 * @returns {object|null}
 */
function getPlayingIndex(serverQueue) {
    if (!serverQueue) return 0;
    if (serverQueue.currentDeck && serverQueue.currentDeckLoaded && isMixerAlive(serverQueue)) {
        const idx = resolveDeckIndex(serverQueue, serverQueue.currentDeck);
        if (idx != null) return idx;
    }
    return serverQueue.playIndex || 0;
}

function getCurrentSong(serverQueue) {
    if (!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0) return null;
    const index = getPlayingIndex(serverQueue);
    return index < serverQueue.songs.length ? serverQueue.songs[index] : null;
}

/**
 * Ottieni la prossima canzone tramite playIndex + 1
 * @param {object} serverQueue - Coda del server
 * @returns {object|null}
 */
function getNextSong(serverQueue) {
    if (!serverQueue || !serverQueue.songs) return null;
    const nextIndex = (serverQueue.playIndex || 0) + 1;
    if (nextIndex >= serverQueue.songs.length) return null;
    return serverQueue.songs[nextIndex];
}

/**
 * Verifica se esiste una canzone successiva
 * @param {object} serverQueue - Coda del server
 * @returns {boolean}
 */
function hasNextSong(serverQueue) {
    if (!serverQueue || !serverQueue.songs) return false;
    return (serverQueue.playIndex || 0) + 1 < serverQueue.songs.length;
}

// ─── Binding deck → canzone (sincronizzazione robusta embed/mixer) ──────────
//
// Il problema storico di desincronizzazione nasceva dal ricostruire l'indice della
// canzone corrente "indovinando" (playIndex+1) in più punti, mentre il vero stato è
// nel mixer Rust (quale deck è attivo). Legando esplicitamente ogni deck alla canzone
// che ci carichiamo sopra, qualunque evento (skip manuale, crossfade, auto-gapless del
// Rust) può risalire all'indice REALE della canzone in riproduzione.

/**
 * Registra quale canzone (indice + url) è caricata su un deck.
 * Passare index=null per pulire il binding.
 * @param {object} serverQueue
 * @param {string} deck - 'A' | 'B'
 * @param {number|null} index - indice in songs[]
 * @param {string|null} url
 */
function bindDeckSong(serverQueue, deck, index, url) {
    if (!serverQueue) return;
    if (!serverQueue.deckSongs) serverQueue.deckSongs = { A: null, B: null };
    serverQueue.deckSongs[deck] = (index != null && url) ? { index, url } : null;
}

/**
 * Risolve l'indice REALE (in songs[]) della canzone caricata su un deck.
 * Valida contro l'url salvato; se la coda è stata riordinata (insert/remove/shuffle)
 * cerca per url. Restituisce null se il binding non è più valido.
 * @param {object} serverQueue
 * @param {string} deck - 'A' | 'B'
 * @returns {number|null}
 */
function resolveDeckIndex(serverQueue, deck) {
    if (!serverQueue || !serverQueue.deckSongs) return null;
    const binding = serverQueue.deckSongs[deck];
    if (!binding) return null;
    const songs = serverQueue.songs || [];
    if (songs[binding.index] && areSameSong(songs[binding.index].url, binding.url)) {
        return binding.index;
    }
    const found = songs.findIndex(s => s && areSameSong(s.url, binding.url));
    return found >= 0 ? found : null;
}

/**
 * Azzera tutti i binding deck→canzone. Da chiamare nei cleanup (fine coda,
 * disconnessione, crash, svuotamento coda) per evitare binding "fantasma" che
 * potrebbero far risolvere un indice non più valido.
 * @param {object} serverQueue
 */
function clearDeckBindings(serverQueue) {
    if (!serverQueue) return;
    serverQueue.deckSongs = { A: null, B: null };
}



/**
 * Verifica se una canzone è valida
 * @param {object} song - Oggetto canzone
 * @returns {boolean}
 */
function isValidSong(song) {
    return song &&
        song.url &&
        song.title &&
        typeof song.url === 'string' &&
        song.url.length > 0;
}

/**
 * Inserisci canzone in posizione specifica (con transazione e versioning)
 * @param {object} serverQueue - Coda del server
 * @param {object} song - Canzone da inserire
 * @param {number} index - Indice di inserimento
 * @returns {{success: boolean, error?: string}}
 */
function insertSongAtIndex(serverQueue, song, index) {
    try {
        const guildId = serverQueue.guildId;
        const stateVersion = stateVersionManager.get(guildId);

        // Validazione
        if (!isValidSong(song) || index < 0) {
            console.warn(`⚠️ [QUEUE-INSERT] Tentativo inserimento canzone non valida`);
            return { success: false, error: 'Invalid song or index' };
        }
        if (!serverQueue || !serverQueue.songs) {
            return { success: false, error: 'Invalid queue' };
        }
        if (index > serverQueue.songs.length) {
            return { success: false, error: `Index out of range: ${index}` };
        }

        // Snapshot dello stato prima della modifica (per rollback)
        const previousSongs = [...serverQueue.songs];
        const previousPlayIndex = serverQueue.playIndex;

        try {
            // Inserisci la canzone
            serverQueue.songs.splice(index, 0, song);

            // Aggiusta playIndex se l'inserimento è prima o al punto corrente
            const playIndex = serverQueue.playIndex || 0;
            if (index <= playIndex) {
                serverQueue.playIndex = playIndex + 1;
            }

            console.log(`📥 [QUEUE-INSERT] Inserita "${sanitizeTitle(song.title)}" in posizione ${index}`);

            // Salva lo stato
            saveQueueState(guildId, serverQueue);

            // Incrementa versione
            stateVersion.incrementVersion('queue_insert', {
                index,
                songTitle: sanitizeTitle(song.title)
            });

            return { success: true };

        } catch (e) {
            // ROLLBACK se il salvataggio fallisce
            console.error(`❌ [QUEUE-INSERT] Errore, rollback:`, e.message);
            serverQueue.songs = previousSongs;
            serverQueue.playIndex = previousPlayIndex;

            stateVersion.incrementVersion('queue_insert_rollback', {
                error: e.message
            });

            return { success: false, error: `Failed to insert song: ${e.message}` };
        }

    } catch (e) {
        console.error(`❌ [QUEUE-INSERT] Fatal error:`, e);
        return { success: false, error: e.message };
    }
}

/**
 * Rimuovi canzone da indice specifico (con transazione e versioning)
 * @param {object} serverQueue - Coda del server
 * @param {number} index - Indice da rimuovere
 * @returns {{success: boolean, removed?: object, error?: string}}
 */
function removeSongAtIndex(serverQueue, index) {
    try {
        const guildId = serverQueue.guildId;
        const stateVersion = stateVersionManager.get(guildId);

        // Validazione
        if (!serverQueue || !serverQueue.songs) {
            return { success: false, error: 'Invalid queue' };
        }
        if (index < 0 || index >= serverQueue.songs.length) {
            console.warn(`⚠️ [QUEUE-REMOVE] Indice fuori range: ${index}`);
            return { success: false, error: `Index out of range: ${index}` };
        }

        // Snapshot dello stato prima della modifica (per rollback)
        const previousSongs = [...serverQueue.songs];
        const previousPlayIndex = serverQueue.playIndex;
        const previousNextDeckLoaded = serverQueue.nextDeckLoaded;
        const previousNextDeckTarget = serverQueue.nextDeckTarget;

        try {
            // Rimuovi la canzone
            const removed = serverQueue.songs.splice(index, 1)[0];

            if (removed) {
                // Aggiusta playIndex dopo la rimozione
                const playIndex = serverQueue.playIndex || 0;
                if (index < playIndex) {
                    serverQueue.playIndex = Math.max(0, playIndex - 1);
                } else if (index === playIndex && serverQueue.playIndex >= serverQueue.songs.length && serverQueue.songs.length > 0) {
                    serverQueue.playIndex = serverQueue.songs.length - 1;
                }

                // Invalida preload se la canzone rimossa era quella precaricata
                if (serverQueue.nextDeckLoaded && areSameSong(serverQueue.nextDeckLoaded, removed.url)) {
                    serverQueue.nextDeckLoaded = null;
                    serverQueue.nextDeckTarget = null;
                }

                // Invalida i binding deck→canzone che puntano alla canzone rimossa
                if (serverQueue.deckSongs) {
                    for (const d of ['A', 'B']) {
                        const b = serverQueue.deckSongs[d];
                        if (b && areSameSong(b.url, removed.url)) serverQueue.deckSongs[d] = null;
                    }
                }

                console.log(`🗑️ [QUEUE-REMOVE] Rimossa "${sanitizeTitle(removed.title)}" da posizione ${index}`);

                // Salva lo stato
                saveQueueState(guildId, serverQueue);

                // Incrementa versione
                stateVersion.incrementVersion('queue_remove', {
                    index,
                    songTitle: sanitizeTitle(removed.title)
                });

                // Notifica preload update
                try { require('../audio').updatePreloadAfterQueueChange(guildId); } catch (e) { }

                return { success: true, removed };
            }

            return { success: false, error: 'Failed to remove song' };

        } catch (e) {
            // ROLLBACK se il salvataggio fallisce
            console.error(`❌ [QUEUE-REMOVE] Errore, rollback:`, e.message);
            serverQueue.songs = previousSongs;
            serverQueue.playIndex = previousPlayIndex;
            serverQueue.nextDeckLoaded = previousNextDeckLoaded;
            serverQueue.nextDeckTarget = previousNextDeckTarget;

            stateVersion.incrementVersion('queue_remove_rollback', {
                error: e.message
            });

            return { success: false, error: `Failed to remove song: ${e.message}` };
        }

    } catch (e) {
        console.error(`❌ [QUEUE-REMOVE] Fatal error:`, e);
        return { success: false, error: e.message };
    }
}

/**
 * Verifica se il mixer è attivo e funzionante
 * @param {object} serverQueue - Coda del server
 * @returns {boolean}
 */
function isMixerAlive(serverQueue) {
    return serverQueue &&
        serverQueue.mixer &&
        serverQueue.mixer.isProcessAlive &&
        serverQueue.mixer.isProcessAlive();
}

// switchActiveDeck, advanceToNextSong, getCurrentPlayingSong rimossi in v3
// Tutta la logica di transizione è centralizzata in SkipManager v3

/**
 * Pulizia completa alla disconnessione forzata (bot rimasto solo o disconnect)
 * @param {object} serverQueue
 */
function performDisconnectCleanup(serverQueue) {
    if (!serverQueue) return;
    if (serverQueue._cleaningUp) return; // Guard contro re-entry (evita cascade)
    if (serverQueue._isReconnecting) return; // Non interferire con riconnessione in corso
    serverQueue._cleaningUp = true;
    try {
        console.log(`🧹 [CLEANUP] Eseguo cleanup di disconnessione per guild ${serverQueue.guildId}`);

        // Cancella transizione differita pendente
        if (serverQueue.pendingTransition) {
            if (serverQueue.pendingTransition._cleanupTimer) clearTimeout(serverQueue.pendingTransition._cleanupTimer);
            serverQueue.pendingTransition = null;
        }

        // Cancella dashboard timer pendente
        if (serverQueue.dashboardState && serverQueue.dashboardState.timer) {
            clearTimeout(serverQueue.dashboardState.timer);
            serverQueue.dashboardState.timer = null;
        }

        // ── STATS: ferma timer ascolto e salva su disco ──
        try {
            const stats = require('../database/stats');
            stats.flushGuildAndSave(serverQueue.guildId);
        } catch (e) { }

        // Ferma il player
        try { if (serverQueue.player) serverQueue.player.stop(true); } catch (e) { }
        // Kill mixer se presente
        try { if (serverQueue.mixer && typeof serverQueue.mixer.kill === 'function') serverQueue.mixer.kill(); } catch (e) { }
        // Distruggi la connessione vocale
        try { if (serverQueue.connection) serverQueue.connection.destroy(); } catch (e) { }

        // Cleanup low-latency stream per evitare pipe/fd leak
        try { if (serverQueue._llStream) { serverQueue._llStream.unpipe(); serverQueue._llStream.destroy(); serverQueue._llStream = null; } } catch (e) { }

        // Cleanup stato audio per-guild
        try { require('../audio').clearStreamErrors(serverQueue.guildId); } catch (e) { }
        try { require('../audio/playback').cleanupPlaybackState(serverQueue.guildId); } catch (e) { }
        try { require('../audio/SkipManager').cleanupSkipState(serverQueue.guildId); } catch (e) { }
        try { require('../commands/play').cleanupLastCleanupTime(serverQueue.guildId); } catch (e) { }

        // Resetta alcuni campi dello stato della coda
        serverQueue.connection = null;
        serverQueue.currentDeckLoaded = null;
        serverQueue.nextDeckLoaded = null;
        serverQueue.isPaused = false;
        serverQueue.songStartTime = null;
        serverQueue.nextDeckTarget = null;
        clearDeckBindings(serverQueue);

        // Salva stato su disco
        try { saveQueueState(serverQueue.guildId, serverQueue); } catch (e) { }

        // Assicurati di rimuovere i riferimenti a mixer e player per evitare duplicati dopo il restart
        try { serverQueue.mixer = null; } catch (e) { }
        try { serverQueue.player = null; } catch (e) { }
        // Cancella eventuale timer schedulato
        try { disconnectTimers.delete(serverQueue.guildId); } catch (e) { }

    } catch (e) {
        console.error('❌ [CLEANUP] Errore durante cleanup disconnessione:', e);
    } finally {
        serverQueue._cleaningUp = false;
    }
}

/**
 * Programma la disconnessione quando il bot è solo nel canale vocale
 * @param {object} serverQueue
 * @param {number} timeoutMs
 */
function scheduleDisconnectIfAlone(serverQueue, timeoutMs = DISCONNECT_TIMEOUT_MS) {
    if (!serverQueue || !serverQueue.guildId) return false;
    const gid = serverQueue.guildId;

    // Immediate cleanup request (e.g. bot disconnesso/espulso)
    // bypassa i controlli sul canale e chiama direttamente il cleanup.
    if (timeoutMs === 0) {
        // Se c'è un timer già schedulato, annullalo.
        if (disconnectTimers.has(gid)) {
            try { clearTimeout(disconnectTimers.get(gid)); } catch (e) { }
            disconnectTimers.delete(gid);
        }
        performDisconnectCleanup(serverQueue);
        return true;
    }

    // Se non è solo, assicurati di cancellare qualsiasi timer precedente
    if (!isBotAloneInChannel(serverQueue)) {
        if (disconnectTimers.has(gid)) {
            clearTimeout(disconnectTimers.get(gid));
            disconnectTimers.delete(gid);
        }
        return false;
    }
    // Se esiste già un timer, non fare nulla
    if (disconnectTimers.has(gid)) return true;
    const t = setTimeout(() => {
        try {
            // Ricontrolla prima di eseguire
            if (isBotAloneInChannel(serverQueue)) {
                performDisconnectCleanup(serverQueue);
            } else {
                // Qualcuno è tornato: cancella semplicemente il timer
                disconnectTimers.delete(gid);
            }
        } catch (e) { disconnectTimers.delete(gid); }
    }, timeoutMs);
    disconnectTimers.set(gid, t);
    console.log(`⏱️ [SCHEDULE] Timer di disconnect programmato per guild ${gid} (${timeoutMs}ms)`);
    return true;
}

/**
 * Cancella un timer di disconnect programmato
 * @param {object} serverQueue
 */
function cancelScheduledDisconnect(serverQueue) {
    if (!serverQueue || !serverQueue.guildId) return false;
    const gid = serverQueue.guildId;
    if (!disconnectTimers.has(gid)) return false;
    try {
        clearTimeout(disconnectTimers.get(gid));
    } catch (e) { }
    disconnectTimers.delete(gid);
    console.log(`⏱️ [CANCEL] Timer di disconnect cancellato per guild ${gid}`);
    return true;
}

module.exports = {
    isBotAloneInChannel,
    clearFinishedQueue,
    getCurrentSong,
    getPlayingIndex,
    getNextSong,
    hasNextSong,
    bindDeckSong,
    resolveDeckIndex,
    clearDeckBindings,
    isValidSong,
    insertSongAtIndex,
    removeSongAtIndex,
    isMixerAlive,
    scheduleDisconnectIfAlone,
    cancelScheduledDisconnect
};
