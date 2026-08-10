/**
 * Basic playback functions
 * Responsibilities:
 *  - playSong:            starts playback of the current song (songs[playIndex])
 *  - restartCurrentSong:  restarts the current song from the beginning (replay)
 *  - togglePauseResume:   pause/resume state machine
 */

import { joinVoiceChannel, createAudioResource, StreamType, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { PassThrough } from 'stream';
import { queue } from '../state/globals.js';
import { stateVersionManager } from '../state/StateVersion.js';
import { getCurrentSong, isValidSong, bindDeckSong } from '../queue/QueueManager.js';
import { saveQueueState } from '../queue/persistence.js';
import { createCurrentSongEmbed, createDashboardComponents, updateDashboard, updateDashboardToFinished, refreshDashboard } from '../ui/index.js';
import { safeMixerInvoke } from './mixer-utils.js';
import AudioMixerController from './AudioMixerController.js';
import { onSongStart, updatePreloadAfterQueueChange } from './PlaybackEngine.js';
import { handleRustEvent, handleBufferReady, isFailedSong } from './rust-events.js';
import { handleMixerCrash, getMixerCrashCooldownMs } from './recovery.js';
import { stopAllListeners, startAllListeners } from '../database/stats.js';

// Key factor for pipeline latency:
// low highWaterMark = less audio buffered in pipe = more reactive skips
// 3840 bytes = exactly 1 Discord frame (20ms at 48kHz stereo 16-bit)
const LOW_LATENCY_HWM = 3840 * 2; // 2 frames = 40ms of buffer

// Wait for the first audio chunk to reach the deck before hitting play
const FIRST_CHUNK_DELAY_MS = 150;

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
    try { serverQueue._llStream.unpipe(); serverQueue._llStream.destroy(); } catch { /* already destroyed */ }
    serverQueue._llStream = null;
  }
}

/**
 * Pipes the mixer output into the Discord player and subscribes the connection.
 * Shared by both entry paths (freshly started mixer and already running mixer).
 * @param {object} serverQueue
 * @param {import('stream').Readable} stdout - Mixer stdout
 */
function attachMixerOutput(serverQueue, stdout) {
  // Clean up the old stream first to prevent a pipe/fd leak
  cleanupLowLatencyStream(serverQueue);
  serverQueue._llStream = createLowLatencyStream(stdout);

  const resource = createAudioResource(serverQueue._llStream, { inputType: StreamType.Raw, inlineVolume: false });
  serverQueue.player.removeAllListeners('error');
  serverQueue.player.on('error', e => console.error(`AudioPlayer Error: ${e.message}`));
  serverQueue.player.play(resource);

  serverQueue.crashRecoveryAttempts = 0;
  if (serverQueue.connection) {
    try { serverQueue.connection.subscribe(serverQueue.player); } catch (e) {
      console.error('Failed to re-subscribe connection:', e);
    }
  }
}

/**
 * Resumes playback if it was paused (utility to avoid duplication)
 * Used for both replay and skip when music was stopped
 * @param {object} serverQueue
 * @param {string} guildId
 * @param {string} deckToResume - Deck to resume (usually the current deck)
 */
function resumeIfPaused(serverQueue, guildId, deckToResume) {
  if (!serverQueue.isPaused) return; // Nothing to do if not paused

  serverQueue.isPaused = false;
  serverQueue.pauseStart = null;

  // Resume Discord player
  try { serverQueue.player?.unpause(); } catch { /* player may be detached */ }

  // Resume Rust mixer
  if (serverQueue.mixer?.isProcessAlive?.()) {
    safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.play(deckToResume), 'resume');
  }
}

/**
 * Restarts the current song from the beginning (replay)
 * @param {string} guildId
 * @returns {Promise<boolean>}
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

  safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.restartDeck(currentDeck), 'replay');
  serverQueue.songStartTime = Date.now();

  // If the song was paused, resume it
  resumeIfPaused(serverQueue, guildId, currentDeck);

  // Restart preload / statistics fallback timers
  onSongStart(guildId);

  await refreshDashboard(serverQueue);
  return true;
}

/**
 * Advances playIndex past songs blacklisted as unplayable.
 * @param {object} serverQueue
 * @param {string} guildId
 * @returns {object|null} The first playable song, or null if the queue ran out
 */
function skipBlacklistedSongs(serverQueue, guildId) {
  let song = getCurrentSong(serverQueue);
  let skipped = false;

  while (song && isFailedSong(guildId, song.url)) {
    console.warn(`⏭️  [PLAY] Skipping unplayable song: ${song.title}`);
    serverQueue.playIndex = (serverQueue.playIndex || 0) + 1;
    skipped = true;
    song = getCurrentSong(serverQueue);
  }

  if (skipped) saveQueueState(guildId, serverQueue);
  return song;
}

