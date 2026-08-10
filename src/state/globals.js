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

// Periodic cleanup of interaction cooldowns to prevent memory leak (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of interactionCooldowns) {
    if (now - timestamp > COOLDOWN_TTL_MS) interactionCooldowns.delete(key);
  }
}, 5 * 60 * 1000);
