/**
 * Centralized management of the music queue
 * These functions MUST be used EVERYWHERE to avoid synchronization bugs
 *
 * TRANSACTIONS: Critical operations are wrapped with state versioning and rollback support
 */

import { sanitizeTitle, areSameSong } from '../utils/sanitize.js';
import { saveQueueState } from './persistence.js';
import { disconnectTimers } from '../state/globals.js';
import { stateVersionManager } from '../state/StateVersion.js';
import { DISCONNECT_TIMEOUT_MS } from '../../config/index.js';
// Lazy imports to avoid circular dependencies
let audioModule, statsModule, playCommandModule, playbackModule, skipManagerModule;

// Funzioni utility per la gestione della coda

/**
 * Check if the bot is alone in the voice channel
 * @param {object} serverQueue - Server queue
 * @returns {boolean} - true if bot is alone or no channel
 */
function isBotAloneInChannel(serverQueue) {
  if (!serverQueue || !serverQueue.voiceChannel) return true;
  try {
    const channel = serverQueue.voiceChannel;
    if (!channel || !channel.members) return true;
    return channel.members.size <= 1;
  } catch (e) {
    console.warn(`⚠️ [BOT-ALONE-CHECK] Error: ${e.message}`);
    return true;
  }
}

/**
 * Clean the finished queue before adding new music
 * @param {object} serverQueue - Server queue
 */
function clearFinishedQueue(serverQueue) {
  if (!serverQueue) return;
  if (!serverQueue.currentDeckLoaded) {
    const hadContent = serverQueue.songs.length > 0 || (serverQueue.history && serverQueue.history.length > 0);
    if (hadContent) {
      console.log('🧹 [QUEUE-CLEAR] Cleanup finished queue for new music');
      serverQueue.songs = [];
      serverQueue.history = [];
      serverQueue.playIndex = 0;
    }
  }
}

/**
 * Get current song via playIndex
 * @param {object} serverQueue - Server queue
 * @returns {object|null}
 */
/**
 * Get the current song.
 *
 * SOURCE OF TRUTH: if the mixer is active and the current deck has a valid binding,
 * the "real" index of the playing song is the one bound to the active deck,
 * not the simple playIndex (which in rare race conditions could be
 * temporarily misaligned). The binding is validated against the URL: if it's no longer valid
 * it falls back to playIndex, so in the worst case the behavior is identical
 * to before. This guarantees that the embed will ALWAYS show what's playing on the mixer.
 *
 * @param {object} serverQueue - Server queue
 * @returns {object|null}
 */
function getPlayingIndex(serverQueue) {
  if (!serverQueue) return 0;
  if (serverQueue.currentDeck && serverQueue.currentDeckLoaded && isMixerAlive(serverQueue)) {
    const idx = resolveDeckIndex(serverQueue, serverQueue.currentDeck);
    if (idx !== null && idx !== undefined) return idx;
  }
  return serverQueue.playIndex || 0;
}

function getCurrentSong(serverQueue) {
  if (!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0) return null;
  const index = getPlayingIndex(serverQueue);
  return index < serverQueue.songs.length ? serverQueue.songs[index] : null;
}

/**
 * Get next song via playIndex + 1
 * @param {object} serverQueue - Server queue
 * @returns {object|null}
 */
function getNextSong(serverQueue) {
  if (!serverQueue || !serverQueue.songs) return null;
  const nextIndex = (serverQueue.playIndex || 0) + 1;
  if (nextIndex >= serverQueue.songs.length) return null;
  return serverQueue.songs[nextIndex];
}

/**
 * Check if there is a next song
 * @param {object} serverQueue - Server queue
 * @returns {boolean}
 */
function hasNextSong(serverQueue) {
  if (!serverQueue || !serverQueue.songs) return false;
  return (serverQueue.playIndex || 0) + 1 < serverQueue.songs.length;
}

// ─── Deck → song binding (robust embed/mixer synchronization) ──────────
//
// The historical desynchronization problem arose from rebuilding the current
// song index by "guessing" (playIndex+1) in multiple places, while the real state is
// in the Rust mixer (which deck is active). By explicitly binding each deck to the song
// we load on top of it, any event (manual skip, crossfade, Rust auto-gapless)
// can trace back to the REAL index of the playing song.

