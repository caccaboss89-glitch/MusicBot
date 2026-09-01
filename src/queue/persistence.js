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

// ─── Disk writes ───────────────────────────────────────────
// The cache holds every queued song of every guild, so a full queue serializes
// to tens of megabytes. Writing that synchronously on every queue change would
// block the event loop for the whole write, so the normal path writes
// asynchronously and collapses the writes: while one is in flight the next is
// only marked pending, and runs once with the latest content when the current
// one lands. Shutdown still writes synchronously - the process exits right
// after and would never let a promise settle.
// The serialized form is compact (no indentation): it is machine-read only, and
// the indentation was a third of the bytes.
let _writeInFlight = false;
let _writePending = false;
// Which write's content is on disk. A synchronous write during shutdown must
// not be overwritten by an async one started before it.
let _writeSeq = 0;
let _landedSeq = 0;
// Two fixed staging names instead of one per write: the two paths never write
// at the same time, and a crash can leave behind at most these two files.
const ASYNC_TMP_FILE = QUEUE_FILE + '.async.tmp';
const SYNC_TMP_FILE = QUEUE_FILE + '.tmp';

async function _writeCache() {
  while (true) {
    const seq = ++_writeSeq;
    const payload = JSON.stringify(_queueCache);
    try {
      await fs.promises.writeFile(ASYNC_TMP_FILE, payload);
      if (seq < _landedSeq) {
        // A newer snapshot already landed: this one is stale
        await fs.promises.unlink(ASYNC_TMP_FILE).catch(() => { });
      } else {
        await fs.promises.rename(ASYNC_TMP_FILE, QUEUE_FILE);
        _landedSeq = seq;
      }
    } catch (e) {
      console.error('❌ [PERSISTENCE] Error writing cache:', e.message);
      await fs.promises.unlink(ASYNC_TMP_FILE).catch(() => { });
    }
    if (!_writePending) return;
    _writePending = false;
  }
}

/**
 * Persists the cache to disk.
 * @param {boolean} sync - Write before returning (shutdown/crash paths only)
 */
function _flushQueueCache(sync) {
  if (_queueCache === null) return;

  if (sync) {
    const seq = ++_writeSeq;
    try {
      fs.writeFileSync(SYNC_TMP_FILE, JSON.stringify(_queueCache));
      fs.renameSync(SYNC_TMP_FILE, QUEUE_FILE);
      _landedSeq = seq;
    } catch (e) {
      console.error('❌ [PERSISTENCE] Error writing cache:', e.message);
      try { fs.unlinkSync(SYNC_TMP_FILE); } catch { /* nothing was written */ }
    }
    return;
  }

  if (_writeInFlight) {
    _writePending = true;
    return;
  }
  _writeInFlight = true;
  _writeCache().finally(() => { _writeInFlight = false; });
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
  if (typeof backup.playIndex !== 'number' || backup.playIndex < 0) backup.playIndex = 0;

  // Filter invalid songs
  backup.songs = backup.songs.filter(s => s && typeof s === 'object' && s.url && s.title);

  // Ensure playIndex is within bounds
  if (backup.songs.length > 0 && backup.playIndex >= backup.songs.length) {
    backup.playIndex = backup.songs.length - 1;
  }

  return backup;
}

/**
 * Saves the queue backup for a guild.
 * Takes the whole queue rather than a long positional list, so a field can
 * never be persisted into the wrong slot.
 * @param {string} guildId - Guild ID
 * @param {object} serverQueue - Server queue to snapshot
 * @param {boolean} [sync=false] - Write to disk before returning
 */
export function saveQueueBackup(guildId, serverQueue, sync = false) {
  try {
    const songs = serverQueue.songs || [];
    if (songs.length === 0) {
      deleteQueueBackup(guildId, sync);
      return;
    }
    const data = _getQueueCache();
    data[guildId] = {
      songs: songs.filter(s => s && s.title).map(s => ({
        title: s.title,
        url: s.url,
        thumbnail: s.thumbnail,
        isLive: s.isLive,
        requester: s.requester,
        duration: s.duration || 0
      })),
      playIndex: serverQueue.playIndex || 0,
      isPaused: !!serverQueue.isPaused,
      loopEnabled: !!serverQueue.loopEnabled,
      fadeEnabled: !!serverQueue.fadeEnabled,
      currentDeckLoaded: serverQueue.currentDeckLoaded || null,
      dashboardMessageId: serverQueue.dashboardMessageId || null,
      textChannelId: serverQueue.textChannelId || null
    };
    _flushQueueCache(sync);
  } catch (e) {
    console.error('❌ [PERSISTENCE] Error saving backup:', e.message);
  }
}

/**
 * Deletes the queue backup for a guild
 * @param {string} guildId - Guild ID
 * @param {boolean} [sync=false] - Write to disk before returning
 */
export function deleteQueueBackup(guildId, sync = false) {
  try {
    const data = _getQueueCache();
    if (data[guildId]) {
      delete data[guildId];
      _flushQueueCache(sync);
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
const MAX_SAVE_DEBOUNCE_MS = 30000;
// Songs above which the debounce starts growing with the queue
const SAVE_DEBOUNCE_FREE_SONGS = 500;

/**
 * Debounce for a queue: snapshotting it costs time proportional to its length,
 * so a very long queue is written less often. All that is traded away is how
 * recent the backup is if the process dies.
 * @param {object} serverQueue - Server queue about to be saved
 * @returns {number} - Milliseconds between two writes for this guild
 */
function _saveDebounceMs(serverQueue) {
  const songs = serverQueue.songs?.length || 0;
  if (songs <= SAVE_DEBOUNCE_FREE_SONGS) return SAVE_DEBOUNCE_MS;
  return Math.min(MAX_SAVE_DEBOUNCE_MS, Math.round(SAVE_DEBOUNCE_MS * songs / SAVE_DEBOUNCE_FREE_SONGS));
}

function _doSaveQueueState(guildId, serverQueue, sync = false) {
  saveQueueBackup(guildId, serverQueue, sync);
}

/**
 * Saves the current queue state with debounce (at most one write per guild
 * every _saveDebounceMs()).
 * @param {string} guildId - Guild ID
 * @param {object} serverQueue - Server queue object
 */
export function saveQueueState(guildId, serverQueue) {
  if (!serverQueue) return;

  _savePending.set(guildId, serverQueue);

  const now = Date.now();
  const lastSave = _lastSaveTime.get(guildId) || 0;
  const debounceMs = _saveDebounceMs(serverQueue);

  if (now - lastSave >= debounceMs) {
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
    const delay = debounceMs - (now - lastSave);
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
  _doSaveQueueState(guildId, serverQueue, true);
}

/**
 * Flush all pending saves (call during shutdown).
 */
export function flushPendingSaves() {
  for (const [, timer] of _saveTimers) clearTimeout(timer);
  _saveTimers.clear();
  for (const [guildId, sq] of _savePending) {
    _doSaveQueueState(guildId, sq, true);
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
