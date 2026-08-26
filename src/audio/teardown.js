/**
 * src/audio/teardown.js
 *
 * Stopping a guild's audio, in one place.
 *
 * Four situations end playback — the queue running out, a mixer crash, the bot
 * being left alone in a voice channel, and the bot being removed from the
 * server — and each used to repeat the same teardown sequence with small,
 * drifting differences. They all go through `stopGuildAudio` now; what really
 * differs between them is expressed as options.
 */

import { disconnectTimers, releasePlaybackSession } from '../state/globals.js';
import { DISCONNECT_TIMEOUT_MS, MAX_PAUSE_MS } from '../../config/index.js';
import { clearDeckBindings, isBotAloneInChannel } from '../queue/QueueManager.js';
import { saveQueueState } from '../queue/persistence.js';
import { flushGuildAndSave } from '../database/stats.js';
import { resetMessageCleanupState } from '../utils/cleanup.js';
import { clearAllTimers } from './PlaybackEngine.js';
import { commandQueue } from './SerialQueue.js';
import { cleanupSkipState } from './SkipManager.js';
import { clearStreamErrors } from './rust-events.js';
import { cleanupRecoveryState } from './crash-cooldown.js';
import { refreshDashboard } from '../ui/index.js';
import { pausedTooLong } from '../ui/messages.js';

/**
 * Stops everything that produces audio for a guild and resets the deck state
 * that describes it. The queue itself (songs, playIndex) is left alone: what
 * should happen to it depends on why playback stopped, so callers decide.
 *
 * @param {object} serverQueue
 * @param {object} [options]
 * @param {string} [options.reason='teardown'] - Reported to callers waiting on the command queue
 * @param {boolean} [options.destroyConnection=false] - Also leave the voice channel
 * @param {boolean} [options.intentional=true] - false when the mixer already died on its own:
 *   flagging a kill as intentional is only meaningful for a mixer still able to
 *   report a crash, and a stale flag would swallow the next genuine recovery.
 */
function stopGuildAudio(serverQueue, options = {}) {
  if (!serverQueue) return;
  const { reason = 'teardown', destroyConnection = false, intentional = true } = options;
  const guildId = serverQueue.guildId;

  // Pending deferred transition: its timer would fire against a dead pipeline
  if (serverQueue.pendingTransition) {
    if (serverQueue.pendingTransition._cleanupTimer) clearTimeout(serverQueue.pendingTransition._cleanupTimer);
    serverQueue.pendingTransition = null;
  }

  if (serverQueue.dashboardState?.timer) {
    clearTimeout(serverQueue.dashboardState.timer);
    serverQueue.dashboardState.timer = null;
  }

  // A crash recovery scheduled earlier would restart playback — and rejoin the
  // voice channel — after the very teardown that was meant to stop it.
  if (serverQueue._recoveryTimer) {
    clearTimeout(serverQueue._recoveryTimer);
    serverQueue._recoveryTimer = null;
  }

  cancelPauseTimeout(serverQueue);
  clearAllTimers(guildId);
  commandQueue.flushPending(guildId, reason);

  try { serverQueue.player?.stop(true); } catch { /* player may be detached */ }

  if (serverQueue.mixer) {
    if (intentional) serverQueue.intentionalKill = true;
    try { serverQueue.mixer.kill(); } catch { /* already dead */ }
    serverQueue.mixer = null;
  }

  // Destroy the low-latency stream to prevent a pipe/fd leak
  try {
    if (serverQueue._llStream) {
      serverQueue._llStream.unpipe();
      serverQueue._llStream.destroy();
      serverQueue._llStream = null;
    }
  } catch { /* stream already torn down */ }

  if (destroyConnection) {
    try { serverQueue.connection?.destroy(); } catch { /* already destroyed */ }
    serverQueue.connection = null;
  }

  // Deck state describes a pipeline that no longer exists
  serverQueue.currentDeck = null;
  serverQueue.currentDeckLoaded = null;
  serverQueue.nextDeckLoaded = null;
  serverQueue.nextDeckTarget = null;
  serverQueue.bufferReady = {};
  serverQueue.mixerGeneration = null;
  serverQueue.mixerStarting = false;
  serverQueue.loadingFooter = null;
  clearDeckBindings(serverQueue);

  // Nothing is playing here any more: let another guild have the single slot.
  releasePlaybackSession(guildId);
}

/**
 * Starts the countdown that disconnects a paused session.
 *
 * A pause keeps the engine, its two decks and every sample they hold alive for
 * as long as nobody comes back, which on a box shared with other bots is memory
 * spent on silence. Any resume cancels it.
 * @param {object} serverQueue
 */