/**
 * Register which song (index + url) is loaded on a deck.
 * Pass index=null to clean the binding.
 * @param {object} serverQueue
 * @param {string} deck - 'A' | 'B'
 * @param {number|null} index - index in songs[]
 * @param {string|null} url
 */
function bindDeckSong(serverQueue, deck, index, url) {
  if (!serverQueue) return;
  if (!serverQueue.deckSongs) serverQueue.deckSongs = { A: null, B: null };
  serverQueue.deckSongs[deck] = (index !== null && index !== undefined && url) ? { index, url } : null;
}

/**
 * Resolve the REAL index (in songs[]) of the song loaded on a deck.
 * Validates against the saved URL; if the queue was reordered (insert/remove/shuffle)
 * searches by URL. Returns null if the binding is no longer valid.
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
 * Clear all deck→song bindings. Should be called in cleanup (end queue,
 * disconnection, crash, queue emptying) to avoid "ghost" bindings that
 * could resolve a no-longer-valid index.
 * @param {object} serverQueue
 */
function clearDeckBindings(serverQueue) {
  if (!serverQueue) return;
  serverQueue.deckSongs = { A: null, B: null };
}


/**
 * Check if a song is valid
 * @param {object} song - Song object
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
 * Insert song at specific position (with transaction and versioning)
 * @param {object} serverQueue - Server queue
 * @param {object} song - Song to insert
 * @param {number} index - Insertion index
 * @returns {{success: boolean, error?: string}}
 */
