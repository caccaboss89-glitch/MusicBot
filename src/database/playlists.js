/**
 * Playlist database management (server and user)
 * Supports multiple playlists per user with automatic legacy format migration
 */

import fs from 'fs';
import { PLAYLIST_FILE } from '../../config/index.js';
import { safeJSONParse } from '../utils/sanitize.js';
import { DEFAULT_PLAYLIST_NAME, MAX_PLAYLIST_NAME_LENGTH } from '../../config/index.js';

// ─── Singleton cache to avoid read-modify-write race condition ──────
let _dbCache = null;
let _dbDirty = false;
let _dbFlushTimer = null;
const DB_FLUSH_INTERVAL_MS = 2000; // Flush to disk every 2 seconds if dirty

/**
 * Loads the playlist database
 * @returns {object} - { server: [], users: {} }
 */
function loadDatabase() {
  if (_dbCache) return _dbCache;
  _dbCache = safeJSONParse(PLAYLIST_FILE, { server: [], users: {} });
  return _dbCache;
}

/**
 * Saves the playlist database
 * Marks cache as dirty and schedules a disk flush.
 * @param {object} data - Data to save (must be the same cache reference)
 */
function saveDatabase(data) {
  _dbCache = data;
  _dbDirty = true;
  if (!_dbFlushTimer) {
    _dbFlushTimer = setTimeout(() => {
      _flushToFile();
    }, DB_FLUSH_INTERVAL_MS);
  }
}

/**
 * Forces immediate write to disk (for shutdown).
 */
function flushDatabaseSync() {
  if (_dbFlushTimer) {
    clearTimeout(_dbFlushTimer);
    _dbFlushTimer = null;
  }
  _flushToFile();
}

function _flushToFile() {
  _dbFlushTimer = null;
  if (!_dbDirty || !_dbCache) return;
  try {
    const tmpFile = PLAYLIST_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(_dbCache, null, 2));
    fs.renameSync(tmpFile, PLAYLIST_FILE);
    _dbDirty = false;
  } catch (e) {
    console.error('❌ [DATABASE] Error saving playlist:', e.message);
  }
}

/**
 * Migrates user data from legacy format (array) to new format (object with playlists).
 * If data is already in new format, returns it unchanged.
 * @param {Array|Object} userData - User data (legacy array or new object)
 * @returns {Object} - { playlists: { Generale: [...], ... }, activePlaylist: 'Generale' }
 */
function migrateUserData(userData) {
  if (Array.isArray(userData)) {
    // Legacy format: single array → becomes "Generale" playlist
    return { playlists: { [DEFAULT_PLAYLIST_NAME]: userData }, activePlaylist: DEFAULT_PLAYLIST_NAME };
  }
  if (userData && typeof userData === 'object' && userData.playlists) {
    // Already in new format — ensure 'Generale' exists
    if (!userData.playlists[DEFAULT_PLAYLIST_NAME]) {
      userData.playlists[DEFAULT_PLAYLIST_NAME] = [];
    }
    if (!userData.activePlaylist || !userData.playlists[userData.activePlaylist]) {
      userData.activePlaylist = DEFAULT_PLAYLIST_NAME;
    }
    return userData;
  }
  // Invalid data → empty structure
  return { playlists: { [DEFAULT_PLAYLIST_NAME]: [] }, activePlaylist: DEFAULT_PLAYLIST_NAME };
}

/**
 * Gets user data in new format, with automatic migration.
 * Modifies db.users[userId] in-place if necessary.
 * @param {Object} db - Complete database
 * @param {string} userId - Discord user ID
 * @returns {Object} - { playlists: {...}, activePlaylist: '...' }
 */
function getUserData(db, userId) {
  if (!db.users) db.users = {};
  if (!db.users[userId]) {
    db.users[userId] = { playlists: { [DEFAULT_PLAYLIST_NAME]: [] }, activePlaylist: DEFAULT_PLAYLIST_NAME };
  } else {
    db.users[userId] = migrateUserData(db.users[userId]);
  }
  return db.users[userId];
}

/**
 * Gets the song array for a specific user playlist.
 * @param {Object} db - Complete database
 * @param {string} userId - Discord user ID
 * @param {string} playlistName - Playlist name
 * @returns {Array} - Song array
 */
function getUserPlaylist(db, userId, playlistName) {
  const data = getUserData(db, userId);
  return data.playlists[playlistName] || [];
}

/**
 * Gets the active playlist name for a user.
 * @param {Object} db - Complete database
 * @param {string} userId - Discord user ID
 * @returns {string} - Active playlist name
 */
function getActivePlaylistName(db, userId) {
  const data = getUserData(db, userId);
  return data.activePlaylist || DEFAULT_PLAYLIST_NAME;
}

/**
 * Sets the active playlist for a user.
 * @param {Object} db - Complete database
 * @param {string} userId - Discord user ID
 * @param {string} name - Playlist name to activate
 */
function setActivePlaylist(db, userId, name) {
  const data = getUserData(db, userId);
  if (data.playlists[name]) {
    data.activePlaylist = name;
  }
}

/**
 * Gets the list of all playlist names for a user.
 * The 'Generale' playlist is always first.
 * @param {Object} db - Complete database
 * @param {string} userId - Discord user ID
 * @returns {string[]} - Playlist names
 */
function getUserPlaylistNames(db, userId) {
  const data = getUserData(db, userId);
  const names = Object.keys(data.playlists);
  // Ensure Generale is always first
  const sorted = [DEFAULT_PLAYLIST_NAME, ...names.filter(n => n !== DEFAULT_PLAYLIST_NAME)];
  return sorted;
}

/**
 * Validates a playlist name.
 * @param {string} name - Name to validate
 * @returns {{ valid: boolean, error?: string }} - Validation result
 */
function validatePlaylistName(name) {
  if (!name || typeof name !== 'string') return { valid: false, error: 'The name cannot be empty.' };
  const trimmed = name.trim();
  if (trimmed.length === 0) return { valid: false, error: 'The name cannot be empty.' };
  if (trimmed.length > MAX_PLAYLIST_NAME_LENGTH) return { valid: false, error: `The name cannot exceed ${MAX_PLAYLIST_NAME_LENGTH} characters.` };
  if (trimmed.includes('_')) return { valid: false, error: 'The name cannot contain underscores (_).' };
  // Allow alphanumeric, spaces, hyphens, accents and other common unicode characters
  const nameRegex = new RegExp(`^[^\\n\\r_]{1,${MAX_PLAYLIST_NAME_LENGTH}}$`);
  if (!nameRegex.test(trimmed)) return { valid: false, error: 'The name contains invalid characters.' };
  return { valid: true };
}

export {
  loadDatabase,
  saveDatabase,
  flushDatabaseSync,
  migrateUserData,
  getUserData,
  getUserPlaylist,
  getActivePlaylistName,
  setActivePlaylist,
  getUserPlaylistNames,
  validatePlaylistName
};
