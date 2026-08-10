/**
 * Statistics system for the music bot
 * Tracks:
 * - Listening time per user (only when bot plays, not paused)
 * - "Add to playlist" interactions per user (server and personal)
 * - Global counters: songs started and completed
 */

import fs from 'fs';
import path from 'path';
import { STATS_FILE } from '../../config/paths.js';

// ─── In-memory map of active timers ──────────────────────
// guildId → Map<userId, startTimestamp>
const activeListeners = new Map();

// Static buffer for pending time (not yet written to disk)
const pendingTime = {};

// Periodic flush of pending time to reduce data loss on non-graceful crash
setInterval(() => {
  try { flushPendingAndSave(); } catch { }
}, 60 * 1000); // Every 60 seconds

// ─── Loading / Saving ──────────────────────────────

function getDefaultStats() {
  return {
    users: {},
    global: {
      songsStarted: 0,
      songsCompleted: 0,
      songPlays: {}
    },
    lastUpdated: null
  };
}

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const raw = fs.readFileSync(STATS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      // Ensure base structure
      if (!data.users) data.users = {};
      if (!data.global) data.global = { songsStarted: 0, songsCompleted: 0 };
      if (!data.global.songsStarted) data.global.songsStarted = 0;
      if (!data.global.songsCompleted) data.global.songsCompleted = 0;
      if (!data.global.songPlays) data.global.songPlays = {};
      return data;
    }
  } catch (e) {
    console.error('⚠️ [STATS] Error loading stats:', e.message);
  }
  return getDefaultStats();
}

function saveStats(data) {
  try {
    const dir = path.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    data.lastUpdated = new Date().toISOString();
    // Atomic write: write to temp file, then rename (prevents corruption on crash)
    const tmpFile = STATS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, STATS_FILE);
  } catch (e) {
    console.error('❌ [STATS] Error saving stats:', e.message);
  }
}

function ensureUser(data, userId, discordUser = null) {
  if (!data.users[userId]) {
    data.users[userId] = {
      listeningTimeMs: 0,
      serverPlaylistAdds: 0,
      personalPlaylistAdds: 0
    };
  }
  // Migration: ensure all fields
  const u = data.users[userId];
  if (typeof u.listeningTimeMs !== 'number') u.listeningTimeMs = 0;
  if (typeof u.serverPlaylistAdds !== 'number') u.serverPlaylistAdds = 0;
  if (typeof u.personalPlaylistAdds !== 'number') u.personalPlaylistAdds = 0;
  if (!u.songPlays) u.songPlays = {};

  // Add Discord info if provided
  if (discordUser) {
    u.username = discordUser.username;
    u.global_name = discordUser.globalName || null;
    u.avatar = discordUser.avatar;
    u.discriminator = discordUser.discriminator;
  }
  return u;
}

// ─── Listening timers ───────────────────────────────────────

/**
 * Start tracking listening time for a user in a guild.
 * If the user is already tracked, does nothing (avoids double counting).
 */
function startListening(guildId, userId) {
  if (!guildId || !userId) return;
  let guildMap = activeListeners.get(guildId);
  if (!guildMap) {
    guildMap = new Map();
    activeListeners.set(guildId, guildMap);
  }
  // If already tracked, ignore
  if (guildMap.has(userId)) return;
  guildMap.set(userId, Date.now());
}

/**
 * Stop tracking for a single user and accumulate time in in-memory stats.
 * Returns accumulated ms (or 0 if not tracked).
 * Does NOT save to disk — saving happens separately.
 */
function stopListening(guildId, userId) {
  if (!guildId || !userId) return 0;
  const guildMap = activeListeners.get(guildId);
  if (!guildMap || !guildMap.has(userId)) return 0;

  const startTime = guildMap.get(userId);
  guildMap.delete(userId);
  if (guildMap.size === 0) activeListeners.delete(guildId);

  const elapsed = Math.max(0, Date.now() - startTime);

  // Accumulate in stats file (load, update, save immediately NO — we do it in batch)
  // We use an intermediate buffer to avoid I/O for each single stop
  // Actual flush to disk happens in flushGuildAndSave or flushAllGuildsAndSave
  if (!pendingTime[userId]) pendingTime[userId] = 0;
  pendingTime[userId] += elapsed;

  return elapsed;
}


const MAX_LISTENER_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Remove orphaned listeners active for more than 24h (stale from crash/bug).
 */
