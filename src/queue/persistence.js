/**
 * Queue persistence management (backup/restore)
 */

import fs from 'fs';
import { QUEUE_FILE } from '../../config/index.js';
import { safeJSONParse } from '../utils/sanitize.js';

// ─── In-memory cache to avoid repeated disk reads ──
let _queueCache = null;

function _getQueueCache() {
  if (_queueCache === null) {
    _queueCache = safeJSONParse(QUEUE_FILE, {});
  }
  return _queueCache;
}

function _flushQueueCache() {
  if (_queueCache === null) return;
  try {
    const tmpFile = QUEUE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(_queueCache, null, 2));
    fs.renameSync(tmpFile, QUEUE_FILE);
  } catch (e) {
    console.error('❌ [PERSISTENCE] Error writing cache:', e.message);
  }
}

/**
 * Loads the queue backup for a guild
 * @param {string} guildId - Guild ID
 * @returns {object|null} - Queue data or null if doesn't exist
 */
export function loadQueueBackup(guildId) {
  const data = _getQueueCache();
  const backup = data[guildId];
  if (!backup) return null;

  // Validate structure
  if (!Array.isArray(backup.songs)) backup.songs = [];
  if (!Array.isArray(backup.history)) backup.history = [];
  if (typeof backup.playIndex !== 'number' || backup.playIndex < 0) backup.playIndex = 0;

  // Filter invalid songs
  backup.songs = backup.songs.filter(s => s && typeof s === 'object' && s.url && s.title);
  backup.history = backup.history.filter(s => s && typeof s === 'object' && s.url && s.title);

  // Ensure playIndex is within bounds
  if (backup.songs.length > 0 && backup.playIndex >= backup.songs.length) {
    backup.playIndex = backup.songs.length - 1;
  }

  return backup;
}

/**
 * Saves the queue backup for a guild
 * @param {string} guildId - Guild ID
 * @param {Array} songs - Array of songs in queue
 * @param {Array} history - Array of history
 * @param {number} playIndex - Current playback index
 * @param {boolean} isPaused - Pause state
 * @param {boolean} loopEnabled - Loop state
 * @param {boolean} fadeEnabled - Crossfade state
 * @param {string|null} currentDeckLoaded - URL of song loaded on current deck
 * @param {string|null} dashboardMessageId - ID of dashboard embed message
 * @param {string|null} textChannelId - ID of text channel where dashboard is
 */
export function saveQueueBackup(guildId, songs, history, playIndex = 0, isPaused = false, loopEnabled = false, fadeEnabled = false, currentDeckLoaded = null, dashboardMessageId = null, textChannelId = null) {
  try {
    if ((!songs || songs.length === 0) && (!history || history.length === 0)) {
      deleteQueueBackup(guildId);
      return;
    }
    const data = _getQueueCache();
    const mapSong = s => ({
      title: s.title,
      url: s.url,
      thumbnail: s.thumbnail,
      isLive: s.isLive,
      requester: s.requester,
      duration: s.duration || 0
    });
    const safeSongs = songs ? songs.filter(s => s && s.title).map(mapSong) : [];
    const safeHistory = history ? history.filter(s => s && s.title).map(mapSong) : [];
    data[guildId] = {
      songs: safeSongs,
      history: safeHistory,
      playIndex: playIndex || 0,
      isPaused,
      loopEnabled,
      fadeEnabled,
      currentDeckLoaded,
      dashboardMessageId,
      textChannelId
    };
    _flushQueueCache();
  } catch (e) {
    console.error('❌ [PERSISTENCE] Error saving backup:', e.message);
  }
}

/**
 * Deletes the queue backup for a guild
 * @param {string} guildId - Guild ID
 */
export function deleteQueueBackup(guildId) {
  try {
    const data = _getQueueCache();
    if (data[guildId]) {
      delete data[guildId];
      _flushQueueCache();
    }
  } catch (e) {
    console.error('❌ [PERSISTENCE] Error deleting backup:', e.message);
  }
}

// ─── Debounce for saveQueueState ────────────────────────────
const _saveTimers = new Map();   // guildId -> timeoutId
const _savePending = new Map();  // guildId -> serverQueue reference
const _lastSaveTime = new Map(); // guildId -> timestamp
const SAVE_DEBOUNCE_MS = 2000;

function _doSaveQueueState(guildId, serverQueue) {
  saveQueueBackup(
    guildId,
    serverQueue.songs,
    serverQueue.history,
    serverQueue.playIndex || 0,
    serverQueue.isPaused,
    serverQueue.loopEnabled,
    serverQueue.fadeEnabled,
    serverQueue.currentDeckLoaded,
    serverQueue.dashboardMessageId || null,
    serverQueue.textChannelId || null
  );
}

/**
 * Saves the current queue state with debounce (max 1 write every 2s per guild).
 * @param {string} guildId - Guild ID
 * @param {object} serverQueue - Server queue object
 */
export function saveQueueState(guildId, serverQueue) {
  if (!serverQueue) return;

  _savePending.set(guildId, serverQueue);

  const now = Date.now();
  const lastSave = _lastSaveTime.get(guildId) || 0;

  if (now - lastSave >= SAVE_DEBOUNCE_MS) {
    // Enough time passed, write immediately
    if (_saveTimers.has(guildId)) {
      clearTimeout(_saveTimers.get(guildId));
      _saveTimers.delete(guildId);
    }
    _savePending.delete(guildId);
    _lastSaveTime.set(guildId, now);
    _doSaveQueueState(guildId, serverQueue);
  } else if (!_saveTimers.has(guildId)) {
    // Too soon, schedule deferred write
    const delay = SAVE_DEBOUNCE_MS - (now - lastSave);
    _saveTimers.set(guildId, setTimeout(() => {
      _saveTimers.delete(guildId);
      const sq = _savePending.get(guildId);
      _savePending.delete(guildId);
      if (sq) {
        _lastSaveTime.set(guildId, Date.now());
        _doSaveQueueState(guildId, sq);
      }
    }, delay));
  }
  // If timer already pending, _savePending already updated with latest state
}

/**
 * Saves immediately bypassing debounce (for shutdown/crash).
 * @param {string} guildId
 * @param {object} serverQueue
 */
export function saveQueueStateImmediate(guildId, serverQueue) {
  if (!serverQueue) return;
  if (_saveTimers.has(guildId)) {
    clearTimeout(_saveTimers.get(guildId));
    _saveTimers.delete(guildId);
  }
  _savePending.delete(guildId);
  _doSaveQueueState(guildId, serverQueue);
}

/**
 * Flush all pending saves (call during shutdown).
 */
export function flushPendingSaves() {
  for (const [, timer] of _saveTimers) clearTimeout(timer);
  _saveTimers.clear();
  for (const [guildId, sq] of _savePending) {
    _doSaveQueueState(guildId, sq);
  }
  _savePending.clear();
}

/**
 * Cleans up timer and pending state for a guild (to call on guildDelete)
 */
export function cleanupGuild(guildId) {
  if (_saveTimers.has(guildId)) {
    clearTimeout(_saveTimers.get(guildId));
    _saveTimers.delete(guildId);
  }
  _savePending.delete(guildId);
  _lastSaveTime.delete(guildId);
}