function insertSongAtIndex(serverQueue, song, index) {
  try {
    const guildId = serverQueue.guildId;
    const stateVersion = stateVersionManager.get(guildId);

    // Validation
    if (!isValidSong(song) || index < 0) {
      console.warn('⚠️ [QUEUE-INSERT] Attempted to insert invalid song');
      return { success: false, error: 'Invalid song or index' };
    }
    if (!serverQueue || !serverQueue.songs) {
      return { success: false, error: 'Invalid queue' };
    }
    if (index > serverQueue.songs.length) {
      return { success: false, error: `Index out of range: ${index}` };
    }

    // Snapshot of state before modification (for rollback)
    const previousSongs = [...serverQueue.songs];
    const previousPlayIndex = serverQueue.playIndex;

    try {
      // Insert the song
      serverQueue.songs.splice(index, 0, song);

      // Adjust playIndex if insertion is before or at current point
      const playIndex = serverQueue.playIndex || 0;
      if (index <= playIndex) {
        serverQueue.playIndex = playIndex + 1;
      }

      console.log(`📥 [QUEUE-INSERT] Inserted "${sanitizeTitle(song.title)}" at position ${index}`);

      // Save state
      saveQueueState(guildId, serverQueue);

      // Increment version
      stateVersion.incrementVersion('queue_insert', {
        index,
        songTitle: sanitizeTitle(song.title)
      });

      return { success: true };

    } catch (e) {
      // ROLLBACK if save fails
      console.error('❌ [QUEUE-INSERT] Error, rollback:', e.message);
      serverQueue.songs = previousSongs;
      serverQueue.playIndex = previousPlayIndex;

      stateVersion.incrementVersion('queue_insert_rollback', {
        error: e.message
      });

      return { success: false, error: `Failed to insert song: ${e.message}` };
    }

  } catch (e) {
    console.error('❌ [QUEUE-INSERT] Fatal error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Remove song from specific index (with transaction and versioning)
 * @param {object} serverQueue - Server queue
 * @param {number} index - Index to remove
 * @returns {{success: boolean, removed?: object, error?: string}}
 */
async function removeSongAtIndex(serverQueue, index) {
  try {
    const guildId = serverQueue.guildId;
    const stateVersion = stateVersionManager.get(guildId);

    // Validation
    if (!serverQueue || !serverQueue.songs) {
      return { success: false, error: 'Invalid queue' };
    }
    if (index < 0 || index >= serverQueue.songs.length) {
      console.warn(`⚠️ [QUEUE-REMOVE] Index out of range: ${index}`);
      return { success: false, error: `Index out of range: ${index}` };
    }

    // Snapshot of state before modification (for rollback)
    const previousSongs = [...serverQueue.songs];
    const previousPlayIndex = serverQueue.playIndex;
    const previousNextDeckLoaded = serverQueue.nextDeckLoaded;
    const previousNextDeckTarget = serverQueue.nextDeckTarget;

    try {
      // Remove the song
      const removed = serverQueue.songs.splice(index, 1)[0];

      if (removed) {
        // Adjust playIndex after removal
        const playIndex = serverQueue.playIndex || 0;
        if (index < playIndex) {
          serverQueue.playIndex = Math.max(0, playIndex - 1);
        } else if (index === playIndex && serverQueue.playIndex >= serverQueue.songs.length && serverQueue.songs.length > 0) {
          serverQueue.playIndex = serverQueue.songs.length - 1;
        }

        // Invalidate preload if the removed song was the preloaded one
        if (serverQueue.nextDeckLoaded && areSameSong(serverQueue.nextDeckLoaded, removed.url)) {
          serverQueue.nextDeckLoaded = null;
          serverQueue.nextDeckTarget = null;
        }

        // Invalidate deck→song bindings that point to the removed song
        if (serverQueue.deckSongs) {
          for (const d of ['A', 'B']) {
            const b = serverQueue.deckSongs[d];
            if (b && areSameSong(b.url, removed.url)) serverQueue.deckSongs[d] = null;
          }
        }

        console.log(`🗑️ [QUEUE-REMOVE] Removed "${sanitizeTitle(removed.title)}" from position ${index}`);

        // Save state
        saveQueueState(guildId, serverQueue);

        // Increment version
        stateVersion.incrementVersion('queue_remove', {
          index,
          songTitle: sanitizeTitle(removed.title)
        });

        // Notify preload update
        try {
          if (!audioModule) audioModule = await import('../audio/index.js');
          audioModule.updatePreloadAfterQueueChange(guildId);
        } catch { }

        return { success: true, removed };
      }

      return { success: false, error: 'Failed to remove song' };

    } catch (e) {
      // ROLLBACK if save fails
      console.error('❌ [QUEUE-REMOVE] Error, rollback:', e.message);
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
    console.error('❌ [QUEUE-REMOVE] Fatal error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Check if the mixer is active and functioning
 * @param {object} serverQueue - Server queue
 * @returns {boolean}
 */
function isMixerAlive(serverQueue) {
  return serverQueue &&
        serverQueue.mixer &&
        serverQueue.mixer.isProcessAlive &&
        serverQueue.mixer.isProcessAlive();
}

// switchActiveDeck, advanceToNextSong, getCurrentPlayingSong removed in v3
// All transition logic is centralized in SkipManager v3

/**
 * Complete cleanup on forced disconnection (bot alone or disconnect)
 * @param {object} serverQueue
 */
async function performDisconnectCleanup(serverQueue) {
  if (!serverQueue) return;
  if (serverQueue._cleaningUp) return; // Guard against re-entry (avoids cascade)
  if (serverQueue._isReconnecting) return; // Don't interfere with ongoing reconnection
  serverQueue._cleaningUp = true;
  try {
    console.log(`🧹 [CLEANUP] Performing disconnect cleanup for guild ${serverQueue.guildId}`);

    // Clear pending deferred transition
    if (serverQueue.pendingTransition) {
      if (serverQueue.pendingTransition._cleanupTimer) clearTimeout(serverQueue.pendingTransition._cleanupTimer);
      serverQueue.pendingTransition = null;
    }

    // Clear pending dashboard timer
    if (serverQueue.dashboardState && serverQueue.dashboardState.timer) {
      clearTimeout(serverQueue.dashboardState.timer);
      serverQueue.dashboardState.timer = null;
    }

    // ── STATS: stop listening timers and save to disk ──
    try {
      if (!statsModule) statsModule = await import('../database/stats.js');
      statsModule.flushGuildAndSave(serverQueue.guildId);
    } catch { }

    // Stop the player
    try { if (serverQueue.player) serverQueue.player.stop(true); } catch { }
    // Kill mixer if present
    try { if (serverQueue.mixer && typeof serverQueue.mixer.kill === 'function') serverQueue.mixer.kill(); } catch { }
    // Destroy voice connection
    try { if (serverQueue.connection) serverQueue.connection.destroy(); } catch { }

    // Cleanup low-latency stream to avoid pipe/fd leak
    try { if (serverQueue._llStream) { serverQueue._llStream.unpipe(); serverQueue._llStream.destroy(); serverQueue._llStream = null; } } catch { }

    // Cleanup per-guild audio state
    try {
      if (!audioModule) audioModule = await import('../audio/index.js');
      audioModule.clearStreamErrors(serverQueue.guildId);
    } catch { }
    try {
      if (!playbackModule) playbackModule = await import('../audio/playback.js');
      playbackModule.cleanupPlaybackState(serverQueue.guildId);
    } catch { }
    try {
      if (!skipManagerModule) skipManagerModule = await import('../audio/SkipManager.js');
      skipManagerModule.default.cleanupSkipState(serverQueue.guildId);
    } catch { }
    try {
      if (!playCommandModule) playCommandModule = await import('../commands/play.js');
      playCommandModule.cleanupLastCleanupTime(serverQueue.guildId);
    } catch { }

    // Reset some queue state fields
    serverQueue.connection = null;
    serverQueue.currentDeckLoaded = null;
    serverQueue.nextDeckLoaded = null;
    serverQueue.isPaused = false;
    serverQueue.songStartTime = null;
    serverQueue.nextDeckTarget = null;
    clearDeckBindings(serverQueue);

    // Save state to disk
    try { saveQueueState(serverQueue.guildId, serverQueue); } catch { }

    // Make sure to remove references to mixer and player to avoid duplicates after restart
    try { serverQueue.mixer = null; } catch { }
    try { serverQueue.player = null; } catch { }
    // Clear any scheduled timer
    try { disconnectTimers.delete(serverQueue.guildId); } catch { }

  } catch {
    console.error('❌ [CLEANUP] Error during disconnect cleanup:', e);
  } finally {
    serverQueue._cleaningUp = false;
  }
}

/**
 * Schedule disconnection when bot is alone in voice channel
 * @param {object} serverQueue
 * @param {number} timeoutMs
 */
function scheduleDisconnectIfAlone(serverQueue, timeoutMs = DISCONNECT_TIMEOUT_MS) {
  if (!serverQueue || !serverQueue.guildId) return false;
  const gid = serverQueue.guildId;

  // Immediate cleanup request (e.g. bot disconnected/kicked)
  // bypasses channel checks and calls cleanup directly.
  if (timeoutMs === 0) {
    // If there's already a scheduled timer, cancel it.
    if (disconnectTimers.has(gid)) {
      try { clearTimeout(disconnectTimers.get(gid)); } catch { }
      disconnectTimers.delete(gid);
    }
    performDisconnectCleanup(serverQueue);
    return true;
  }

  // If not alone, make sure to clear any previous timer
  if (!isBotAloneInChannel(serverQueue)) {
    if (disconnectTimers.has(gid)) {
      clearTimeout(disconnectTimers.get(gid));
      disconnectTimers.delete(gid);
    }
    return false;
  }
  // If a timer already exists, do nothing
  if (disconnectTimers.has(gid)) return true;
  const t = setTimeout(() => {
    try {
      // Recheck before executing
      if (isBotAloneInChannel(serverQueue)) {
        performDisconnectCleanup(serverQueue);
      } else {
        // Someone returned: just delete the timer
        disconnectTimers.delete(gid);
      }
    } catch { disconnectTimers.delete(gid); }
  }, timeoutMs);
  disconnectTimers.set(gid, t);
  console.log(`⏱️ [SCHEDULE] Disconnect timer scheduled for guild ${gid} (${timeoutMs}ms)`);
  return true;
}

/**
 * Cancel a scheduled disconnect timer
 * @param {object} serverQueue
 */
function cancelScheduledDisconnect(serverQueue) {
  if (!serverQueue || !serverQueue.guildId) return false;
  const gid = serverQueue.guildId;
  if (!disconnectTimers.has(gid)) return false;
  try {
    clearTimeout(disconnectTimers.get(gid));
  } catch { }
  disconnectTimers.delete(gid);
  console.log(`⏱️ [CANCEL] Disconnect timer cancelled for guild ${gid}`);
  return true;
}

export {
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
