/**
 * src/audio/index.js
 * 
 * Punto di ingresso centralizzato del sistema audio.
 * Esporta le funzioni pubbliche e gestisce il routing degli eventi Rust.
 */

const AudioMixerController = require('./AudioMixerController');
const playback = require('./playback');
const PlaybackEngine = require('./PlaybackEngine');
const SkipManager = require('./SkipManager');
const { queue } = require('../state/globals');
const { isBotAloneInChannel, scheduleDisconnectIfAlone, getNextSong, getCurrentSong } = require('../queue/QueueManager');
const { sanitizeTitle } = require('../utils/sanitize');
const ui = require('../ui');

// ─── Stream error tracking ─────────────────────────────────

const failedSongs = new Map();       // guildId -> Set<url>
const streamErrorCounts = new Map(); // guildId -> { url: count }

function recordStreamError(guildId, url) {
    if (!streamErrorCounts.has(guildId)) streamErrorCounts.set(guildId, {});
    const counts = streamErrorCounts.get(guildId);
    counts[url] = (counts[url] || 0) + 1;

    if (counts[url] >= 3) {
        if (!failedSongs.has(guildId)) failedSongs.set(guildId, new Set());
        failedSongs.get(guildId).add(url);
        console.error(`❌ [STREAM] Canzone marcata non riproducibile (${counts[url]} errori): ${url.substring(0, 60)}`);
        return true;
    }
    return false;
}

// ─── Rust event routing ─────────────────────────────────────

/**
 * Callback invocata dal mixer quando un deck diventa pronto (versioning-aware)
 * Verifica che il buffer sia per il contenuto corretto (previene stale buffers)
 */
function handleBufferReady(guildId, deck) {
    try {
        const sq = queue.get(guildId);
        if (!sq) return;
        
        // Incrementa versione quando buffer diventa pronto
        const { stateVersionManager } = require('../state/StateVersion');
        const stateVersion = stateVersionManager.get(guildId);
        
        sq.bufferReady = sq.bufferReady || {};
        sq.bufferReady[deck] = true;
        
        stateVersion.incrementVersion('buffer_ready', {
            deck,
            loadedUrl: (deck === 'A' ? sq.currentDeckLoaded : sq.nextDeckLoaded)?.substring(0, 60) || 'N/A'
        });
        
        console.log(`✅ [BUFFER-READY] Deck ${deck} pronto per riproduzione`);

            // Se c'è una transizione differita in attesa di questo deck, eseguila ora
            if (sq.pendingTransition && sq.pendingTransition.targetDeck === deck) {
                SkipManager.completePendingTransition(guildId).catch(e => {
                    console.error('❌ [BUFFER-READY] Errore completePendingTransition:', e);
                });
            }
    } catch (e) { 
        console.error(`❌ [BUFFER-READY] Errore:`, e);
    }
}

/**
 * Riceve log/eventi dal processo Rust
 */
