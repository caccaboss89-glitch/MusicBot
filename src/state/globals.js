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
// Map<guildId, Map<interactionId, timestamp>> - Prevents button spam
export const interactionCooldowns = new Map();

// NOTE: Pending skips are managed internally by SkipManager v3 (skipLock).

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
    if (now - timestamp > 60000) interactionCooldowns.delete(key);
  }
}, 5 * 60 * 1000);
