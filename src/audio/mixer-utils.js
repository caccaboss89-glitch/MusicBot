/**
 * Centralized utility functions for mixer manipulation
 */

import { call as bridgeCall } from './audio-bridge.js';

/**
 * Safely invokes a function on mixer with error tracking and context
 * Automatically handles dead process errors and notifies crash recovery
 * @param {object} serverQueue - Server queue object
 * @param {string} guildId - Guild ID
 * @param {function} fn - Function to invoke on mixer
 * @param {string} context - Operation context (for logging)
 * @returns {object} - { success: boolean, error?: Error }
 */
function safeMixerInvoke(serverQueue, guildId, fn, context = 'unknown') {
  try {
    if (!serverQueue || !serverQueue.mixer) {
      console.warn(`⚠️  [MIXER-INVOKE] Mixer not available (${context}) - guild=${guildId}`);
      try { bridgeCall('handleMixerCrash', guildId, `no_mixer_${context}`); } catch { }
      return { success: false, error: new Error('No mixer') };
    }

    if (typeof serverQueue.mixer.isProcessAlive !== 'function' || !serverQueue.mixer.isProcessAlive()) {
      console.warn(`⚠️  [MIXER-INVOKE] Mixer process dead (${context}) - guild=${guildId}`);
      try { bridgeCall('handleMixerCrash', guildId, `mixer_dead_${context}`); } catch { }
      return { success: false, error: new Error('Mixer process dead') };
    }

    try {
      fn();
      return { success: true };
    } catch (e) {
      console.error(`❌ [MIXER-INVOKE] Error during invocation (${context}) - guild=${guildId}:`, e.message);
      console.error('Stack:', e.stack);
      try { bridgeCall('handleMixerCrash', guildId, `mixer_call_error_${context}`); } catch { }
      return { success: false, error: e };
    }
  } catch (e) {
    console.error(`❌ [MIXER-INVOKE] Wrapper error (${context}) - guild=${guildId}:`, e.message);
    try { bridgeCall('handleMixerCrash', guildId, `mixer_exception_${context}`); } catch { }
    return { success: false, error: e };
  }
}

export {
  safeMixerInvoke
};
