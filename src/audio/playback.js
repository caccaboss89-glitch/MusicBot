/**
 * Basic playback functions
 * Responsibilities:
 *  - playSong:            starts playback of the current song (songs[playIndex])
 *  - restartCurrentSong:  restarts the current song from the beginning (replay)
 */

import { queue } from '../state/globals.js';
import { getCurrentSong, isValidSong } from '../queue/QueueManager.js';
import { saveQueueState } from '../queue/persistence.js';
import { createCurrentSongEmbed, createDashboardComponents, updateDashboard, updateDashboardToFinished } from '../ui/index.js';
import { joinVoiceChannel, createAudioResource, StreamType, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { safeMixerInvoke } from './mixer-utils.js';
import { PassThrough } from 'stream';
import { call, register, get } from './audio-bridge.js';

// Key factor for pipeline latency:
// low highWaterMark = less audio buffered in pipe = more reactive skips
// 3840 bytes = exactly 1 Discord frame (20ms at 48kHz stereo 16-bit)
const LOW_LATENCY_HWM = 3840 * 2; // 2 frames = 40ms of buffer

/**
 * Creates a low-latency wrapper around the mixer's stdout.
 * Reduces Node.js internal buffer to minimize delay
 * between when Rust switches decks and when Discord hears it.
 */
function createLowLatencyStream(stdout) {
  const passthrough = new PassThrough({ highWaterMark: LOW_LATENCY_HWM });
  stdout.pipe(passthrough);
  return passthrough;
}

/**
 * Cleans up the low-latency stream to prevent resource leak
 */
function cleanupLowLatencyStream(serverQueue) {
  if (serverQueue && serverQueue._llStream) {
    try { serverQueue._llStream.unpipe(); serverQueue._llStream.destroy(); } catch { }
    serverQueue._llStream = null;
  }
}

// Tracks timestamp of last crash per guild (to prevent too-quick restarts)
const lastMixerCrashTime = new Map();
const MIXER_CRASH_COOLDOWN_MS = 1500;

function cleanupPlaybackState(guildId) {
  lastMixerCrashTime.delete(guildId);
}

/**
 * Resumes playback if it was paused (utility to avoid duplication)
 * Used for both replay and skip when music was stopped
 * @param {object} serverQueue
 * @param {string} guildId
 * @param {string} deckToResume - Deck to resume (usually the current deck)
 */
async function resumeIfPaused(serverQueue, guildId, deckToResume) {
  if (!serverQueue.isPaused) return; // Nothing to do if not paused

  serverQueue.isPaused = false;
  serverQueue.pauseStart = null;

  // Resume Discord player
  try { serverQueue.player?.unpause(); } catch { }

  // Resume Rust mixer
  const mixerAlive = serverQueue.mixer?.isProcessAlive?.();
  if (mixerAlive) {
    try {
      safeMixerInvoke(serverQueue, guildId,
        () => serverQueue.mixer.play(deckToResume),
        'resume'
      );
    } catch (e) {
      console.warn('⚠️  [RESUME] Mixer resume error:', e.message);
    }
  }
}

/**
 * Restarts the current song from the beginning (replay)
 */
async function restartCurrentSong(guildId) {
  const serverQueue = queue.get(guildId);
  if (!serverQueue) return false;
  const currentSong = getCurrentSong(serverQueue);
  if (!currentSong || !isValidSong(currentSong)) return false;

  // If mixer dead, full restart
  if (!serverQueue.mixer || serverQueue.mixer.needsRestart()) {
    if (serverQueue.mixer) { serverQueue.mixer.kill(); serverQueue.mixer = null; }
    serverQueue.currentDeckLoaded = null;
    serverQueue.isPaused = false;
    await playSong(guildId);
    return true;
  }

  // Restart current deck from the beginning without reloading
  let currentDeck = serverQueue.currentDeck || 'A';
  if (currentDeck !== 'A' && currentDeck !== 'B') {
    console.warn(`⚠️ [REPLAY] Invalid currentDeck (${currentDeck}), resetting to A`);
    currentDeck = 'A';
    serverQueue.currentDeck = 'A';
  }

  // Download failed (no buffer_ready): replay must reload, not play silence
  if (!serverQueue.bufferReady?.[currentDeck]) {
    console.warn(`⚠️ [REPLAY] Deck ${currentDeck} has no buffered audio, reloading from URL`);
    serverQueue.currentDeckLoaded = null;
    await playSong(guildId);
    return true;
  }

  console.log(`[REPLAY] Restart Deck ${currentDeck} from the beginning`);

  safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.restartDeck(currentDeck));
  serverQueue.songStartTime = Date.now();

  // If the song was paused, resume it
  await resumeIfPaused(serverQueue, guildId, currentDeck);

  // Restart preload/end-monitor timer
  call('onSongStart', guildId);

  call('refreshDashboard', serverQueue, currentSong.requester);
  return true;
}

