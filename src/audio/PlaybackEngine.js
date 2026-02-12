/**
 * PlaybackEngine - Gestore temporizzazione audio
 *
 * Responsabilità:
 * 1. Precaricamento: 5s dopo l'inizio di ogni canzone, precarica la successiva nell'altro deck
 * 2. Monitoraggio: Ascolta l'evento 'end' dal Rust (fine traccia naturale)
 *    - Quando arriva 'end', verifica se c'è una canzone successiva e fa autoSkip
 * 3. Per crossfade automatico 3s prima della fine:
 *    - Il Rust deve inviare un evento 'approaching_end' (3s prima)
 *    - Oppure il Node.js invia un comando 'schedule_crossfade' al Rust all'inizio
 *
 * NON usa timer legati alla fine della canzone. Usa solo l'evento 'end' dal Rust.
 */

const { queue } = require('../state/globals');
const { sanitizeTitle, areSameSong } = require('../utils/sanitize');
const { DEFAULT_SONG_DURATION_S, CROSSFADE_DURATION_MS } = require('../../config');
const { isMixerAlive } = require('../queue/QueueManager');

const PRELOAD_DELAY_MS = 5000; // Precarica 5 secondi dopo l'inizio della canzone (per dare tempo ai chunk audio iniziali)

// ─── State ──────────────────────────────────────────────────

const timers = new Map(); // guildId -> { preloadTimer }

// ─── Helpers ────────────────────────────────────────────────

function getCurrentSong(sq) {
    if (!sq || !sq.songs || sq.songs.length === 0) return null;
    const idx = sq.playIndex || 0;
    return idx < sq.songs.length ? sq.songs[idx] : null;
}

function getNextSong(sq) {
    if (!sq || !sq.songs) return null;
    const nextIdx = (sq.playIndex || 0) + 1;
    return nextIdx < sq.songs.length ? sq.songs[nextIdx] : null;
}

function hasNextSong(sq) {
    if (!sq || !sq.songs) return false;
    return (sq.playIndex || 0) + 1 < sq.songs.length;
}

// ─── Timer Management ───────────────────────────────────────

function clearAllTimers(guildId) {
    const state = timers.get(guildId);
    if (state && state.preloadTimer) {
        clearTimeout(state.preloadTimer);
    }
    timers.delete(guildId);
}

// ─── Core ───────────────────────────────────────────────────

/**
 * Chiamato quando una nuova canzone inizia a riprodursi.
 * Schedula unicamente:
 *  - preload dopo 5 secondi sull'altro deck
 *
 * Non usa timer per monitorare la fine. Aspetta l'evento 'end' dal Rust.
 * Se vuoi crossfade automatico 3s prima della fine, il Rust deve inviare
 * un evento 'approaching_end' oppure il bot deve inviare 'schedule_crossfade'
 * al Rust all'inizio di questa canzone.
 */
function onSongStart(guildId) {
    const sq = queue.get(guildId);
    if (!sq) return;

    // ⚠️  Cancella il flag isCrossfading quando la nuova canzone EFFETTIVAMENTE inizia
    // A questo punto il crossfade è definitivamente completato nel Rust
    // Questo sincronizza il flag Node.js con lo stato reale del Rust
    sq.isCrossfading = false;

    const currentSong = getCurrentSong(sq);
    if (!currentSong || !isMixerAlive(sq)) return;

    // Cancella timer precedenti
    clearAllTimers(guildId);

    // ── Timer: Precarica la canzone successiva dopo 5 secondi ──
    const preloadTimer = setTimeout(() => {
        preloadNextSong(guildId);
    }, PRELOAD_DELAY_MS);

    // Salva il timer
    timers.set(guildId, { preloadTimer });

    console.log(`🎵 [PLAYBACK] Avviata: "${sanitizeTitle(currentSong.title)}"`);
    if (currentSong.duration && currentSong.duration > 0) {
        console.log(`⏱️  [PLAYBACK] Durata: ${currentSong.duration}s`);
    }
}

/**
 * Precarica la canzone successiva nell'altro deck.
 * Chiamato 5 secondi dopo l'inizio di ogni canzone.
 * Il deck viene caricato ma lasciato in pausa (pronto per skipTo istantaneo o crossfade).
 * 
 * Invalida il preload solo se la coda è effettivamente cambiata (playIndex, songs array),
 * non se è cambiato qualcosa di generico come buffer ready o loop mode.
 */
