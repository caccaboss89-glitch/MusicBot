/**
 * src/state/globals.js
 * Centralized global state for the bot
 * All Maps and variables shared between modules
 */

// ─── QUEUE FOR GUILD ───────────────────────────────────────
// Map<guildId, serverQueue>
export const queue = new Map();

// ─── DISCONNECTION TIMER ───────────────────────────────────
// Map<guildId, timeoutId> - Timer to disconnect bot when alone
export const disconnectTimers = new Map();

// --- INTERACTION COOLDOWN ---
// Map<"guildId_userId", timestamp> - Prevents button spam, per user per guild
export const interactionCooldowns = new Map();
const COOLDOWN_TTL_MS = 60000;

/**
 * Drops the cooldown entries of a guild (bot removed from that server).
 * @param {string} guildId
 */
export function clearGuildCooldowns(guildId) {
  const prefix = `${guildId}_`;
  for (const key of interactionCooldowns.keys()) {
    if (key.startsWith(prefix)) interactionCooldowns.delete(key);
  }
}

// NOTE: Pending skips are managed internally by SkipManager (state versioning locks).

// --- MIXER GENERATION ---
// Global counter to invalidate events from old mixers
let globalMixerGeneration = 0;

/**
 * Increment and return the new mixer generation
 * @returns {number} New generation
 */
export function getNextMixerGeneration() {
  return ++globalMixerGeneration;
}

// ─── GLOBAL PLAYBACK SESSION ───────────────────
// Only one guild may be playing at a time in the whole process: every playback
// owns a Rust engine that can hold two decks' worth of decoded audio, and this
// host shares its RAM with three other bots.
let playbackSessionGuildId = null;
let playbackSessionClaimedAt = 0;

// A claim turns into a running engine within a second or two (voice connection
// plus mixer startup). Past this the holder is clearly not playing, and the slot
// is handed over rather than staying stuck if a release was ever missed.
const SESSION_CLAIM_GRACE_MS = 30000;

/**
 * True when the guild holding the session has nothing playing and has had long
 * enough to start.
 * @param {string} holderId
 * @returns {boolean}
 */
function isSessionStale(holderId) {
  const sq = queue.get(holderId);
  if (!sq) return true;
  if (sq.mixer || sq.currentDeckLoaded || sq.mixerStarting) return false;
  return Date.now() - playbackSessionClaimedAt > SESSION_CLAIM_GRACE_MS;
}

/**
 * Claims the single playback slot for a guild.
 * Re-claiming it from the guild that already holds it always succeeds.
 * @param {string} guildId
 * @returns {boolean} false when another guild is playing
 */
export function acquirePlaybackSession(guildId) {
  if (playbackSessionGuildId !== null && playbackSessionGuildId !== guildId) {
    if (!isSessionStale(playbackSessionGuildId)) return false;
    console.warn(`⚠️ [SESSION] Slot held by guild ${playbackSessionGuildId} with nothing playing, reclaiming`);
  }
  if (playbackSessionGuildId !== guildId) {
    console.log(`▶️ [SESSION] Playback slot taken by guild ${guildId}`);
  }
  playbackSessionGuildId = guildId;
  playbackSessionClaimedAt = Date.now();
  return true;
}

/**
 * Gives the playback slot back. A guild that does not hold it is ignored, so a
 * late teardown cannot steal the slot from whoever started playing meanwhile.
 * @param {string} guildId
 */
export function releasePlaybackSession(guildId) {
  if (playbackSessionGuildId !== guildId) return;
  playbackSessionGuildId = null;
  playbackSessionClaimedAt = 0;
  console.log(`⏹️ [SESSION] Playback slot released by guild ${guildId}`);
}

/**
 * The guild currently allowed to play, if any.
 * @returns {string|null}
 */
export function getPlaybackSessionGuildId() {
  return playbackSessionGuildId;
}

/**
 * True when `guildId` may start playing: either it already holds the slot or
 * the slot is free. Read-only, so a check can be done before replying to a user
 * without claiming anything.
 * @param {string} guildId
 * @returns {boolean}
 */
export function canStartPlayback(guildId) {
  return playbackSessionGuildId === null
    || playbackSessionGuildId === guildId
    || isSessionStale(playbackSessionGuildId);
}

// Periodic cleanup of interaction cooldowns to prevent memory leak (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of interactionCooldowns) {
    if (now - timestamp > COOLDOWN_TTL_MS) interactionCooldowns.delete(key);
  }
}, 5 * 60 * 1000);