/**
 * Starts (or restarts) the Rust mixer and returns its stdout.
 * @param {object} serverQueue
 * @param {string} guildId
 * @returns {Promise<import('stream').Readable|null>} stdout, or null if startup failed
 */
async function startMixer(serverQueue, guildId) {
  serverQueue.mixerStarting = true;
  try {
    serverQueue.mixer = new AudioMixerController(
      guildId,
      (log) => handleRustEvent(guildId, log),
      (deck) => handleBufferReady(guildId, deck),
      (reason) => handleMixerCrash(guildId, reason)
    );
    serverQueue.mixer.start();
    serverQueue.mixerGeneration = serverQueue.mixer.generation;

    // Wait for stdout to become available
    let stdout = null;
    for (let i = 0; i < 30; i++) {
      stdout = serverQueue.mixer.getStdout();
      if (stdout) break;
      if (serverQueue.mixer.needsRestart()) break;
      await new Promise(r => setTimeout(r, 100));
    }

    if (!stdout) {
      console.error('❌ [PLAY] Mixer stdout not available, aborting');
      serverQueue.mixer.kill();
      serverQueue.mixer = null;
      return null;
    }

    await new Promise(r => setTimeout(r, 200));
    if (!serverQueue.mixer || !serverQueue.mixer.isProcessAlive()) {
      console.error('❌ [PLAY] Mixer dead before first command');
      if (serverQueue.mixer) { serverQueue.mixer.kill(); serverQueue.mixer = null; }
      return null;
    }

    // ALWAYS disable proactive crossfade in Rust – Node.js handles everything
    safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.setProactiveCrossfade(false), 'init');
    // Sync loop mode with Rust for auto-gapless
    safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.setLoop(!!serverQueue.loopEnabled), 'init');

    return stdout;
  } finally {
    serverQueue.mixerStarting = false;
  }
}