function cleanupStaleListeners() {
  const now = Date.now();
  for (const [guildId, guildMap] of activeListeners) {
    for (const [userId, startTime] of guildMap) {
      if (now - startTime > MAX_LISTENER_AGE_MS) {
        guildMap.delete(userId);
      }
    }
    if (guildMap.size === 0) activeListeners.delete(guildId);
  }
}

/**
 * Start tracking for all humans in the bot's voice channel.
 * Should be called when bot starts playing or resumes from pause.
 */
function startAllListeners(guildId, voiceChannel) {
  if (!guildId || !voiceChannel || !voiceChannel.members) return;
  try {
    voiceChannel.members.forEach(member => {
      if (!member.user.bot) {
        startListening(guildId, member.user.id);
      }
    });
  } catch (e) {
    console.warn('⚠️ [STATS] Error in startAllListeners:', e.message);
  }
}

/**
 * Stop tracking for all active users in a guild.
 * Does NOT save to disk — only accumulates times in pending buffer.
 */
function stopAllListeners(guildId) {
  if (!guildId) return;
  const guildMap = activeListeners.get(guildId);
  if (!guildMap || guildMap.size === 0) return;

  // Copy keys before iterating (avoids modifications during iteration)
  const userIds = [...guildMap.keys()];
  for (const userId of userIds) {
    stopListening(guildId, userId);
  }
}

/**
 * Write all accumulated pending times to disk + save stats file.
 * Should be called on bot disconnect from channel or shutdown.
 */
function flushPendingAndSave() {
  try {
    // Clean stale listeners (active for >24h are definitely orphaned)
    cleanupStaleListeners();

    const pending = pendingTime;
    if (!pending || Object.keys(pending).length === 0) return;

    const data = loadStats();
    for (const [userId, ms] of Object.entries(pending)) {
      if (ms > 0) {
        ensureUser(data, userId);
        data.users[userId].listeningTimeMs += ms;
      }
    }
    saveStats(data);

    // Reset buffer
    for (const key of Object.keys(pendingTime)) {
      delete pendingTime[key];
    }
  } catch (e) {
    console.error('❌ [STATS] Error in flushPendingAndSave:', e.message);
  }
}

/**
 * Stop all active timers for a specific guild, then flush to disk.
 * Used when bot disconnects from a voice channel.
 */
function flushGuildAndSave(guildId) {
  stopAllListeners(guildId);
  flushPendingAndSave();
}

/**
 * Stop ALL active timers on ALL guilds, then flush to disk.
 * Used on program shutdown (SIGINT, uncaughtException).
 */
function flushAllGuildsAndSave() {
  try {
    const guildIds = [...activeListeners.keys()];
    for (const guildId of guildIds) {
      stopAllListeners(guildId);
    }
    flushPendingAndSave();
    console.log(`📊 [STATS] Complete flush of all guilds (${guildIds.length} active)`);
  } catch (e) {
    console.error('❌ [STATS] Error in flushAllGuildsAndSave:', e.message);
  }
}

// ─── Song playback tracking ────────────────────────

/**
 * Record song playback globally and for each listener
 * in the voice channel (used to calculate top 5 songs of the month).
 * @param {string} guildId
 * @param {{ url: string, title: string, thumbnail?: string }} songInfo
 * @param {object|null} voiceChannel - Discord voice channel (with .members)
 */
/**
 * Normalize a YouTube URL (including music.youtube.com links) to canonical form
 * video ID only. Used for stats keying (dedup independent of playlist/mix).
 */
function normalizeYoutubeUrl(url) {
  if (!url) return url;
  // Also supports music.youtube.com and m.youtube.com
  const match = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) return `https://www.youtube.com/watch?v=${match[1]}`;
  return url;
}

function recordSongPlay(guildId, songInfo, voiceChannel = null) {
  try {
    if (!songInfo || !songInfo.url) return;
    const url = normalizeYoutubeUrl(songInfo.url);
    const entry = {
      title: songInfo.title || 'Unknown',
      url,
      thumbnail: songInfo.thumbnail || null
    };

    const data = loadStats();

    // ── Global ──
    if (!data.global.songPlays[url]) {
      data.global.songPlays[url] = { ...entry, count: 0 };
    }
    data.global.songPlays[url].count++;
    data.global.songPlays[url].title = entry.title;
    if (entry.thumbnail) data.global.songPlays[url].thumbnail = entry.thumbnail;

    // ── Per user: all in voice channel ──
    if (voiceChannel && voiceChannel.members) {
      voiceChannel.members.forEach(member => {
        if (member.user.bot) return;
        const userId = member.user.id;
        ensureUser(data, userId, member.user);
        if (!data.users[userId].songPlays[url]) {
          data.users[userId].songPlays[url] = { ...entry, count: 0 };
        }
        data.users[userId].songPlays[url].count++;
        data.users[userId].songPlays[url].title = entry.title;
        if (entry.thumbnail) data.users[userId].songPlays[url].thumbnail = entry.thumbnail;
      });
    }

    saveStats(data);
  } catch (e) {
    console.error('⚠️ [STATS] Error in recordSongPlay:', e.message);
  }
}