function handleRustEvent(guildId, log) {
    try {
        if (!log || !log.event) return;

        // Stream errors
        if (log.event === 'stream_error') {
            const dataStr = (log.data || '').toLowerCase();
            if (dataStr.includes('opus') && dataStr.includes('error')) {
                const sq = queue.get(guildId);
                if (sq && sq.currentDeckLoaded) {
                    const marked = recordStreamError(guildId, sq.currentDeckLoaded);
                    if (marked) {
                        console.error(`🛑 [STREAM] Auto-skip canzone corrotta`);
                        SkipManager.autoSkip(guildId);
                    }
                }
            }
            return;
        }

        // Crossfade avviato dal Rust (conferma)
        if (log.event === 'crossfade_started') {
            console.log('🎚️  [RUST] Crossfade avviato');
            return;
        }

        // 3 secondi prima della fine della canzone
        if (log.event === 'approaching_end') {
            const sq = queue.get(guildId);
            if (sq) {
                const fadeEnabled = !!(sq.fadeEnabled && sq.mixer && sq.mixer.crossfade);
                const { getNextSong } = require('../queue/QueueManager');
                const nextSong = getNextSong(sq);
                
                // Se c'è già una pending transition, non avviare un altro auto-skip:
                // completePendingTransition() gestirà il cambio quando il buffer è pronto.
                // Tollera solo se scaduta (> 25s), in quel caso procedi normalmente.
                const ptAge = sq.pendingTransition ? (Date.now() - sq.pendingTransition.startTime) : Infinity;
                if (sq.pendingTransition && ptAge < 25000) {
                    console.log(`⏳ [APPROACHING-END] Transizione differita in corso (${Math.round(ptAge/1000)}s) – skip auto-crossfade`);
                    return;
                }

                if (fadeEnabled && nextSong) {
                    // Fade attivo + c'è una canzone successiva: avvia crossfade automatico
                    console.log('🎚️  [APPROACHING-END] 3s prima della fine – crossfade automatico');
                    SkipManager.autoSkip(guildId).catch(e => {
                        console.error('❌ [APPROACHING-END] Errore autoSkip:', e);
                    });
                } else if (!nextSong) {
                    // NESSUNA CANZONE SUCCESSIVA (indipendentemente dal fade)
                    // Carica la traccia corrente sull'altra deck come fallback
                    // Così il Rust continua a riprodurre fino alla fine naturale senza terminare prematuramente
                    const currentSong = require('../queue/QueueManager').getCurrentSong(sq);
                    if (currentSong && sq.mixer && sq.mixer.isProcessAlive && sq.mixer.isProcessAlive()) {
                        const otherDeck = (sq.currentDeck || 'A') === 'A' ? 'B' : 'A';
                        try {
                            sq.bufferReady = sq.bufferReady || {};
                            sq.bufferReady[otherDeck] = false;
                            // Carica la stessa canzone in fallback (autoplay=false)
                            sq.mixer.load(currentSong.url, otherDeck, false);
                            console.log('⏳ [APPROACHING-END] Nessuna next track – caricamento fallback per continuare fino alla fine');
                        } catch (e) {
                            console.warn(`⚠️  [APPROACHING-END] Fallback load fallito:`, e.message);
                        }
                    }
                } else {
                    // Fade disattivo + c'è una canzone successiva: non fare nulla, skip istantaneo a fine naturale
                    console.log('⏭️  [APPROACHING-END] 3s prima della fine – fade OFF, attendo fine naturale');
                }
            }
            return;
        }

        // Fine traccia
        if (log.event === 'end') {
            PlaybackEngine.handleTrackEnd(guildId).catch(e => {
                console.error('❌ [TRACK-END] Errore in handleTrackEnd:', e);
            });
            return;
        }

        // ── AUTO-GAPLESS: Rust ha switchato deck autonomamente (zero round-trip) ──
        if (log.event === 'auto_end_switch') {
            handleAutoEndSwitch(guildId, log.data).catch(e => {
                console.error('❌ [AUTO-GAPLESS] Errore in handleAutoEndSwitch:', e);
            });
            return;
        }

        // ── AUTO-LOOP: Rust ha riavviato il deck corrente per loop mode ──
        if (log.event === 'auto_loop_restart') {
            handleAutoLoopRestart(guildId, log.data);
            return;
        }

        // Cambio deck (conferma – stato già aggiornato da SkipManager)
        if (log.event === 'deck_changed') {
            const deckStr = log.data || '';
            const match = deckStr.match(/deck=([A-C])/);
            const newDeck = match ? match[1] : deckStr;
            PlaybackEngine.handleDeckChanged(guildId, newDeck);
            return;
        }

        // deck_proposal legacy – ignorato
        if (log.event === 'deck_proposal') return;

        // Errori
        if (log.event === 'error' || log.event === 'yt_error') {
            console.error(`🦀 [RUST-${guildId}] ERRORE`, log.data || '');
        }
    } catch (e) { /* ignora */ }
}

// ─── Auto-gapless handlers ──────────────────────────────────

/**
 * Rust ha switchato automaticamente al deck precaricato quando il deck attivo è finito.
 * Aggiorna lo stato Node.js senza inviare comandi al Rust (la transizione è già avvenuta).
 */
