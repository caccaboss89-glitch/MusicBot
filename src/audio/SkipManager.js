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

            // Attendi buffer con versioning check
            const bufferReady = await waitForBufferReady(sq, targetDeck, guildId, versionAtStart, 8000);
            if (!isMixerAlive(sq)) { sq.loadingFooter = null; return false; }

            // 🔥 CRITICO: Se il buffer non è pronto dopo timeout, non possiamo fare il crossfade
            // Il Rust auto-gapless (o pending_transition) dovrà gestire la transizione quando i dati arrivano
            if (!bufferReady) {
                console.warn(`⚠️  [SKIP] Buffer timeout per deck ${targetDeck} (${reason}) - aspetto auto-gapless/pending`);
                sq.loadingFooter = null;
                return false;
            }

            // SERIALIZZA il comando finale crossfade/skipTo
            if (fadeEnabled) {
                sq.isCrossfading = true;                sq.crossfadeStartTime = Date.now();  // ⚠️  Traccia il momento di inizio per sincronizzazione                
                await commandQueue.enqueue(
                    guildId,
                    'crossfade',
                    () => { sq.mixer.crossfade(targetDeck, CROSSFADE_DURATION_MS); },
                    { timeout: 5000, priority: 'high' }
                );
                
                console.log(`🎚️  [SKIP] Crossfade → deck ${targetDeck} (${reason})`);
                
                // ⚠️  NON cancellare il flag qui con setTimeout
                // Il flag verrà cancellato quando onSongStart() viene callato,
                // che significa che il crossfade è definitivamente completato nel Rust
            } else {
                await commandQueue.enqueue(
                    guildId,
                    'skipTo',
                    () => { sq.mixer.skipTo(targetDeck); },
                    { timeout: 5000, priority: 'high' }
                );
                console.log(`⚡ [SKIP] Istantaneo → deck ${targetDeck} (${reason})`);
            }
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
        try { require('../database/stats').incrementSongsStarted(); } catch (e) {}

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

module.exports = {
    skipNext,
    skipPrev,
    skipToIndex,
    autoSkip,
    endQueue,
    hasSkipInProgress
};
