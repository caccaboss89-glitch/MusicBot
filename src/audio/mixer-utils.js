/**
 * Centralized utility functions for mixer manipulation
 */

import { handleMixerCrash } from './recovery.js';

/**
 * Safely invokes a function on the mixer, reporting a dead or missing process
 * to the crash recovery instead of throwing.
 * @param {object} serverQueue - Server queue object
 * @param {string} guildId - Guild ID
 * @param {function} fn - Function to invoke on the mixer
 * @param {string} [context='unknown'] - Operation context (for logging)
 * @returns {{success: boolean, error?: Error}}
 */
function safeMixerInvoke(serverQueue, guildId, fn, context = 'unknown') {
  if (!serverQueue || !serverQueue.mixer) {
    console.warn(`⚠️  [MIXER-INVOKE] Mixer not available (${context}) - guild=${guildId}`);
    handleMixerCrash(guildId, `no_mixer_${context}`);
    return { success: false, error: new Error('No mixer') };
  }

  if (typeof serverQueue.mixer.isProcessAlive !== 'function' || !serverQueue.mixer.isProcessAlive()) {
    console.warn(`⚠️  [MIXER-INVOKE] Mixer process dead (${context}) - guild=${guildId}`);
    handleMixerCrash(guildId, `mixer_dead_${context}`);
    return { success: false, error: new Error('Mixer process dead') };
  }

  try {
    fn();
    return { success: true };
  } catch (e) {
    console.error(`❌ [MIXER-INVOKE] Error during invocation (${context}) - guild=${guildId}:`, e.message);
    handleMixerCrash(guildId, `mixer_call_error_${context}`);
    return { success: false, error: e };
  }
}

export { safeMixerInvoke };