function schedulePauseTimeout(serverQueue) {
  if (!serverQueue || !serverQueue.guildId) return;
  cancelPauseTimeout(serverQueue);

  serverQueue._pauseTimer = setTimeout(() => {
    serverQueue._pauseTimer = null;
    // Somebody resumed and paused again in the meantime, or playback is over
    if (!serverQueue.isPaused || !serverQueue.currentDeckLoaded) return;

    console.log(`⏸️ [PAUSE-TIMEOUT] Guild ${serverQueue.guildId} paused for ${MAX_PAUSE_MS}ms, disconnecting`);
    const channel = serverQueue.textChannel;
    performDisconnectCleanup(serverQueue);
    // Marks the queue the way a restart does, so /play and the replay button
    // pick the session up at the song it was paused on instead of the first one.
    serverQueue.sessionRestored = true;

    const minutes = Math.round(MAX_PAUSE_MS / 60000);
    channel?.send?.({ content: pausedTooLong(minutes) })?.catch?.(() => { });
    refreshDashboard(serverQueue).catch(() => { });
  }, MAX_PAUSE_MS);
}

/**
 * Cancels the pause countdown (resume, skip, teardown).
 * @param {object} serverQueue
 */
function cancelPauseTimeout(serverQueue) {
  if (!serverQueue || !serverQueue._pauseTimer) return;
  clearTimeout(serverQueue._pauseTimer);
  serverQueue._pauseTimer = null;
}

/**
 * Forgets the per-guild bookkeeping the audio modules keep outside the queue
 * object (blacklists, throttles, crash history, message-cleanup debounce).
 * @param {string} guildId
 */
function clearGuildAudioState(guildId) {
  clearStreamErrors(guildId);
  cleanupRecoveryState(guildId);
  cleanupSkipState(guildId);
  resetMessageCleanupState(guildId);
}

/**
 * Full cleanup when the bot leaves (or is thrown out of) a voice channel.
 * @param {object} serverQueue
 */
function performDisconnectCleanup(serverQueue) {
  if (!serverQueue) return;
  if (serverQueue._cleaningUp) return;      // Guard against re-entry (avoids cascade)
  if (serverQueue._isReconnecting) return;  // Don't interfere with an ongoing reconnection
  serverQueue._cleaningUp = true;
  try {
    console.log(`🧹 [CLEANUP] Performing disconnect cleanup for guild ${serverQueue.guildId}`);

    // ── STATS: stop listening timers and save to disk ──
    flushGuildAndSave(serverQueue.guildId);

    stopGuildAudio(serverQueue, { reason: 'Disconnect cleanup', destroyConnection: true });
    clearGuildAudioState(serverQueue.guildId);

    serverQueue.isPaused = false;
    serverQueue.songStartTime = null;

    saveQueueState(serverQueue.guildId, serverQueue);
    disconnectTimers.delete(serverQueue.guildId);
  } catch (e) {
    console.error('❌ [CLEANUP] Error during disconnect cleanup:', e);
  } finally {
    serverQueue._cleaningUp = false;
  }
}

/**
 * Schedules the disconnection of a bot left alone in a voice channel.
 * A timeout of 0 means "clean up right now" and skips the alone check.
 * @param {object} serverQueue
 * @param {number} timeoutMs
 * @returns {boolean}
 */
function scheduleDisconnectIfAlone(serverQueue, timeoutMs = DISCONNECT_TIMEOUT_MS) {
  if (!serverQueue || !serverQueue.guildId) return false;
  const guildId = serverQueue.guildId;

  // Immediate cleanup request (e.g. bot disconnected/kicked)
  if (timeoutMs === 0) {
    cancelScheduledDisconnect(serverQueue);
    performDisconnectCleanup(serverQueue);
    return true;
  }

  // Someone is still listening: drop any timer left from before
  if (!isBotAloneInChannel(serverQueue)) {
    cancelScheduledDisconnect(serverQueue);
    return false;
  }

  if (disconnectTimers.has(guildId)) return true;

  const timer = setTimeout(() => {
    try {
      // Recheck before executing: somebody may have come back
      if (isBotAloneInChannel(serverQueue)) {
        performDisconnectCleanup(serverQueue);
      } else {
        disconnectTimers.delete(guildId);
      }
    } catch { disconnectTimers.delete(guildId); }
  }, timeoutMs);

  disconnectTimers.set(guildId, timer);
  console.log(`⏱️ [SCHEDULE] Disconnect timer scheduled for guild ${guildId} (${timeoutMs}ms)`);
  return true;
}

/**
 * Cancels a scheduled disconnect timer.
 * @param {object} serverQueue
 * @returns {boolean} true if a timer was actually cancelled
 */
function cancelScheduledDisconnect(serverQueue) {
  if (!serverQueue || !serverQueue.guildId) return false;
  const guildId = serverQueue.guildId;
  if (!disconnectTimers.has(guildId)) return false;
  try {
    clearTimeout(disconnectTimers.get(guildId));
  } catch { /* timer already fired */ }
  disconnectTimers.delete(guildId);
  console.log(`⏱️ [CANCEL] Disconnect timer cancelled for guild ${guildId}`);
  return true;
}

export {
  stopGuildAudio,
  schedulePauseTimeout,
  cancelPauseTimeout,
  clearGuildAudioState,
  performDisconnectCleanup,
  scheduleDisconnectIfAlone,
  cancelScheduledDisconnect
};
