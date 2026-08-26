/**
 * Basic playback functions
 * Responsibilities:
 *  - playSong:            starts playback of the current song (songs[playIndex])
 *  - restartCurrentSong:  restarts the current song from the beginning (replay)
 *  - togglePauseResume:   pause/resume state machine
 */

import { joinVoiceChannel, createAudioResource, StreamType, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { PassThrough } from 'stream';
import { queue, acquirePlaybackSession, releasePlaybackSession } from '../state/globals.js';
import { stateVersionManager } from '../state/StateVersion.js';
import { getCurrentSong, isValidSong, bindDeckSong } from '../queue/QueueManager.js';
import { saveQueueState } from '../queue/persistence.js';
import { createCurrentSongEmbed, createDashboardComponents, updateDashboard, updateDashboardToFinished, refreshDashboard } from '../ui/index.js';
import { safeMixerInvoke } from './mixer-utils.js';
import AudioMixerController from './AudioMixerController.js';
import { onSongStart, updatePreloadAfterQueueChange } from './PlaybackEngine.js';
import { handleRustEvent, isFailedSong } from './rust-events.js';
import { handleMixerCrash } from './recovery.js';
import { getMixerCrashCooldownMs } from './crash-cooldown.js';
import { schedulePauseTimeout, cancelPauseTimeout } from './teardown.js';
import { stopAllListeners, startAllListeners } from '../database/stats.js';
import { PLAYER_BUSY_ELSEWHERE } from '../ui/messages.js';

// Key factor for pipeline latency:
// low highWaterMark = less audio buffered in pipe = more reactive skips
// 3840 bytes = exactly 1 Discord frame (20ms at 48kHz stereo 16-bit)
const LOW_LATENCY_HWM = 3840 * 2; // 2 frames = 40ms of buffer

// Wait for the first audio chunk to reach the deck before hitting play
const FIRST_CHUNK_DELAY_MS = 150;

// Startup polling for the mixer's stdout
const MIXER_STDOUT_POLL_MS = 100;
const MIXER_STDOUT_POLL_ATTEMPTS = 30;
const MIXER_SETTLE_MS = 200;

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
 */
function resumeIfPaused(serverQueue, guildId) {
  if (!serverQueue.isPaused) return; // Nothing to do if not paused

  serverQueue.isPaused = false;
  serverQueue.pauseStart = null;
  cancelPauseTimeout(serverQueue);

  // Resume Discord player
  try { serverQueue.player?.unpause(); } catch { /* player may be detached */ }

  // Resume Rust mixer
  if (serverQueue.mixer?.isProcessAlive?.()) {
    safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.resume(), 'resume');
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
  resumeIfPaused(serverQueue, guildId);

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
      (reason) => handleMixerCrash(guildId, reason)
    );
    serverQueue.mixer.start();
    serverQueue.mixerGeneration = serverQueue.mixer.generation;

    // Wait for stdout to become available
    let stdout = null;
    for (let i = 0; i < MIXER_STDOUT_POLL_ATTEMPTS; i++) {
      stdout = serverQueue.mixer.getStdout();
      if (stdout) break;
      if (serverQueue.mixer.needsRestart()) break;
      await new Promise(r => setTimeout(r, MIXER_STDOUT_POLL_MS));
    }

    if (!stdout) {
      console.error('❌ [PLAY] Mixer stdout not available, aborting');
      serverQueue.mixer.kill();
      serverQueue.mixer = null;
      return null;
    }

    await new Promise(r => setTimeout(r, MIXER_SETTLE_MS));
    if (!serverQueue.mixer || !serverQueue.mixer.isProcessAlive()) {
      console.error('❌ [PLAY] Mixer dead before first command');
      if (serverQueue.mixer) { serverQueue.mixer.kill(); serverQueue.mixer = null; }
      return null;
    }

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

  // Already playing: nothing to start. Checked before anything else, so a stray
  // call cannot advance playIndex past a blacklisted song while audio is live.
  if (serverQueue.currentDeckLoaded) return;

  // One playback at a time across every server: a second engine would double
  // the decoded audio held in memory. The commands check this first so the user
  // gets a proper reply; this is the guard for every other entry point.
  if (!acquirePlaybackSession(guildId)) {
    console.warn(`⛔ [PLAY] Playback refused for guild ${guildId}: another server is using the player`);
    try { await serverQueue.textChannel?.send?.({ content: PLAYER_BUSY_ELSEWHERE }); } catch { /* channel may be gone */ }
    return;
  }

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
      releasePlaybackSession(guildId);
      return;
    }
  }

  // Skip songs blacklisted after repeated stream errors
  const previousSong = getCurrentSong(serverQueue);
  const song = skipBlacklistedSongs(serverQueue, guildId);
  if (!song) {
    // Clear the deck state first: the dashboard reads it to decide it must
    // render the "queue finished" layout.
    serverQueue.currentDeckLoaded = null;
    serverQueue.nextDeckLoaded = null;
    cleanupLowLatencyStream(serverQueue);
    releasePlaybackSession(guildId);
    await updateDashboardToFinished(serverQueue, previousSong);
    return;
  }

  // Avoid concurrent mixer startups
  if (serverQueue.mixerStarting) {
    for (let i = 0; i < MIXER_STDOUT_POLL_ATTEMPTS; i++) {
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
    if (!stdout) {
      releasePlaybackSession(guildId);
      return;
    }
    attachMixerOutput(serverQueue, stdout);
  } else {
    const stdout = serverQueue.mixer.getStdout();
    if (!stdout) {
      console.error('❌ [PLAY] Existing mixer has no stdout');
      releasePlaybackSession(guildId);
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
  if (!serverQueue.mixer) {
    releasePlaybackSession(guildId);
    return;
  }

  safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.play(deck), 'play');
  serverQueue.currentDeck = deck;
  serverQueue.currentDeckLoaded = song.url;
  serverQueue.nextDeckTarget = null;
  serverQueue.songStartTime = Date.now();
  serverQueue.isPaused = false;

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
 * Pauses or resumes playback, keeping the Discord player, the Rust mixer and
 * the listening statistics in step.
 *
 * The dashboard only enables the pause control while a deck is loaded, so this
 * never has to start playback from scratch: that is what the play/skip/replay
 * controls are for.
 * @param {string} guildId
 * @param {object} serverQueue
 * @returns {Promise<{success: boolean, action: 'pause'|'resume'|'error', error?: string}>}
 */
async function togglePauseResume(guildId, serverQueue) {
  try {
    if (!serverQueue.songs || serverQueue.songs.length === 0) {
      return { success: false, action: 'error', error: 'Queue is empty' };
    }

    const stateVersion = stateVersionManager.get(guildId);
    serverQueue.isPaused = !serverQueue.isPaused;

    if (serverQueue.isPaused) {
      // ── PAUSE PATH ──
      // Record pause start to calculate paused time on resume
      serverQueue.pauseStart = Date.now();

      try { serverQueue.player?.pause(); } catch { /* player may be detached */ }

      if (serverQueue.mixer?.isProcessAlive?.()) {
        safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.pause(), 'pause');
      } else {
        console.warn('⚠️  [PAUSE] Mixer not alive, skipping mixer pause');
        handleMixerCrash(guildId, 'mixer_dead_during_pause');
      }

      // ── STATS: stop listening timer during pause ──
      stopAllListeners(guildId);

      // A pause left running forever keeps the whole engine (and its buffers)
      // alive for nothing: disconnect once it has lasted too long.
      schedulePauseTimeout(serverQueue);

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
    cancelPauseTimeout(serverQueue);

    try { serverQueue.player?.unpause(); } catch { /* player may be detached */ }

    if (serverQueue.mixer?.isProcessAlive?.()) {
      safeMixerInvoke(serverQueue, guildId, () => serverQueue.mixer.resume(), 'resume');
    } else {
      console.warn('⚠️  [RESUME] Mixer not alive, skipping mixer resume');
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
