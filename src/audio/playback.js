/**
 * playback.js - Funzioni base di riproduzione
 * 
 * Responsabilità:
 *  - playSong:            avvia la riproduzione della canzone corrente (songs[playIndex])
 *  - restartCurrentSong:  riavvia la canzone corrente dall'inizio (replay)
 * 
 * Le funzioni di skip (smartSkip, performManualSkip) sono state rimosse in v3.
 * Tutta la logica di skip è centralizzata in SkipManager.
 */

const { queue } = require('../state/globals');
const { getCurrentSong, isValidSong } = require('../queue/QueueManager');
const { saveQueueState } = require('../queue/persistence');
const { createCurrentSongEmbed, createDashboardComponents, updateDashboard } = require('../ui');
const { sanitizeTitle } = require('../utils/sanitize');
const { joinVoiceChannel, createAudioResource, StreamType, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { safeMixerInvoke } = require('./mixer-utils');
const { PassThrough } = require('stream');

// Fattore chiave per la latenza di pipeline:
// highWaterMark basso = meno audio bufferizzato nel pipe = skip più reattivi
// 3840 bytes = esattamente 1 frame Discord (20ms a 48kHz stereo 16-bit)
const LOW_LATENCY_HWM = 3840 * 2; // 2 frames = 40ms di buffer

/**
 * Crea un wrapper a bassa latenza attorno allo stdout del mixer.
 * Riduce il buffer interno di Node.js per minimizzare il delay
 * tra il momento in cui Rust cambia deck e quando Discord lo sente.
 */
function createLowLatencyStream(stdout) {
    const passthrough = new PassThrough({ highWaterMark: LOW_LATENCY_HWM });
    stdout.pipe(passthrough);
    return passthrough;
}

// Traccia timestamp di ultimi crash per guild (per evitare restart troppo veloci)
const lastMixerCrashTime = new Map();
const MIXER_CRASH_COOLDOWN_MS = 1500;

/**
 * Riprende la riproduzione se era in pausa (utility per evitare duplicazione)
 * Usato sia per replay che per skip quando la musica era ferma
 * @param {object} serverQueue
 * @param {string} guildId
 * @param {string} deckToResume - Deck da riprendere (di solito il current deck)
 */
async function resumeIfPaused(serverQueue, guildId, deckToResume) {
    if (!serverQueue.isPaused) return; // Niente da fare se non era in pausa
    
    serverQueue.isPaused = false;
    serverQueue.pauseStart = null;
    
    // Riprendi il player Discord
    try { serverQueue.player?.unpause(); } catch(e){}

    // Riprendi il mixer Rust
    const mixerAlive = serverQueue.mixer?.isProcessAlive?.();
    if (mixerAlive) {
        try {
            const { safeMixerInvoke: safeMixerInvokeResume } = require('./mixer-utils');
            safeMixerInvokeResume(serverQueue, guildId, 
                () => serverQueue.mixer.play(deckToResume), 
                'resume'
            );
        } catch(e) {
            console.warn(`⚠️  [RESUME] Errore resume del mixer:`, e.message);
        }
    }
}

/**
 * Riavvia la canzone corrente dall'inizio (replay)
 */
async function restartCurrentSong(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return false;
    const currentSong = getCurrentSong(serverQueue);
    if (!currentSong || !isValidSong(currentSong)) return false;

    // Se mixer morto, restart completo
    if (!serverQueue.mixer || serverQueue.mixer.needsRestart()) {
        if (serverQueue.mixer) { serverQueue.mixer.kill(); serverQueue.mixer = null; }
        serverQueue.currentDeckLoaded = null;
        serverQueue.isPaused = false;
        await playSong(guildId);
        return true;
    }

    // Riavvia il deck corrente dall'inizio senza ri-scaricare
    const currentDeck = serverQueue.currentDeck || 'A';
    console.log(`[REPLAY] Restart Deck ${currentDeck} dall'inizio`);

    safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.restartDeck(currentDeck));
    serverQueue.songStartTime = Date.now();

    // ── STATS: canzone avviata (replay/restart) ──
    try { require('../database/stats').incrementSongsStarted(); } catch (e) {}

    // Se la canzone era in pausa, riprendila
    await resumeIfPaused(serverQueue, guildId, currentDeck);

    // Riavvia timer preload/monitoraggio fine
    const PlaybackEngine = require('./PlaybackEngine');
    PlaybackEngine.onSongStart(guildId);

    await require('./index').refreshDashboard(serverQueue, currentSong.requester);
    return true;
}

/**
 * Avvia la riproduzione della canzone corrente (songs[playIndex])
 * Crea il mixer se necessario, carica la canzone, e inizia a riprodurre.
 */