async function handleAutoEndSwitch(guildId, newDeck) {
    try {
        const sq = queue.get(guildId);
        if (!sq) return;

        // ── STATS: canzone completata (gapless auto-switch) ──
        try { require('../database/stats').incrementSongsCompleted(); } catch (e) {}

        // Se c'è una transizione differita per questo deck (utente aveva già premuto skip
        // mentre il deck era in download), lascia che completePendingTransition gestisca
        // il tutto: conosce l'indice corretto (potrebbe essere ≠ nextIndex).
        if (sq.pendingTransition && sq.pendingTransition.targetDeck === newDeck) {
            console.log(`⚡ [AUTO-GAPLESS] Deck ${newDeck} ha pending transition – delego completePendingTransition`);
            sq.currentDeck = newDeck; // aggiorna currentDeck per riflettere realtà Rust
            await SkipManager.completePendingTransition(guildId, true /* alreadySwitched */);
            return;
        }

        const nextIndex = (sq.playIndex || 0) + 1;

        // Se non ci sono più canzoni, termina la coda
        if (nextIndex >= sq.songs.length) {
            console.log('🏁 [AUTO-GAPLESS] Fine coda raggiunta dopo auto-switch');
            await SkipManager.endQueue(guildId);
            return;
        }

        const nextSong = sq.songs[nextIndex];

        // Aggiorna stato (nessun comando a Rust — la transizione è già fatta)
        sq.playIndex = nextIndex;
        sq.currentDeck = newDeck;
        sq.currentDeckLoaded = nextSong ? nextSong.url : null;
        sq.nextDeckLoaded = null;
        sq.nextDeckTarget = null;
        sq.songStartTime = Date.now();
        sq.loadingFooter = null;
        sq._lastTransitionTime = Date.now();

        // ── STATS: nuova canzone avviata (auto-gapless) ──
        try {
            const stats = require('../database/stats');
            stats.incrementSongsStarted();
            stats.recordSongPlay(guildId, nextSong, sq.voiceChannel);
        } catch (e) {}

        // Salva stato e aggiorna UI
        const { saveQueueState } = require('../queue/persistence');
        saveQueueState(guildId, sq);
        ui.refreshDashboard(sq, nextSong ? nextSong.requester : null);

        // Precarica la prossima canzone sull'altro deck
        PlaybackEngine.onSongStart(guildId);

        console.log(`⚡ [AUTO-GAPLESS] → "${nextSong ? sanitizeTitle(nextSong.title) : '?'}" (idx=${nextIndex}, deck=${newDeck})`);
    } catch (e) {
        console.error('❌ [AUTO-GAPLESS] Errore handleAutoEndSwitch:', e);
    }
}
/**
 * Rust ha riavviato automaticamente il deck corrente (loop mode).
 * Aggiorna solo i timestamp e avvia un nuovo ciclo di preload.
 */
function handleAutoLoopRestart(guildId, deck) {
    try {
        const sq = queue.get(guildId);
        if (!sq) return;

        sq.songStartTime = Date.now();

        // ── STATS: canzone completata + riniziata (loop) ──
        try {
            const stats = require('../database/stats');
            stats.incrementSongsCompleted();
            stats.incrementSongsStarted();
        } catch (e) {}

        // Riavvia il timer di preload per la prossima canzone
        PlaybackEngine.onSongStart(guildId);

        const currentSong = sq.songs[sq.playIndex || 0];
        console.log(`🔁 [AUTO-LOOP] "${currentSong ? sanitizeTitle(currentSong.title) : '?'}" riavviata (deck ${deck})`);
    } catch (e) {
        console.error('❌ [AUTO-LOOP] Errore handleAutoLoopRestart:', e);
    }
}

// ─── Mixer crash recovery con structured logging ───────────────────

