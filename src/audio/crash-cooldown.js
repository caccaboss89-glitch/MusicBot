/**
 * src/audio/crash-cooldown.js
 *
 * When each guild's mixer last died. Kept in its own leaf module because both
 * the crash handler and the teardown path need it, and neither should have to
 * import the other just to reach it.
 */

const lastMixerCrashTime = new Map(); // guildId -> timestamp of the last crash
const MIXER_CRASH_COOLDOWN_MS = 1500;

/**
 * Records that the mixer of a guild has just crashed.
 * @param {string} guildId
 */
function recordMixerCrashTime(guildId) {
  lastMixerCrashTime.set(guildId, Date.now());
}

/**
 * How long the caller must still wait before starting a new mixer, so a mixer
 * that dies on startup cannot be respawned into a tight crash loop.
 * @param {string} guildId
 * @returns {number} Milliseconds left of the cooldown (0 if none)
 */
function getMixerCrashCooldownMs(guildId) {
  const elapsed = Date.now() - (lastMixerCrashTime.get(guildId) || 0);
  return Math.max(0, MIXER_CRASH_COOLDOWN_MS - elapsed);
}

/**
 * Forgets the crash history of a guild (disconnect, bot removed from server).
 * @param {string} guildId
 */
function cleanupRecoveryState(guildId) {
  lastMixerCrashTime.delete(guildId);
}

export { recordMixerCrashTime, getMixerCrashCooldownMs, cleanupRecoveryState };