async function playSong(guildId, interaction = null) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return;

    // Assicura connessione vocale
    if (!serverQueue.connection && serverQueue.voiceChannel && !interaction) {
        try {
            serverQueue.connection = joinVoiceChannel({
                channelId: serverQueue.voiceChannel.id,
                guildId: guildId,
                adapterCreator: serverQueue.voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false
            });
            serverQueue.connection.subscribe(serverQueue.player);
            await entersState(serverQueue.connection, VoiceConnectionStatus.Ready, 10000);
        } catch (e) { return; }
    }

    const song = getCurrentSong(serverQueue);
    if (!song) {
        const lastSong = (serverQueue.history && serverQueue.history.length > 0)
            ? serverQueue.history[serverQueue.history.length - 1]
            : null;
        require('../ui').updateDashboardToFinished(serverQueue, lastSong);
        serverQueue.currentDeckLoaded = null;
        serverQueue.nextDeckLoaded = null;
        return;
    }

    // Controlla se questa canzone è già fallita (Opus errors, corrupted stream)
    const audio = require('./index');
    if (audio.isFailedSong && audio.isFailedSong(guildId, song.url)) {
        console.warn(`⏭️  [PLAY] Saltando canzone non giocabile: ${song.title}`);
        // Sposta al prossimo indice
        serverQueue.playIndex = (serverQueue.playIndex || 0) + 1;
        if (serverQueue.playIndex >= serverQueue.songs.length) {
            serverQueue.currentDeckLoaded = null;
            require('../ui').updateDashboardToFinished(serverQueue, song);
            return;
        }
        saveQueueState(guildId, serverQueue);
        await playSong(guildId, interaction);
        return;
    }

    if (!serverQueue.currentDeckLoaded) {
        // Evita avvii concorrenti del mixer
        if (serverQueue.mixerStarting) {
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setImmediate(r));
                if (serverQueue.mixer && serverQueue.mixer.isProcessAlive && serverQueue.mixer.isProcessAlive()) break;
            }
        }

        // Cooldown: se il mixer è crashato di recente, aspetta
        const lastCrashTime = lastMixerCrashTime.get(guildId) || 0;
        const timeSinceLastCrash = Date.now() - lastCrashTime;
        if (timeSinceLastCrash < MIXER_CRASH_COOLDOWN_MS) {
            const waitTime = MIXER_CRASH_COOLDOWN_MS - timeSinceLastCrash;
            console.warn(`⏳ [PLAY] Mixer crashato di recente, aspetto ${waitTime}ms...`);
            await new Promise(r => setTimeout(r, waitTime));
        }

        if (!serverQueue.mixer || serverQueue.mixer.needsRestart()) {
            if (serverQueue.mixer) { try { serverQueue.mixer.kill(); } catch(e){} serverQueue.mixer = null; }
            serverQueue.mixerStarting = true;
            try {
                serverQueue.mixer = new (require('./AudioMixerController'))(
                    guildId,
                    (log) => require('./index').handleRustEvent(guildId, log),
                    (deck) => require('./index').handleBufferReady(guildId, deck),
                    (reason) => require('./index').handleMixerCrash(guildId, reason)
                );
                serverQueue.mixer.start();
                serverQueue.mixerGeneration = serverQueue.mixer.generation;

                // Attendi che stdout sia disponibile
                let stdout = null;
                for (let i = 0; i < 30; i++) {
                    try { stdout = serverQueue.mixer && serverQueue.mixer.getStdout && serverQueue.mixer.getStdout(); } catch(e) { stdout = null; }
                    if (stdout && serverQueue.mixer.isProcessAlive && serverQueue.mixer.isProcessAlive()) break;
                    if (!serverQueue.mixer || serverQueue.mixer.needsRestart()) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                stdout = serverQueue.mixer && serverQueue.mixer.getStdout ? serverQueue.mixer.getStdout() : null;
                if (!stdout) {
                    console.error('❌ [PLAY] Mixer stdout non disponibile, aborting');
                    try { serverQueue.mixer.kill(); } catch(e){} serverQueue.mixer = null;
                    serverQueue.mixerStarting = false;
                    return;
                }

                await new Promise(r => setTimeout(r, 200));
                if (!serverQueue.mixer || !serverQueue.mixer.isProcessAlive()) {
                    console.error('❌ [PLAY] Mixer morto prima del primo comando');
                    try { serverQueue.mixer.kill(); } catch(e){} serverQueue.mixer = null;
                    serverQueue.mixerStarting = false;
                    return;
                }

                // SEMPRE disattivare proactive crossfade nel Rust – Node.js gestisce tutto
                safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.setProactiveCrossfade(false));

                // Sincronizza loop mode con Rust per auto-gapless
                safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.setLoop(!!serverQueue.loopEnabled));

                const llStream = createLowLatencyStream(stdout);
                serverQueue._llStream = llStream; // Salva riferimento per cleanup
                const resource = createAudioResource(llStream, { inputType: StreamType.Raw, inlineVolume: false });
                serverQueue.player.removeAllListeners();
                serverQueue.player.on('error', e => console.error(`AudioPlayer Error: ${e.message}`));
                serverQueue.player.play(resource);

                serverQueue.crashRecoveryAttempts = 0;
                if (serverQueue.connection) {
                    try { serverQueue.connection.subscribe(serverQueue.player); } catch(e) { console.error('Failed to re-subscribe connection:', e); }
                }
            } finally {
                serverQueue.mixerStarting = false;
            }
        } else {
            // Mixer esistente e vivo: assicura stdout
            try {
                const stdout = serverQueue.mixer.getStdout ? serverQueue.mixer.getStdout() : null;
                if (!stdout) {
                    console.error('❌ [PLAY] Existing mixer has no stdout');
                    return;
                }
                const llStream = createLowLatencyStream(stdout);
                serverQueue._llStream = llStream;
                const resource = createAudioResource(llStream, { inputType: StreamType.Raw, inlineVolume: false });
                serverQueue.player.removeAllListeners();
                serverQueue.player.on('error', e => console.error(`AudioPlayer Error: ${e.message}`));
                serverQueue.player.play(resource);
                serverQueue.crashRecoveryAttempts = 0;
                if (serverQueue.connection) {
                    try { serverQueue.connection.subscribe(serverQueue.player); } catch(e) { console.error('Failed to re-subscribe connection:', e); }
                }
            } catch (e) { console.error('❌ [PLAY] Error attaching to existing mixer stdout', e); return; }
        }

        // Carica e avvia la canzone su deck A
        const deck = 'A';
        serverQueue.songStartTime = null;
        serverQueue.nextDeckLoaded = null;
        serverQueue.bufferReady = serverQueue.bufferReady || {};
        serverQueue.bufferReady[deck] = false;

        safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.load(song.url, deck));
        // IMPORTANTE: Delay per permettere al thread di download di inviare il primo chunk di audio
        // Senza questo delay, il comando play viene eseguito prima che i dati arrivino, causando silenzio.
        // Nel replay (restartDeck) non serve perché i dati sono già bufferizzati in full_samples.
        await new Promise(resolve => setTimeout(resolve, 150));
        if (!serverQueue.mixer) return;

        safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.play(deck));
        serverQueue.currentDeck = deck;
        serverQueue.currentDeckLoaded = song.url;
        serverQueue.nextDeckTarget = null;
        serverQueue.songStartTime = Date.now();

        // Aggiorna UI
        const embed = createCurrentSongEmbed(serverQueue);
        const userId = interaction ? interaction.user.id : (song.requester || null);
        const components = createDashboardComponents(serverQueue, userId);
        await updateDashboard(serverQueue, embed, components);

        // Avvia il ciclo di preload e monitoraggio fine
        const PlaybackEngine = require('./PlaybackEngine');
        PlaybackEngine.onSongStart(guildId);

        // ── STATS: canzone avviata + timer ascolto ──
        try {
            const stats = require('../database/stats');
            stats.incrementSongsStarted();
            stats.startAllListeners(guildId, serverQueue.voiceChannel);
        } catch (e) { console.warn('⚠️ [STATS] Errore in playSong:', e.message); }
    }
}