/**
 * Starts playback of the current song (songs[playIndex])
 * Creates the mixer if necessary, loads the song, and begins playback.
 */
async function playSong(guildId, interaction = null) {
  const serverQueue = queue.get(guildId);
  if (!serverQueue) return;

  // Ensure voice connection
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
    } catch { cleanupLowLatencyStream(serverQueue); return; }
  }

  let song = getCurrentSong(serverQueue);
  if (!song) {
    const lastSong = (serverQueue.history && serverQueue.history.length > 0)
      ? serverQueue.history[serverQueue.history.length - 1]
      : null;
    await updateDashboardToFinished(serverQueue, lastSong);
    serverQueue.currentDeckLoaded = null;
    serverQueue.nextDeckLoaded = null;
    cleanupLowLatencyStream(serverQueue);
    return;
  }

  // Skip failed songs (Opus errors, corrupted stream) without recursion
  const isFailedSong = get('isFailedSong');
  if (isFailedSong) {
    let skipped = false;
    while (isFailedSong(guildId, song.url)) {
      console.warn(`⏭️  [PLAY] Skipping unplayable song: ${song.title}`);
      serverQueue.playIndex = (serverQueue.playIndex || 0) + 1;
      skipped = true;
      if (serverQueue.playIndex >= serverQueue.songs.length) {
        serverQueue.currentDeckLoaded = null;
        cleanupLowLatencyStream(serverQueue);
        await updateDashboardToFinished(serverQueue, song);
        return;
      }
      song = getCurrentSong(serverQueue);
      if (!song) {
        serverQueue.currentDeckLoaded = null;
        cleanupLowLatencyStream(serverQueue);
        return;
      }
    }
    if (skipped) saveQueueState(guildId, serverQueue);
  }

  if (!serverQueue.currentDeckLoaded) {
    // Avoid concurrent mixer startups
    if (serverQueue.mixerStarting) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (!serverQueue.mixerStarting) break;
        if (serverQueue.mixer && serverQueue.mixer.isProcessAlive && serverQueue.mixer.isProcessAlive()) break;
      }
    }

    // Cooldown: if mixer crashed recently, wait
    const lastCrashTime = lastMixerCrashTime.get(guildId) || 0;
    const timeSinceLastCrash = Date.now() - lastCrashTime;
    if (timeSinceLastCrash < MIXER_CRASH_COOLDOWN_MS) {
      const waitTime = MIXER_CRASH_COOLDOWN_MS - timeSinceLastCrash;
      console.warn(`⏳ [PLAY] Mixer crashed recently, waiting ${waitTime}ms...`);
      await new Promise(r => setTimeout(r, waitTime));
    }

    if (!serverQueue.mixer || serverQueue.mixer.needsRestart()) {
      if (serverQueue.mixer) { try { serverQueue.mixer.kill(); } catch { } serverQueue.mixer = null; }
      serverQueue.mixerStarting = true;
      try {
        const AudioMixerControllerModule = await import('./AudioMixerController.js');
        serverQueue.mixer = new AudioMixerControllerModule.default(
          guildId,
          (log) => call('handleRustEvent', guildId, log),
          (deck) => call('handleBufferReady', guildId, deck),
          (reason) => call('handleMixerCrash', guildId, reason)
        );
        serverQueue.mixer.start();
        serverQueue.mixerGeneration = serverQueue.mixer.generation;

        // Wait for stdout to be available
        let stdout = null;
        for (let i = 0; i < 30; i++) {
          try { stdout = serverQueue.mixer && serverQueue.mixer.getStdout && serverQueue.mixer.getStdout(); } catch { stdout = null; }
          if (stdout && serverQueue.mixer.isProcessAlive && serverQueue.mixer.isProcessAlive()) break;
          if (!serverQueue.mixer || serverQueue.mixer.needsRestart()) break;
          await new Promise(r => setTimeout(r, 100));
        }
        stdout = serverQueue.mixer && serverQueue.mixer.getStdout ? serverQueue.mixer.getStdout() : null;
        if (!stdout) {
          console.error('❌ [PLAY] Mixer stdout not available, aborting');
          try { serverQueue.mixer.kill(); } catch { } serverQueue.mixer = null;
          serverQueue.mixerStarting = false;
          return;
        }

        await new Promise(r => setTimeout(r, 200));
        if (!serverQueue.mixer || !serverQueue.mixer.isProcessAlive()) {
          console.error('❌ [PLAY] Mixer dead before first command');
          try { serverQueue.mixer.kill(); } catch { } serverQueue.mixer = null;
          serverQueue.mixerStarting = false;
          return;
        }

        // ALWAYS disable proactive crossfade in Rust – Node.js handles everything
        safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.setProactiveCrossfade(false));

        // Sync loop mode with Rust for auto-gapless
        safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.setLoop(!!serverQueue.loopEnabled));

        // Clean up old stream to prevent resource leak
        cleanupLowLatencyStream(serverQueue);
        const llStream = createLowLatencyStream(stdout);
        serverQueue._llStream = llStream; // Save reference for cleanup
        const resource = createAudioResource(llStream, { inputType: StreamType.Raw, inlineVolume: false });
        serverQueue.player.removeAllListeners('error');
        serverQueue.player.on('error', e => console.error(`AudioPlayer Error: ${e.message}`));
        serverQueue.player.play(resource);

        serverQueue.crashRecoveryAttempts = 0;
        if (serverQueue.connection) {
          try { serverQueue.connection.subscribe(serverQueue.player); } catch (e) { console.error('Failed to re-subscribe connection:', e); }
        }
      } finally {
        serverQueue.mixerStarting = false;
      }
    } else {
      // Existing and alive mixer: ensure stdout
      try {
        const stdout = serverQueue.mixer.getStdout ? serverQueue.mixer.getStdout() : null;
        if (!stdout) {
          console.error('❌ [PLAY] Existing mixer has no stdout');
          return;
        }
        // Clean up old stream to prevent resource leak
        cleanupLowLatencyStream(serverQueue);
        const llStream = createLowLatencyStream(stdout);
        serverQueue._llStream = llStream;
        const resource = createAudioResource(llStream, { inputType: StreamType.Raw, inlineVolume: false });
        serverQueue.player.removeAllListeners('error');
        serverQueue.player.on('error', e => console.error(`AudioPlayer Error: ${e.message}`));
        serverQueue.player.play(resource);
        serverQueue.crashRecoveryAttempts = 0;
        if (serverQueue.connection) {
          try { serverQueue.connection.subscribe(serverQueue.player); } catch (e) { console.error('Failed to re-subscribe connection:', e); }
        }
      } catch (e) {
        console.error('❌ [PLAY] Error attaching to existing mixer stdout', e);
        cleanupLowLatencyStream(serverQueue);
        return;
      }
    }

    // Load and start song on deck A
    const deck = 'A';
    serverQueue.songStartTime = null;
    serverQueue.nextDeckLoaded = null;
    serverQueue.bufferReady = serverQueue.bufferReady || {};
    serverQueue.bufferReady[deck] = false;

    safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.load(song.url, deck));
    // IMPORTANT: Delay to allow download thread to send first audio chunk
    // Without this delay, play command executes before data arrives, causing silence.
    // In replay (restartDeck) it's not needed because data is already buffered in full_samples.
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!serverQueue.mixer) return;

    safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.play(deck));
    serverQueue.currentDeck = deck;
    serverQueue.currentDeckLoaded = song.url;
    serverQueue.nextDeckTarget = null;
    serverQueue.songStartTime = Date.now();

    // ── Binding deck → song (source of truth for sync) ──
    const { bindDeckSong } = await import('../queue/QueueManager.js');
    bindDeckSong(serverQueue, deck, serverQueue.playIndex || 0, song.url);
    bindDeckSong(serverQueue, deck === 'A' ? 'B' : 'A', null, null);

    // Update UI
    const embed = createCurrentSongEmbed(serverQueue);
    const userId = interaction ? interaction.user.id : (song.requester || null);
    const components = createDashboardComponents(serverQueue, userId);
    await updateDashboard(serverQueue, embed, components);

    // Start preload and end-monitor cycle
    // (the play is credited to the statistics once the engine confirms real audio)
    call('onSongStart', guildId);
  }
}