function preloadNextSong(guildId) {
    const sq = queue.get(guildId);
    if (!sq || !isMixerAlive(sq)) return;

    // ⚠️  Non precaricare se la canzone è in pausa
    // Durante la pausa, il Rust non sta riproducendo e caricamenti extra potrebbero causare snap/problemi
    if (sq.isPaused) {
        console.log('⏭️  [PRELOAD] Canzone in pausa, skip del preload');
        return;
    }

    const nextSong = getNextSong(sq);
    if (!nextSong || !nextSong.url) {
        console.log('⏭️  [PRELOAD] Nessuna canzone successiva da precaricare');
        return;
    }

    const currentSong = getCurrentSong(sq);
    // Non precaricare se next == current (stessa URL)
    if (currentSong && areSameSong(currentSong.url, nextSong.url)) return;

    // Non precaricare se già pronta
    if (sq.nextDeckLoaded === nextSong.url) {
        console.log(`✅ [PRELOAD] Già precaricata: "${sanitizeTitle(nextSong.title)}"`);
        return;
    }

    const nextDeck = (sq.currentDeck || 'A') === 'A' ? 'B' : 'A';

    try {
        // ⚠️  SAFETY: Non precaricare durante U POCO DOPO un crossfade
        // Il flag isCrossfading potrebbe essere false ma il Rust sta ancora facendo il crossfade
        // Controlla il timestamp: se il crossfade è iniziato da meno di CROSSFADE_DURATION_MS, aspetta
        if (sq.isCrossfading || (sq.crossfadeStartTime && Date.now() - sq.crossfadeStartTime < CROSSFADE_DURATION_MS)) {
            if (sq.isCrossfading) {
                console.warn(`⚠️  [PRELOAD] Skip: crossfade in corso (flag=true), aspetto fine crossfade prima del preload`);
            } else {
                const timeElapsed = Date.now() - sq.crossfadeStartTime;
                console.warn(`⚠️  [PRELOAD] Skip: crossfade completato da soli ${timeElapsed}ms (< ${CROSSFADE_DURATION_MS}ms), aspetto ancora`);
            }
            return;
        }

        // ⚠️  Stoppa il deck che NON sarà usato per il preload
        // MA: solo se c'è stato un crossfade recente (entro gli ultimi CROSSFADE_DURATION_MS)
        // Durante il caricamento iniziale, non c'è stato un crossfade, quindi non stoppa i deck
        if (sq.crossfadeStartTime && Date.now() - sq.crossfadeStartTime < CROSSFADE_DURATION_MS * 1.5) {
            const oldDeck = (nextDeck === 'A') ? 'B' : 'A';
            try { sq.mixer.stopDeck(oldDeck); } catch (e) { /* ignora */ }
        }

        // Cattura lo stato della coda PRIMA del preload
        const playIndexBefore = sq.playIndex || 0;
        const songCountBefore = (sq.songs && sq.songs.length) || 0;
        const nextSongUrlBefore = nextSong.url;

        // Non fermare il deck per il preload - il Rust resetterà il buffer al load
        sq.bufferReady = sq.bufferReady || {};
        sq.bufferReady[nextDeck] = false;

        // Carica la canzone (autoplay=false: il deck resta in pausa, pronto per skip/crossfade)
        // SERIALIZZA il comando load attraverso command queue
        const { commandQueue } = require('./CommandQueue');
        commandQueue.enqueue(
            guildId,
            'preload_load',
            () => { sq.mixer.load(nextSong.url, nextDeck, false); },
            { timeout: 8000, retries: 1 }
        ).then(() => {
            // Invalida SOLO se la coda è stata modificata (skip, clear, add songs)
            // NON invalida se la versione è cambiata per motivi indipendenti (buffer ready, etc)
            const playIndexAfter = sq.playIndex || 0;
            const songCountAfter = (sq.songs && sq.songs.length) || 0;
            const nextSongUrlAfter = getNextSong(sq)?.url || null;
            
            if (playIndexBefore !== playIndexAfter || songCountBefore !== songCountAfter || nextSongUrlBefore !== nextSongUrlAfter) {
                console.warn(`⚠️  [PRELOAD] Coda cambiata durante load (playIdx: ${playIndexBefore}→${playIndexAfter}, songs: ${songCountBefore}→${songCountAfter}), preload invalidato`);
                sq.nextDeckLoaded = null;
                sq.nextDeckTarget = null;
                return;
            }
            
            sq.nextDeckLoaded = nextSong.url;
            sq.nextDeckTarget = nextDeck;
            console.log(`📥 [PRELOAD] Deck ${nextDeck}: "${sanitizeTitle(nextSong.title)}"`);
        }).catch(err => {
            console.error(`❌ [PRELOAD] Command queue error: ${err.message}`);
        });

    } catch (e) {
        console.error(`❌ [PRELOAD] Errore: ${e.message}`);
    }
}

/**
 * Gestisce l'evento 'end' dal Rust (traccia terminata naturalmente).
 *
 * Quando il Rust invia l'evento 'end', prova a saltare alla canzone successiva
 * (autoSkip). Se non ce n'è, termina la coda.
 *
 * Note:
 * - Se fade è ON, chi ha iniziato il crossfade? Deve essere stato fatto da:
 *   a) Un evento 'approaching_end' dal Rust (3s prima) che triggera autoSkip
 *   b) Un comando 'schedule_crossfade' inviato a Rust all'inizio della canzone
 *   c) L'utente che preme skip manualmente
 * - Se fade è OFF, lo skip istantaneo avviene qui quando arriva 'end'
 */
async function handleTrackEnd(guildId) {
    const sq = queue.get(guildId);
    if (!sq) return;

    // Pulisci timer preload quando la traccia finisce
    clearAllTimers(guildId);

    // Verifica se uno skip è in corso (evita race condition)
    const SkipManager = require('./SkipManager');
    if (SkipManager.hasSkipInProgress(guildId)) {
        console.log('⏳ [TRACK-END] Skip già in corso, ignoro');
        return;
    }

    // Procedi con auto-skip se c'è una canzone successiva
    if (hasNextSong(sq)) {
        console.log('⏭️  [TRACK-END] Fine naturale, skip automatico');
        await SkipManager.autoSkip(guildId);
    } else {
        console.log('🏁 [TRACK-END] Ultima canzone terminata, fine coda');
        await SkipManager.endQueue(guildId);
    }
}

/**
 * Gestisce l'evento 'deck_changed' dal Rust (solo logging).
 * Lo stato è già aggiornato da SkipManager in modo ottimistico.
 */
function handleDeckChanged(guildId, newDeck) {
    console.log(`🔀 [DECK-CHANGED] Rust: deck=${newDeck}`);
}

// ─── Exports ────────────────────────────────────────────────

module.exports = {
    onSongStart,
    preloadNextSong,
    handleTrackEnd,
    handleDeckChanged,
    clearAllTimers
};