function recordMixerCrashTime(guildId) {
    lastMixerCrashTime.set(guildId, Date.now());
}

/**
 * Gestisce il toggle pause/resume in modo atomico con state machine
 * @param {string} guildId
 * @param {object} serverQueue
 * @param {object} deps - Dipendenze (connectToVoice)
 * @returns {Promise<{success: boolean, action: 'play'|'pause'|'resume'|'error', error?: string}>}
 */
async function togglePauseResume(guildId, serverQueue, deps = {}) {
    try {
        const { stateVersionManager } = require('../state/StateVersion');
        const stateVersion = stateVersionManager.get(guildId);

        // STATE MACHINE: Determina lo stato attuale e l'azione corretta
        
        // CASO 1: Sessione ripristinata senza mixer → avvia riproduzione
        if (serverQueue.sessionRestored && !serverQueue.currentDeckLoaded && serverQueue.songs?.length > 0) {
            serverQueue.sessionRestored = false;
            serverQueue.isPaused = false;
            stateVersion.incrementVersion('pause_action', { action: 'play_from_restore' });

            if (deps.connectToVoice) {
                const connected = await deps.connectToVoice(serverQueue, null);
                if (connected) {
                    await playSong(guildId);
                    return { success: true, action: 'play' };
                }
            }
            return { success: false, action: 'error', error: 'Failed to connect to voice' };
        }

        // CASO 2: Nessun mixer/connessione vocale oppure Queue vuota → avvia da capo
        if ((!serverQueue.mixer || !serverQueue.connection) && serverQueue.songs?.length > 0) {
            serverQueue.isPaused = false;
            stateVersion.incrementVersion('pause_action', { action: 'play_from_dead_mixer' });

            if (deps.connectToVoice) {
                const connected = await deps.connectToVoice(serverQueue, null);
                if (connected) {
                    await playSong(guildId);
                    return { success: true, action: 'play' };
                }
            }
            return { success: false, action: 'error', error: 'Failed to connect to voice' };
        }

        // CASO 3: Coda vuota → errore
        if (!serverQueue.songs || serverQueue.songs.length === 0) {
            return { success: false, action: 'error', error: 'Queue is empty' };
        }

        // CASO 4: Toggle normale pause/resume
        const previousPauseState = serverQueue.isPaused;
        serverQueue.isPaused = !serverQueue.isPaused;

        if (serverQueue.isPaused) {
            // ── PAUSE PATH ──
            // Record pause start per calcolare il tiempo paused in resume
            try { serverQueue.pauseStart = Date.now(); } catch(e){}
            
            // Pausa il player Discord
            try { serverQueue.player?.pause(); } catch(e){}

            // Pausa il mixer Rust (SOLO se vivo)
            const mixerAlive = serverQueue.mixer?.isProcessAlive?.();
            if (mixerAlive) {
                try {
                    await new Promise((resolve) => {
                        const { safeMixerInvoke } = require('./mixer-utils');
                        const result = safeMixerInvoke(serverQueue, guildId, 
                            () => serverQueue.mixer.pause(), 
                            'pause'
                        );
                        if (!result.success) {
                            console.error(`⚠️  [PAUSE] Mixer pause failed:`, result.error?.message);
                        }
                        resolve();
                    });
                } catch(e) { 
                    console.error(`❌ [PAUSE] Errore pausa del mixer:`, e);
                }
            } else {
                console.warn(`⚠️  [PAUSE] Mixer non vivo, skip mixer pause`);
                try { require('../audio').handleMixerCrash(guildId, 'mixer_dead_during_pause'); } catch(e){}
            }

            // ── STATS: ferma timer ascolto durante pausa ──
            try { require('../database/stats').stopAllListeners(guildId); } catch (e) {}

            stateVersion.incrementVersion('pause_action', { action: 'pause', previousState: previousPauseState });
            return { success: true, action: 'pause' };

        } else {
            // ── RESUME PATH ──
            // Calcola quanto tempo abbiamo passato in pausa per sincronizzare il timer
            const pausedFor = serverQueue.pauseStart ? (Date.now() - serverQueue.pauseStart) : 0;
            
            // Aggiorna il songStartTime per compensare il tempo in pausa
            try {
                if (serverQueue.songStartTime) {
                    serverQueue.songStartTime += pausedFor;
                } else {
                    serverQueue.songStartTime = Date.now();
                }
                serverQueue.pauseStart = null;
            } catch(e) {}

            // Unpausa il player Discord
            try { serverQueue.player?.unpause(); } catch(e){}

            // Unpausa il mixer Rust (SOLO se vivo)
            const mixerAlive = serverQueue.mixer?.isProcessAlive?.();
            if (mixerAlive) {
                try {
                    await new Promise((resolve) => {
                        const { safeMixerInvoke } = require('./mixer-utils');
                        const currentDeck = serverQueue.currentDeck || 'A';
                        const result = safeMixerInvoke(serverQueue, guildId, 
                            () => serverQueue.mixer.play(currentDeck), 
                            'resume'
                        );
                        if (!result.success) {
                            console.error(`⚠️  [RESUME] Mixer play failed:`, result.error?.message);
                        }
                        resolve();
                    });
                } catch(e) { 
                    console.error(`❌ [RESUME] Errore resume del mixer:`, e);
                }
            } else {
                console.warn(`⚠️  [RESUME] Mixer non vivo, skip mixer play`);
                try { require('../audio').handleMixerCrash(guildId, 'mixer_dead_during_resume'); } catch(e){}
            }

            // Riavvia il timer di preload/monitoraggio
            try { require('../audio').preloadNextSongs(guildId); } catch(e){}

            // ── STATS: riprendi timer ascolto dopo resume ──
            try { require('../database/stats').startAllListeners(guildId, serverQueue.voiceChannel); } catch (e) {}

            stateVersion.incrementVersion('pause_action', { action: 'resume', pausedForMs: pausedFor });
            return { success: true, action: 'resume' };
        }

    } catch (e) {
        console.error(`❌ [PAUSE-TOGGLE] Errore fatale:`, e);
        return { success: false, action: 'error', error: e.message };
    }
}

module.exports = { playSong, restartCurrentSong, togglePauseResume, recordMixerCrashTime, resumeIfPaused };
