/**
 * SkipManager - Sistema di skip pulito e unificato
 *
 * Due tipi di skip:
 * 1. MANUALI: bottoni (next/prev) e menu a tendina (skipToIndex)
 * 2. AUTOMATICI: fine canzone (autoSkip chiamato da PlaybackEngine)
 *
 * Logica centrale (performTransition):
 *  - Verifica se la canzone target è precaricata nell'altro deck
 *  - Verifica se il fade è attivo
 *  - Se precaricata + fade → crossfade
 *  - Se precaricata + no fade → transizione istantanea (skipTo)
 *  - Se NON precaricata → mostra "Caricamento...", carica, poi transizione
 *  - Dopo la transizione aggiorna playIndex (senza toccare l'array songs)
 *
 * La coda (songs[]) resta IMMUTABILE durante gli skip.
 * La navigazione avviene solo tramite playIndex.
 * 
 * VERSIONING: Usa StateVersion per tracciare mutazioni atomiche e prevenire
 * race conditions causate da letture stale dello stato.
 */

const { queue } = require('../state/globals');
const { stateVersionManager } = require('../state/StateVersion');
const { commandQueue } = require('./CommandQueue');
const { CROSSFADE_DURATION_MS, SKIP_THROTTLE_MS } = require('../../config');
const { sanitizeTitle } = require('../utils/sanitize');
const { saveQueueState } = require('../queue/persistence');
const { isMixerAlive } = require('../queue/QueueManager');

// Lazy load per evitare dipendenze circolari
let PlaybackEngine;
function getPlaybackEngine() {
    if (!PlaybackEngine) PlaybackEngine = require('./PlaybackEngine');
    return PlaybackEngine;
}

// Throttle per prevenire spam di skip ravvicinati
const skipThrottle = new Map();  // guildId -> timestamp

// ─── Helpers ────────────────────────────────────────────────

function getOtherDeck(sq) {
    return (sq.currentDeck || 'A') === 'A' ? 'B' : 'A';
}

function isThrottled(guildId) {
    const now = Date.now();
    const last = skipThrottle.get(guildId) || 0;
    if (now - last < SKIP_THROTTLE_MS) return true;
    skipThrottle.set(guildId, now);
    return false;
}

/**
 * Attende che il buffer di un deck sia pronto (polling ogni 50ms)
 * Non controlla la versione: se il buffer è pronto, è pronto (indipendentemente da altri skip)
 */
function waitForBufferReady(sq, deck, guildId, expectedVersion, timeoutMs = 8000) {
    return new Promise(resolve => {
        if (sq.bufferReady && sq.bufferReady[deck]) return resolve(true);
        
        const start = Date.now();
        
        const check = () => {
            if (!sq.mixer || !sq.mixer.isProcessAlive()) return resolve(false);
            
            if (sq.bufferReady && sq.bufferReady[deck]) return resolve(true);
            if (Date.now() - start >= timeoutMs) return resolve(false);
            setTimeout(check, 50);
        };
        check();
    });
}

// ─── Core ───────────────────────────────────────────────────

/**
 * Esegue la transizione verso una canzone target con versioning atomico.
 * Gestisce preload, fade/istantaneo, e aggiornamento stato con tracciamento di versione.
 *
 * @param {string} guildId
 * @param {number} targetIndex  – indice assoluto in songs[]
 * @param {string} reason       – 'manual' | 'manual-select' | 'manual-prev' | 'auto'
 * @returns {Promise<boolean>}
 */