function handleMixerCrash(guildId, reason) {
    try {
        const sq = queue.get(guildId);
        if (!sq) {
            console.error(`🚨 [MIXER-CRASH] guild=${guildId} reason=${reason} - Queue non trovata`);
            return;
        }

        // ── CONTEXT DI DEBUG STRUTTURATO ──
        const currentSongData = getCurrentSong(sq);
        const crashContext = {
            timestamp: new Date().toISOString(),
            guildId,
            reason,
            currentSong: currentSongData?.title || 'N/A',
            playIndex: sq.playIndex || 0,
            totalSongs: sq.songs?.length || 0,
            currentDeck: sq.currentDeck || 'unknown',
            currentDeckLoaded: sq.currentDeckLoaded?.substring(0, 60) || 'N/A',
            nextDeckLoaded: sq.nextDeckLoaded?.substring(0, 60) || 'N/A',
            isPaused: sq.isPaused || false,
            fadeEnabled: sq.fadeEnabled || false,
            mixerGeneration: sq.mixerGeneration || 'N/A',
            connectionStatus: sq.connection?.state?.status || 'disconnected',
            recoveryAttempts: sq.crashRecoveryAttempts || 0,
            voiceChannelMembersCount: sq.voiceChannel?.members?.size || 0
        };

        console.error(`🚨 [MIXER-CRASH] ${JSON.stringify(crashContext)}`);

        // ── STATS: ferma tutti i timer ascolto (il recovery li riavvierà in playSong) ──
        try { require('../database/stats').stopAllListeners(guildId); } catch (e) {}

        // Log su file per post-mortem analysis
        try {
            const fs = require('fs');
            const path = require('path');
            const logPath = path.join('./logs', 'mixer-crashes.log');
            const logEntry = `${JSON.stringify(crashContext)}\n`;
            fs.appendFileSync(logPath, logEntry);
        } catch (e) { /* ignore */ }

        // Se il mixer è stato intenzionalmente terminato (da endQueue), non riavviare
        if (sq.intentionalKill) {
            sq.intentionalKill = false;  // Pulisci il flag
            console.log(`ℹ️  [CRASH-RECOVERY] Terminazione intenzionale rilevata, skip recovery`);
            return;
        }

        try { playback.recordMixerCrashTime(guildId); } catch (e) { /* ignora */ }

        sq.crashRecoveryAttempts = (sq.crashRecoveryAttempts || 0) + 1;
        console.warn(`⚠️  [CRASH-RECOVERY] Tentativo #${sq.crashRecoveryAttempts} per guild=${guildId}`);

        if (sq.crashRecoveryAttempts > 2) {
            console.error(`❌ [CRASH-RECOVERY] Troppi tentativi di recovery (${sq.crashRecoveryAttempts}), disconnessione...`);
            scheduleDisconnectIfAlone(sq, 0);
            return;
        }

        if (isBotAloneInChannel(sq)) {
            console.log(`ℹ️  [CRASH-RECOVERY] Bot solo nel canale, skip recovery`);
            scheduleDisconnectIfAlone(sq, 0);
            return;
        }

        // Kill mixer e resetta stato deck
        try { if (sq.mixer) sq.mixer.kill(); sq.mixer = null; } catch (e) { /* ignora */ }
        sq.currentDeck = null;
        sq.currentDeckLoaded = null;
        sq.nextDeckLoaded = null;
        sq.nextDeckTarget = null;

        // Tenta restart se la connessione vocale è pronta
        try {
            const VCS = require('@discordjs/voice').VoiceConnectionStatus;
            const connReady = sq.connection && sq.connection.state && sq.connection.state.status === VCS.Ready;
            if (connReady && sq.voiceChannel) {
                const delayMs = 500 + (sq.crashRecoveryAttempts * 500);
                console.log(`⏳ [CRASH-RECOVERY] Scheduling playSong restart in ${delayMs}ms`);
                setTimeout(() => {
                    try { playback.playSong(guildId); } catch (e) { console.error(`❌ [CRASH-RECOVERY] playSong restart error (guild=${guildId}):`, e); }
                }, delayMs);
            } else {
                console.log(`ℹ️  [CRASH-RECOVERY] Connessione vocale non pronta (status=${connReady ? 'ready' : 'not ready'}), skip recovery`);
                scheduleDisconnectIfAlone(sq, 0);
            }
        } catch (e) { console.error(`❌ [CRASH-RECOVERY] Error during recovery attempt:`, e); }
    } catch (e) { console.error('❌ [CRASH-RECOVERY] Fatal error in handleMixerCrash:', e); }
}

// ─── Preload update ─────────────────────────────────────────

async function updatePreloadAfterQueueChange(guildId) {
    try {
        const sq = queue.get(guildId);
        if (!sq || !sq.mixer || !sq.mixer.isProcessAlive()) return;
        // Invalida preload corrente e ri-precarica
        sq.nextDeckLoaded = null;
        sq.nextDeckTarget = null;
        PlaybackEngine.preloadNextSong(guildId);
    } catch (e) {
        console.error('❌ [PRELOAD-UPDATE] Errore:', e);
    }
}



// ─── Exports ────────────────────────────────────────────────

module.exports = {
    AudioMixerController,

    // Playback base
    playSong: playback.playSong,
    restartCurrentSong: playback.restartCurrentSong,
    togglePauseResume: playback.togglePauseResume,

    // PlaybackEngine
    PlaybackEngine,

    // Skip (v3 – sistema unificato)
    skipNext: SkipManager.skipNext,
    skipPrev: SkipManager.skipPrev,
    skipToIndex: SkipManager.skipToIndex,
    autoSkip: SkipManager.autoSkip,
    endQueue: SkipManager.endQueue,
    hasSkipInProgress: SkipManager.hasSkipInProgress,

    // Preload
    updatePreloadAfterQueueChange,
    preloadNextSongs: updatePreloadAfterQueueChange,

    // Rust event routing
    handleBufferReady,
    handleRustEvent,
    handleMixerCrash,

    // Stream errors
    recordStreamError,
    isFailedSong: (guildId, url) => failedSongs.has(guildId) && failedSongs.get(guildId).has(url),

    // UI helpers
    refreshDashboard: (sq, userId = null) => ui.refreshDashboard(sq, userId),
    updateDashboardToFinished: ui.updateDashboardToFinished
};