/**
 * Calculate top N songs globally and per user, adding
 * `topSongs` fields to data object. Should be called before monthly archiving.
 * @param {object} data - Stats data (mutated in-place)
 * @param {number} limit - Number of top songs to keep (default: 5)
 * @returns {object} data with added topSongs
 */
function computeTopSongs(data, limit = 5) {
  const sortByCounts = plays =>
    Object.values(plays || {})
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map(({ title, url, thumbnail, count }) => ({ title, url, thumbnail, count }));

  data.global.topSongs = sortByCounts(data.global.songPlays);

  for (const userData of Object.values(data.users || {})) {
    userData.topSongs = sortByCounts(userData.songPlays);
  }

  return data;
}

// ─── Global song counters ──────────────────────────────

function incrementSongsStarted() {
  try {
    const data = loadStats();
    data.global.songsStarted = (data.global.songsStarted || 0) + 1;
    saveStats(data);
  } catch (e) {
    console.error('⚠️ [STATS] Error in incrementSongsStarted:', e.message);
  }
}

function incrementSongsCompleted() {
  try {
    const data = loadStats();
    data.global.songsCompleted = (data.global.songsCompleted || 0) + 1;
    saveStats(data);
  } catch (e) {
    console.error('⚠️ [STATS] Error in incrementSongsCompleted:', e.message);
  }
}

// ─── Playlist interaction counters ─────────────────────────

/**
 * Record a playlist addition (additions only, not removals).
 * @param {string} userId
 * @param {'server'|'personal'} type
 * @param {object} discordUser - Optional, user's Discord info
 */
function recordPlaylistAdd(userId, type, discordUser = null) {
  try {
    if (!userId || !type) return;
    const data = loadStats();
    ensureUser(data, userId, discordUser);
    if (type === 'server') {
      data.users[userId].serverPlaylistAdds = (data.users[userId].serverPlaylistAdds || 0) + 1;
    } else if (type === 'personal') {
      data.users[userId].personalPlaylistAdds = (data.users[userId].personalPlaylistAdds || 0) + 1;
    }
    saveStats(data);
  } catch (e) {
    console.error('⚠️ [STATS] Error in recordPlaylistAdd:', e.message);
  }
}

/**
 * Update Discord user information in statistics
 * @param {string} userId
 * @param {object} discordUser - Discord user object
 */
function updateUserDiscordInfo(userId, discordUser) {
  try {
    if (!userId || !discordUser) return;
    const data = loadStats();
    ensureUser(data, userId, discordUser);
    saveStats(data);
  } catch (e) {
    console.error('⚠️ [STATS] Error in updateUserDiscordInfo:', e.message);
  }
}

// ─── Debug / Utility ────────────────────────────────────────

/**
 * Return current state of active timers (for debug).
 */
function getActiveListenersDebug() {
  const result = {};
  activeListeners.forEach((guildMap, guildId) => {
    result[guildId] = {};
    guildMap.forEach((startTime, userId) => {
      result[guildId][userId] = {
        startTime: new Date(startTime).toISOString(),
        elapsedMs: Date.now() - startTime
      };
    });
  });
  return result;
}

export {
  // Caricamento
  loadStats,
  saveStats,

  // Timer ascolto
  startListening,
  stopListening,
  startAllListeners,
  stopAllListeners,
  flushGuildAndSave,
  flushAllGuildsAndSave,
  flushPendingAndSave,

  // Contatori canzoni
  incrementSongsStarted,
  incrementSongsCompleted,

  // Contatori playlist
  recordPlaylistAdd,

  // Info Discord
  updateUserDiscordInfo,

  // Tracciamento canzoni
  recordSongPlay,
  computeTopSongs,

  // Debug
  getActiveListenersDebug
};

export default {
  loadStats,
  saveStats,
  startListening,
  stopListening,
  startAllListeners,
  stopAllListeners,
  flushGuildAndSave,
  flushAllGuildsAndSave,
  flushPendingAndSave,
  incrementSongsStarted,
  incrementSongsCompleted,
  recordPlaylistAdd,
  updateUserDiscordInfo,
  recordSongPlay,
  computeTopSongs,
  getActiveListenersDebug
};