async function performTransition(guildId, targetIndex, reason) {
    const sq = queue.get(guildId);
    if (!sq || !isMixerAlive(sq)) return false;

    // ⚠️  CRITICO: Non permettere skip durante un crossfade in corso
    // Anche se il flag isCrossfading è false (cancellato da onSongStart()),
    // il Rust potrebbe still essere nel mezzo del crossfade
    // Controlla il timestamp: se il crossfade è iniziato da meno di CROSSFADE_DURATION_MS, aspetta
    if (sq.crossfadeStartTime && Date.now() - sq.crossfadeStartTime < CROSSFADE_DURATION_MS) {
        const timeElapsed = Date.now() - sq.crossfadeStartTime;
        console.warn(`⚠️  [SKIP] Crossfade in corso (iniziato ${timeElapsed}ms fa), aspetto che finisca prima di skippa`);
        return false;
    }

    const stateVersion = stateVersionManager.get(guildId);
    const operationId = `skip_${guildId}_${Date.now()}`;
    
    // Acquisisci lock esclusivo per questa operazione di skip
    // Timeout: 30s max per completare tutto (load, buffer wait, crossfade, etc)
    const lock = stateVersion.acquireLock(operationId, 30000);

    try {
        // Prevenire skip concorrenti
        if (stateVersion.hasActiveLock(`skip_${guildId}`) && stateVersion.hasActiveLock(operationId) === false) {
            console.warn(`⚠️  [SKIP] Ignorato – skip già in corso`);
            return false;
        }

        const targetSong = sq.songs[targetIndex];
        if (!targetSong || !targetSong.url) {
            console.warn(`⚠️  [SKIP] Canzone target non valida (index=${targetIndex})`);
            return false;
        }

        const versionAtStart = stateVersion.incrementVersion('skip_start', {
            targetIndex,
            reason,
            targetSongTitle: sanitizeTitle(targetSong.title)
        });

        const fadeEnabled = !!(sq.fadeEnabled && sq.mixer && sq.mixer.crossfade);
        const targetDeck = getOtherDeck(sq);
        const oldDeck = sq.currentDeck || 'A';
        const targetUrl = targetSong.url;

        // Verifica se la canzone è precaricata sul deck target
        // CRITICO: Controlla sia l'URL che lo stato bufferReady per evitare false-positive
        // "preloaded" significa che il Rust ha dati audio pronti, non solo che l'URL è stato inviato
        const isPreloaded = sq.nextDeckLoaded === targetUrl 
                         && sq.nextDeckTarget === targetDeck
                         && sq.bufferReady && sq.bufferReady[targetDeck];

        const PB = getPlaybackEngine();

        // Pulisci timer del brano corrente (preload / end-monitor)
        PB.clearAllTimers(guildId);

        if (isPreloaded) {
            // ── FAST PATH: precaricata ──
            // Il Rust gestisce il buffer internamente: se il deck ha dati, switcha subito.
            // Se il deck non ha ancora dati, il Rust imposta un "pending skip" e
            // continua a riprodurre il deck corrente fino a quando i dati arrivano.
            
            // SERIALIZZA il comando attraverso command queue per evitare race conditions
            if (fadeEnabled) {
                sq.isCrossfading = true;
                sq.crossfadeStartTime = Date.now();  // ⚠️  Traccia il momento di inizio per sincronizzazione
                
                await commandQueue.enqueue(
                    guildId,
                    'crossfade',
                    () => { sq.mixer.crossfade(targetDeck, CROSSFADE_DURATION_MS); },
                    { timeout: 5000, priority: 'high' }
                );
                
                console.log(`🎚️  [SKIP] Crossfade → deck ${targetDeck} (${reason}, preloaded)`);
                
                // ⚠️  NON cancellare il flag qui con setTimeout
                // Il flag verrà cancellato quando onSongStart() viene callato,
                // che significa che il crossfade è definitivamente completato nel Rust
                // e la nuova canzone ha iniziato a riprodursi
            } else {
                await commandQueue.enqueue(
                    guildId,
                    'skipTo',
                    () => { sq.mixer.skipTo(targetDeck); },
                    { timeout: 5000, priority: 'high' }
                );
                console.log(`⚡ [SKIP] → deck ${targetDeck} (${reason}, preloaded)`);
            }

        } else {
            // ── NON precaricata: carica da zero ──
            try { sq.mixer.stopDeck(targetDeck); } catch (e) { /* ignora */ }
            sq.bufferReady = sq.bufferReady || {};
            sq.bufferReady[targetDeck] = false;
            
            // SERIALIZZA il comando load
            await commandQueue.enqueue(
                guildId,
                'load',
                () => { sq.mixer.load(targetUrl, targetDeck, false); },  // autoplay: false, il skipTo/crossfade lo attiva
                { timeout: 8000, priority: 'high' }
            );

            if (reason !== 'auto') {
                sq.loadingFooter = '⏳ Caricamento in corso...';
                try { require('./index').refreshDashboard(sq); } catch (e) { /* ignora */ }
            }

            // ── TRANSIZIONE DIFFERITA ──
            // Il download su Linux richiede 10-12s; aspettare qui bloccherebbe la barrier
            // e causerebbe timeout sistematici. Invece registriamo una pendingTransition e
            // ritorniamo subito. completePendingTransition() verrà chiamato da:
            //   • handleBufferReady()   → deck pronto mentre il brano è ancora in riproduzione
            //   • handleAutoEndSwitch() → il Rust ha switchato autonomous via auto-gapless stall

            // Annulla eventuale pending precedente per lo stesso deck
            if (sq.pendingTransition && sq.pendingTransition.targetDeck === targetDeck) {
                if (sq.pendingTransition._cleanupTimer) clearTimeout(sq.pendingTransition._cleanupTimer);
            }

            const pendingStartTime = Date.now();
            const timeoutMs = sq.isPaused ? 2000 : 30000;
            const cleanupTimer = setTimeout(() => {
                const sq2 = queue.get(guildId);
                if (!sq2 || !sq2.pendingTransition || sq2.pendingTransition.startTime !== pendingStartTime) return;

                if (sq2.isPaused) {
                    console.warn(`⚠️  [SKIP] Pending transition scaduta (${timeoutMs}ms) in pausa – forzo transizione`);
                    // Forza la transizione anche se non abbiamo ricevuto buffer_ready dal Rust.
                    completePendingTransition(guildId).catch(e => {
                        console.error(`❌ [SKIP] Errore forzando completePendingTransition:`, e);
                    });
                } else {
                    console.warn(`⚠️  [SKIP] Pending transition scaduta (${timeoutMs}ms) – annullo`);
                    sq2.pendingTransition = null;
                    sq2.loadingFooter = null;
                    try { require('./index').refreshDashboard(sq2); } catch (e) {}
                }
            }, timeoutMs);

            sq.pendingTransition = {
                targetIndex,
                targetDeck,
                targetUrl,
                fadeEnabled,
                reason,
                startTime: pendingStartTime,
                _cleanupTimer: cleanupTimer
            };

            console.log(`⏳ [SKIP] Deck ${targetDeck} in download (${reason}) – transizione differita`);
            return true; // Stato verrà aggiornato da completePendingTransition
        }
        // ── Aggiorna stato ATOMICAMENTE ──
        // Tutte le mutazioni in una transazione logica per evitare state corruption
        sq.playIndex = targetIndex;
        sq.currentDeck = targetDeck;
        sq.currentDeckLoaded = targetSong.url;
        sq.nextDeckLoaded = null;
        sq.nextDeckTarget = null;
        sq.songStartTime = Date.now();
        sq.loadingFooter = null;
        sq._lastTransitionTime = Date.now();

        // ── STATS: nuova canzone avviata (transizione) ──
        try {
            const stats = require('../database/stats');
            stats.incrementSongsStarted();
            stats.recordSongPlay(guildId, targetSong, sq.voiceChannel);
        } catch (e) {}

        // Incrementa versione dopo tutte le mutazioni
        stateVersion.incrementVersion('skip_complete', {
            targetIndex,
            targetDeck,
            reason
        });

        // Salva e aggiorna UI
        saveQueueState(guildId, sq);
        try { require('./index').refreshDashboard(sq, targetSong.requester); } catch (e) { /* ignora */ }

        // Avvia ciclo preload + monitoraggio fine per la nuova canzone
        PB.onSongStart(guildId);

        // Se era in pausa durante lo skip, riprendi automaticamente
        try {
            const playback = require('./playback');
            await playback.resumeIfPaused(sq, guildId, targetDeck);
        } catch (e) {
            console.warn(`⚠️  [SKIP] Errore durante resumeIfPaused:`, e.message);
        }

        console.log(`✅ [SKIP] ${reason}: → "${sanitizeTitle(targetSong.title)}" (idx=${targetIndex}, deck=${targetDeck}, fade=${fadeEnabled})`);
        return true;

    } catch (e) {
        console.error(`❌ [SKIP] Errore durante transizione (${reason}):`, e);
        const sq2 = queue.get(guildId);
        if (sq2) sq2.loadingFooter = null;
        stateVersion.incrementVersion('skip_error', { reason, error: e.message });
        return false;
    } finally {
        // Rilascia il lock
        lock.release();
    }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Skip manuale al prossimo brano (bottone ⏭️)
 */
async function skipNext(guildId) {
    if (isThrottled(guildId)) return false;

    const sq = queue.get(guildId);
    if (!sq) return false;

    // Loop → riavvia canzone corrente
    if (sq.loopEnabled) {
        const playback = require('./playback');
        await playback.restartCurrentSong(guildId);
        return true;
    }

    const nextIndex = (sq.playIndex || 0) + 1;

    if (nextIndex >= sq.songs.length) {
        // Nessuna canzone successiva → termina la coda
        await endQueue(guildId);
        return true;
    }

    return await performTransition(guildId, nextIndex, 'manual');
}

/**
 * Skip manuale al brano precedente (bottone ⏮️)
 */
async function skipPrev(guildId) {
    if (isThrottled(guildId)) return false;

    const sq = queue.get(guildId);
    if (!sq) return false;

    const prevIndex = (sq.playIndex || 0) - 1;
    if (prevIndex < 0) return false;

    return await performTransition(guildId, prevIndex, 'manual-prev');
}

/**
 * Skip manuale a un indice specifico (menu a tendina)
 */
async function skipToIndex(guildId, targetIndex) {
    if (isThrottled(guildId)) return false;

    const sq = queue.get(guildId);
    if (!sq) return false;
    if (targetIndex < 0 || targetIndex >= sq.songs.length) return false;
    if (targetIndex === (sq.playIndex || 0)) return false; // Già in riproduzione

    return await performTransition(guildId, targetIndex, 'manual-select');
}

/**
 * Skip automatico a fine canzone (chiamato da PlaybackEngine)
 */
async function autoSkip(guildId) {
    const sq = queue.get(guildId);
    if (!sq) return false;

    // ── STATS: canzone completata (fine naturale) ──
    try { require('../database/stats').incrementSongsCompleted(); } catch (e) {}

    // Loop → riavvia canzone corrente
    if (sq.loopEnabled) {
        const playback = require('./playback');
        await playback.restartCurrentSong(guildId);
        return true;
    }

    const nextIndex = (sq.playIndex || 0) + 1;

    if (nextIndex >= sq.songs.length) {
        await endQueue(guildId);
        return true;
    }

    return await performTransition(guildId, nextIndex, 'auto');
}

/**
 * Termina la coda.
 * Mantiene l'ultima canzone in songs[0] per il replay (schermata "Coda Terminata").
 */
async function endQueue(guildId) {
    const sq = queue.get(guildId);
    if (!sq) return;

    const PB = getPlaybackEngine();
    PB.clearAllTimers(guildId);

    // ── STATS: ferma timer ascolto e salva ──
    try {
        const stats = require('../database/stats');
        stats.flushGuildAndSave(guildId);
    } catch (e) {}

    // Ultima canzone riprodotta (per embed "Coda Terminata" e replay)
    const lastSong = sq.songs[sq.playIndex || 0] || null;

    // Reset stato – l'ultima canzone resta per il replay
    sq.songs = lastSong ? [lastSong] : [];
    sq.history = [];
    sq.playIndex = 0;
    sq.currentDeckLoaded = null;
    sq.nextDeckLoaded = null;
    sq.nextDeckTarget = null;
    sq.songStartTime = null;
    sq.loadingFooter = null;
    sq.currentDeck = 'A';
    sq.isPaused = false;
    // Annulla eventuale pending transition
    if (sq.pendingTransition) {
        if (sq.pendingTransition._cleanupTimer) clearTimeout(sq.pendingTransition._cleanupTimer);
        sq.pendingTransition = null;
    }

    // Ferma player e mixer (marca come intenzionale per evitare crash-recovery)
    try { if (sq.player) sq.player.stop(true); } catch (e) { /* ignora */ }
    sq.intentionalKill = true;
    if (sq.mixer) {
        try { sq.mixer.kill(); } catch (e) { /* ignora */ }
        sq.mixer = null;
    }

    saveQueueState(guildId, sq);
    await require('../ui').updateDashboardToFinished(sq, lastSong);

    console.log(`🏁 [QUEUE-END] Coda terminata${lastSong ? ' (replay: ' + sanitizeTitle(lastSong.title) + ')' : ''}`);
}

/**
 * Verifica se c'è uno skip in corso (usando state versioning)
 */
function hasSkipInProgress(guildId) {
    const stateVersion = stateVersionManager.get(guildId);
    return stateVersion.hasActiveLock(`skip_${guildId}`);
}

/**
 * Completa una transizione differita quando il deck target diventa pronto.
 * Chiamato da handleBufferReady() o handleAutoEndSwitch() in src/audio/index.js.
 *
 * @param {string} guildId
 * @param {boolean} [alreadySwitched=false] – true se il Rust ha già switchato (auto-gapless):
 *   in quel caso non inviamo skip_to/crossfade, aggiorniamo solo lo stato Node.js.
 */
async function completePendingTransition(guildId, alreadySwitched = false) {
    const sq = queue.get(guildId);
    if (!sq) return;

    const pt = sq.pendingTransition;
    if (!pt) return;

    // Rimuovi subito per evitare doppia esecuzione
    sq.pendingTransition = null;
    if (pt._cleanupTimer) clearTimeout(pt._cleanupTimer);

    if (!isMixerAlive(sq)) {
        sq.loadingFooter = null;
        return;
    }

    // Verifica che la canzone target sia ancora valida in coda
    const targetSong = sq.songs[pt.targetIndex];
    if (!targetSong || targetSong.url !== pt.targetUrl) {
        console.warn(`⚠️  [SKIP] Pending transition invalidata: canzone rimossa dalla coda`);
        sq.loadingFooter = null;
        try { require('./index').refreshDashboard(sq); } catch (e) {}
        return;
    }

    // Se siamo già sul deck target (auto-gapless ha già switchato), non mandare comandi a Rust
    const rustAlreadySwitched = alreadySwitched || (sq.currentDeck === pt.targetDeck);

    if (!rustAlreadySwitched) {
        // Esegui il comando di switch
        try {
            if (pt.fadeEnabled) {
                sq.isCrossfading = true;
                sq.crossfadeStartTime = Date.now();
                sq.mixer.crossfade(pt.targetDeck, CROSSFADE_DURATION_MS);
                console.log(`🎚️  [SKIP] Crossfade → deck ${pt.targetDeck} (${pt.reason}, deferred)`);
            } else {
                sq.mixer.skipTo(pt.targetDeck);
                console.log(`⚡ [SKIP] → deck ${pt.targetDeck} (${pt.reason}, deferred)`);
            }
        } catch (e) {
            console.error(`❌ [SKIP] Errore comando pending transition:`, e.message);
            sq.loadingFooter = null;
            return;
        }
    }

    // ── Aggiorna stato ──
    sq.playIndex = pt.targetIndex;
    sq.currentDeck = pt.targetDeck;
    sq.currentDeckLoaded = pt.targetUrl;
    sq.nextDeckLoaded = null;
    sq.nextDeckTarget = null;
    sq.songStartTime = Date.now();
    sq.loadingFooter = null;
    sq._lastTransitionTime = Date.now();

    try {
        const stats = require('../database/stats');
        stats.incrementSongsStarted();
        stats.recordSongPlay(guildId, targetSong, sq.voiceChannel);
    } catch (e) {}

    stateVersionManager.get(guildId).incrementVersion('skip_deferred_complete', {
        targetIndex: pt.targetIndex,
        targetDeck: pt.targetDeck,
        reason: pt.reason
    });

    saveQueueState(guildId, sq);
    try { require('./index').refreshDashboard(sq, targetSong.requester); } catch (e) {}

    const PB = getPlaybackEngine();
    PB.onSongStart(guildId);

    try {
        const playback = require('./playback');
        await playback.resumeIfPaused(sq, guildId, pt.targetDeck);
    } catch (e) {}

    console.log(`✅ [SKIP] ${pt.reason}: → "${sanitizeTitle(targetSong.title)}" (idx=${pt.targetIndex}, deck=${pt.targetDeck}, fade=${pt.fadeEnabled}, deferred)`);
}

module.exports = {
    skipNext,
    skipPrev,
    skipToIndex,
    autoSkip,
    endQueue,
    hasSkipInProgress,
    completePendingTransition
};