/**
 * Starts playback of the current song (songs[playIndex])
 * Creates the mixer if necessary, loads the song, and begins playback.
 * @param {string} guildId
 * @param {object|null} [interaction] - Interaction that triggered playback, if any
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
    } catch (e) {
      console.error('❌ [PLAY] Unable to join the voice channel:', e.message);
      cleanupLowLatencyStream(serverQueue);
      return;
    }
  }

  if (!getCurrentSong(serverQueue)) {
    const lastSong = (serverQueue.history && serverQueue.history.length > 0)
      ? serverQueue.history[serverQueue.history.length - 1]
      : null;
    // Clear the deck state first: the dashboard reads it to decide it must
    // render the "queue finished" layout.
    serverQueue.currentDeckLoaded = null;
    serverQueue.nextDeckLoaded = null;
    cleanupLowLatencyStream(serverQueue);
    await updateDashboardToFinished(serverQueue, lastSong);
    return;
  }

  // Skip songs blacklisted after repeated stream errors
  const previousSong = getCurrentSong(serverQueue);
  const song = skipBlacklistedSongs(serverQueue, guildId);
  if (!song) {
    serverQueue.currentDeckLoaded = null;
    cleanupLowLatencyStream(serverQueue);
    await updateDashboardToFinished(serverQueue, previousSong);
    return;
  }

  // Already playing: nothing to start
  if (serverQueue.currentDeckLoaded) return;

  // Avoid concurrent mixer startups
  if (serverQueue.mixerStarting) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (!serverQueue.mixerStarting) break;
    }
  }

  // Cooldown: if the mixer crashed recently, wait before starting a new one
  const cooldownLeft = getMixerCrashCooldownMs(guildId);
  if (cooldownLeft > 0) {
    console.warn(`⏳ [PLAY] Mixer crashed recently, waiting ${cooldownLeft}ms...`);
    await new Promise(r => setTimeout(r, cooldownLeft));
  }

  if (!serverQueue.mixer || serverQueue.mixer.needsRestart()) {
    if (serverQueue.mixer) {
      try { serverQueue.mixer.kill(); } catch { /* already dead */ }
      serverQueue.mixer = null;
    }
    const stdout = await startMixer(serverQueue, guildId);
    if (!stdout) return;
    attachMixerOutput(serverQueue, stdout);
  } else {
    const stdout = serverQueue.mixer.getStdout();
    if (!stdout) {
      console.error('❌ [PLAY] Existing mixer has no stdout');
      return;
    }
    attachMixerOutput(serverQueue, stdout);
  }

  // Load and start the song on deck A
  const deck = 'A';
  serverQueue.songStartTime = null;
  serverQueue.nextDeckLoaded = null;
  serverQueue.bufferReady = serverQueue.bufferReady || {};
  serverQueue.bufferReady[deck] = false;

  safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.load(song.url, deck), 'load');
  // IMPORTANT: Delay to allow download thread to send first audio chunk
  // Without this delay, play command executes before data arrives, causing silence.
  // In replay (restartDeck) it's not needed because data is already buffered in full_samples.
  await new Promise(resolve => setTimeout(resolve, FIRST_CHUNK_DELAY_MS));
  if (!serverQueue.mixer) return;

  safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.play(deck), 'play');
  serverQueue.currentDeck = deck;
  serverQueue.currentDeckLoaded = song.url;
  serverQueue.nextDeckTarget = null;
  serverQueue.songStartTime = Date.now();

  // ── Binding deck → song (source of truth for sync) ──
  bindDeckSong(serverQueue, deck, serverQueue.playIndex || 0, song.url);
  bindDeckSong(serverQueue, deck === 'A' ? 'B' : 'A', null, null);

  // Update UI
  await updateDashboard(serverQueue, createCurrentSongEmbed(serverQueue), createDashboardComponents(serverQueue));

  // Start preload and statistics fallback cycle
  // (the play is credited to the statistics once the engine confirms real audio)
  onSongStart(guildId);
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
    const stateVersion = stateVersionManager.get(guildId);

    // STATE MACHINE: Determines current state and correct action

    // CASE 1 & 2: nothing is loaded (restored session, or dead mixer/connection)
    // but songs are queued → (re)start playback from scratch
    const needsFreshStart = serverQueue.songs?.length > 0 && (
      (serverQueue.sessionRestored && !serverQueue.currentDeckLoaded) ||
      !serverQueue.mixer || !serverQueue.connection
    );

    if (needsFreshStart) {
      serverQueue.sessionRestored = false;
      serverQueue.isPaused = false;
      stateVersion.incrementVersion('pause_action');

      const connected = deps.connectToVoice ? await deps.connectToVoice(serverQueue, null) : false;
      if (!connected) return { success: false, action: 'error', error: 'Failed to connect to voice' };

      await playSong(guildId);
      return { success: true, action: 'play' };
    }

    // CASE 3: Empty queue → error
    if (!serverQueue.songs || serverQueue.songs.length === 0) {
      return { success: false, action: 'error', error: 'Queue is empty' };
    }

    // CASE 4: Normal pause/resume toggle
    serverQueue.isPaused = !serverQueue.isPaused;

    if (serverQueue.isPaused) {
      // ── PAUSE PATH ──
      // Record pause start to calculate paused time on resume
      serverQueue.pauseStart = Date.now();

      try { serverQueue.player?.pause(); } catch { /* player may be detached */ }

      // Pause Rust mixer (ONLY if alive)
      if (serverQueue.mixer?.isProcessAlive?.()) {
        safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.pause(), 'pause');
      } else {
        console.warn('⚠️  [PAUSE] Mixer not alive, skipping mixer pause');
        handleMixerCrash(guildId, 'mixer_dead_during_pause');
      }

      // ── STATS: stop listening timer during pause ──
      stopAllListeners(guildId);

      stateVersion.incrementVersion('pause_action');
      return { success: true, action: 'pause' };
    }

    // ── RESUME PATH ──
    // Shift songStartTime by the paused duration so the elapsed time stays right
    const pausedFor = serverQueue.pauseStart ? (Date.now() - serverQueue.pauseStart) : 0;
    serverQueue.songStartTime = serverQueue.songStartTime
      ? serverQueue.songStartTime + pausedFor
      : Date.now();
    serverQueue.pauseStart = null;

    try { serverQueue.player?.unpause(); } catch { /* player may be detached */ }

    // Unpause Rust mixer (ONLY if alive)
    if (serverQueue.mixer?.isProcessAlive?.()) {
      safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.play(serverQueue.currentDeck || 'A'), 'resume');
    } else {
      console.warn('⚠️  [RESUME] Mixer not alive, skipping mixer play');
      handleMixerCrash(guildId, 'mixer_dead_during_resume');
    }

    // Restart the preload cycle
    await updatePreloadAfterQueueChange(guildId);

    // ── STATS: resume listening timer after resume ──
    startAllListeners(guildId, serverQueue.voiceChannel);

    stateVersion.incrementVersion('pause_action');
    return { success: true, action: 'resume' };
  } catch (e) {
    console.error('❌ [PAUSE-TOGGLE] Fatal error:', e);
    return { success: false, action: 'error', error: e.message };
  }
}

export { playSong, restartCurrentSong, togglePauseResume, resumeIfPaused };