function recordMixerCrashTime(guildId) {
  lastMixerCrashTime.set(guildId, Date.now());
}

/**
 * Handles pause/resume toggle atomically with state machine
 * @param {string} guildId
 * @param {object} serverQueue
 * @param {object} deps - Dependencies (connectToVoice)
 * @returns {Promise<{success: boolean, action: 'play'|'pause'|'resume'|'error', error?: string}>}
 */
async function togglePauseResume(guildId, serverQueue, deps = {}) {
  try {
    const { stateVersionManager } = await import('../state/StateVersion.js');
    const stateVersion = stateVersionManager.get(guildId);

    // STATE MACHINE: Determines current state and correct action

    // CASE 1: Session restored without mixer → start playback
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

    // CASE 2: No mixer/voice connection or empty Queue → start fresh
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

    // CASE 3: Empty queue → error
    if (!serverQueue.songs || serverQueue.songs.length === 0) {
      return { success: false, action: 'error', error: 'Queue is empty' };
    }

    // CASE 4: Normal pause/resume toggle
    const previousPauseState = serverQueue.isPaused;
    serverQueue.isPaused = !serverQueue.isPaused;

    if (serverQueue.isPaused) {
      // ── PAUSE PATH ──
      // Record pause start to calculate paused time on resume
      try { serverQueue.pauseStart = Date.now(); } catch { }

      // Pause Discord player
      try { serverQueue.player?.pause(); } catch { }

      // Pause Rust mixer (ONLY if alive)
      const mixerAlive = serverQueue.mixer?.isProcessAlive?.();
      if (mixerAlive) {
        try {
          await new Promise((resolve) => {
            const result = safeMixerInvoke(serverQueue, guildId,
              () => serverQueue.mixer.pause(),
              'pause'
            );
            if (!result.success) {
              console.error('⚠️  [PAUSE] Mixer pause failed:', result.error?.message);
            }
            resolve();
          });
        } catch (e) {
          console.error('❌ [PAUSE] Mixer pause error:', e);
        }
      } else {
        console.warn('⚠️  [PAUSE] Mixer not alive, skipping mixer pause');
        try { call('handleMixerCrash', guildId, 'mixer_dead_during_pause'); } catch { }
      }

      // ── STATS: stop listening timer during pause ──
      try { (await import('../database/stats.js')).default.stopAllListeners(guildId); } catch { }

      stateVersion.incrementVersion('pause_action', { action: 'pause', previousState: previousPauseState });
      return { success: true, action: 'pause' };

    } else {
      // ── RESUME PATH ──
      // Calculate how much time we spent paused to sync timer
      const pausedFor = serverQueue.pauseStart ? (Date.now() - serverQueue.pauseStart) : 0;

      // Update songStartTime to compensate for paused time
      try {
        if (serverQueue.songStartTime) {
          serverQueue.songStartTime += pausedFor;
        } else {
          serverQueue.songStartTime = Date.now();
        }
        serverQueue.pauseStart = null;
      } catch { }

      // Unpause Discord player
      try { serverQueue.player?.unpause(); } catch { }

      // Unpause Rust mixer (ONLY if alive)
      const mixerAlive = serverQueue.mixer?.isProcessAlive?.();
      if (mixerAlive) {
        try {
          await new Promise((resolve) => {
            const currentDeck = serverQueue.currentDeck || 'A';
            const result = safeMixerInvoke(serverQueue, guildId,
              () => serverQueue.mixer.play(currentDeck),
              'resume'
            );
            if (!result.success) {
              console.error('⚠️  [RESUME] Mixer play failed:', result.error?.message);
            }
            resolve();
          });
        } catch (e) {
          console.error('❌ [RESUME] Mixer resume error:', e);
        }
      } else {
        console.warn('⚠️  [RESUME] Mixer not alive, skipping mixer play');
        try { call('handleMixerCrash', guildId, 'mixer_dead_during_resume'); } catch { }
      }

      // Restart preload/end-monitor timer
      try { call('updatePreloadAfterQueueChange', guildId); } catch { }

      // ── STATS: resume listening timer after resume ──
      try { (await import('../database/stats.js')).default.startAllListeners(guildId, serverQueue.voiceChannel); } catch { }

      stateVersion.incrementVersion('pause_action', { action: 'resume', pausedForMs: pausedFor });
      return { success: true, action: 'resume' };
    }

  } catch (e) {
    console.error('❌ [PAUSE-TOGGLE] Fatal error:', e);
    return { success: false, action: 'error', error: e.message };
  }
}

// ─── Bridge registrations ───────────────────────────────────

register('playSong', playSong);
register('restartCurrentSong', restartCurrentSong);
register('resumeIfPaused', resumeIfPaused);
register('recordMixerCrashTime', recordMixerCrashTime);

export { playSong, restartCurrentSong, togglePauseResume, recordMixerCrashTime, resumeIfPaused, cleanupPlaybackState };
