/**
 * Centralized management of the music queue.
 * These functions MUST be used EVERYWHERE to avoid synchronization bugs.
 *
 * This module is pure queue logic: it never reaches into the audio layer, so
 * the audio modules are free to build on top of it. Stopping playback lives in
 * src/audio/teardown.js.
 */

import { sanitizeTitle, areSameSong } from '../utils/sanitize.js';
import { saveQueueState } from './persistence.js';
import { stateVersionManager } from '../state/StateVersion.js';
import { MAX_SONG_DURATION_SECONDS, MAX_QUEUE_SIZE } from '../../config/index.js';

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
  if (!serverQueue.currentDeckLoaded && serverQueue.songs.length > 0) {
    console.log('🧹 [QUEUE-CLEAR] Cleanup finished queue for new music');
    serverQueue.songs = [];
    serverQueue.playIndex = 0;
  }
}

/**
 * Index of the song actually playing.
 *
 * SOURCE OF TRUTH: if the mixer is active and the current deck has a valid binding,
 * the "real" index of the playing song is the one bound to the active deck,
 * not the simple playIndex (which in rare race conditions could be
 * temporarily misaligned). The binding is validated against the URL: if it's no longer valid
 * it falls back to playIndex, so in the worst case the behavior is identical
 * to before. This guarantees that the embed will ALWAYS show what's playing on the mixer.
 *
 * @param {object} serverQueue - Server queue
 * @returns {number}
 */
function getPlayingIndex(serverQueue) {
  if (!serverQueue) return 0;
  if (serverQueue.currentDeck && serverQueue.currentDeckLoaded && isMixerAlive(serverQueue)) {
    const idx = resolveDeckIndex(serverQueue, serverQueue.currentDeck);
    if (idx !== null && idx !== undefined) return idx;
  }
  return serverQueue.playIndex || 0;
}

/**
 * Get the song currently playing (or the one playIndex points at).
 * @param {object} serverQueue - Server queue
 * @returns {object|null}
 */
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
 * Validates against the saved URL; if the queue was reordered (insert/shuffle)
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

// ─── Acceptance rules ─────────────────────────────────────────────────
//
// The audio engine holds every decoded sample of a track in memory, so what
// goes into the queue is what bounds its footprint. Both rules are checked
// here, once, for every path that can add a song.

/**
 * Why a song cannot be queued.
 * @param {object} song
 * @returns {'live'|'too_long'|null} null when the song is acceptable
 */
function songRejectionReason(song) {
  if (!song) return null;
  if (song.isLive) return 'live';
  // duration 0 means yt-dlp did not report one: accept it and let the engine's
  // own ceiling deal with it, rather than refusing a perfectly normal track.
  const duration = Number(song.duration) || 0;
  if (duration > MAX_SONG_DURATION_SECONDS) return 'too_long';
  return null;
}

/**
 * Splits a batch of songs into the ones that can be queued and the counts of
 * those that cannot, so the caller can tell the user what was dropped.
 * @param {Array<object>} songs
 * @returns {{accepted: Array<object>, tooLong: number, live: number, rejected: number}}
 */
function filterPlayableSongs(songs) {
  const accepted = [];
  let tooLong = 0;
  let live = 0;

  for (const song of songs || []) {
    const reason = songRejectionReason(song);
    if (reason === 'live') live++;
    else if (reason === 'too_long') tooLong++;
    else accepted.push(song);
  }

  const rejected = tooLong + live;
  if (rejected > 0) {
    console.log(`⛔ [QUEUE-FILTER] Rejected ${rejected} song(s): ${tooLong} too long, ${live} live`);
  }
  return { accepted, tooLong, live, rejected };
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
 * Insert a song at a specific position, keeping playIndex on the same song.
 * @param {object} serverQueue - Server queue
 * @param {object} song - Song to insert
 * @param {number} index - Insertion index
 * @returns {{success: boolean, error?: string, reason?: string}}
 */
function insertSongAtIndex(serverQueue, song, index) {
  if (!serverQueue || !serverQueue.songs) {
    return { success: false, error: 'Invalid queue' };
  }
  // The same ceiling /play enforces: it was missing on every path that inserts
  // rather than appends, so the queue could grow past it one song at a time.
  if (serverQueue.songs.length >= MAX_QUEUE_SIZE) {
    return { success: false, reason: 'queue_full', error: `Queue limit reached (${MAX_QUEUE_SIZE})` };
  }
  if (!isValidSong(song) || index < 0) {
    console.warn('⚠️ [QUEUE-INSERT] Attempted to insert invalid song');
    return { success: false, error: 'Invalid song or index' };
  }
  if (index > serverQueue.songs.length) {
    return { success: false, error: `Index out of range: ${index}` };
  }

  serverQueue.songs.splice(index, 0, song);

  // Inserting at or before the current position shifts it by one
  const playIndex = serverQueue.playIndex || 0;
  if (index <= playIndex) serverQueue.playIndex = playIndex + 1;

  console.log(`📥 [QUEUE-INSERT] Inserted "${sanitizeTitle(song.title)}" at position ${index}`);

  saveQueueState(serverQueue.guildId, serverQueue);
  stateVersionManager.get(serverQueue.guildId).incrementVersion('queue_insert');

  return { success: true };
}

/**
 * Check if the mixer is active and functioning
 * @param {object} serverQueue - Server queue
 * @returns {boolean}
 */
function isMixerAlive(serverQueue) {
  return !!(serverQueue &&
        serverQueue.mixer &&
        serverQueue.mixer.isProcessAlive &&
        serverQueue.mixer.isProcessAlive());
}

export {
  isBotAloneInChannel,
  clearFinishedQueue,
  songRejectionReason,
  filterPlayableSongs,
  getCurrentSong,
  getPlayingIndex,
  getNextSong,
  hasNextSong,
  bindDeckSong,
  resolveDeckIndex,
  clearDeckBindings,
  isValidSong,
  insertSongAtIndex,
  isMixerAlive
};
