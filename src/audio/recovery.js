/**
 * src/audio/recovery.js
 *
 * Mixer crash detection and recovery.
 * Owns the per-guild crash bookkeeping so `playback.js` only has to ask
 * "how long must I still wait before starting a new mixer?".
 */

import fs from 'fs';
import path from 'path';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { queue } from '../state/globals.js';
import { isBotAloneInChannel, scheduleDisconnectIfAlone, getCurrentSong, clearDeckBindings } from '../queue/QueueManager.js';
import { commandQueue } from './SerialQueue.js';
import { playSong } from './playback.js';
import { stopAllListeners } from '../database/stats.js';
import { ROOT_DIR } from '../../config/index.js';

// Resolved from the project root, so the log lands in the same place no matter
// which working directory the bot was started from.
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

// Timestamp of the last crash per guild, to avoid restarting into a crash loop
const lastMixerCrashTime = new Map();
const MIXER_CRASH_COOLDOWN_MS = 1500;
const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * Records that the mixer of a guild has just crashed.
 * @param {string} guildId
 */
function recordMixerCrashTime(guildId) {
  lastMixerCrashTime.set(guildId, Date.now());
}

/**
 * How long the caller must still wait before starting a new mixer.
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

/**
 * Appends a crash context to the post-mortem log file.
 * @param {object} crashContext
 */
function logCrashToFile(crashContext) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOGS_DIR, 'mixer-crashes.log'), `${JSON.stringify(crashContext)}\n`);
  } catch { /* diagnostics only: never let logging break recovery */ }
}

/**
 * Handles the death of a Rust mixer process: logs the context, then either
 * restarts playback or gives up and disconnects.
 * @param {string} guildId
 * @param {string} reason - Why the mixer is considered dead
 */
async function handleMixerCrash(guildId, reason) {
  try {
    const sq = queue.get(guildId);
    if (!sq) {
      console.error(`🚨 [MIXER-CRASH] guild=${guildId} reason=${reason} - Queue not found`);
      return;
    }

    // ── STRUCTURED DEBUG CONTEXT ──
    const currentSongData = getCurrentSong(sq);
    const crashContext = {
      timestamp: new Date().toISOString(),
      guildId,
      reason,
      currentSong: currentSongData?.title || 'N/A',
      playIndex: sq.playIndex || 0,
      totalSongs: sq.songs?.length || 0,
      currentDeck: sq.currentDeck || 'unknown',
      currentDeckLoaded: sq.currentDeckLoaded?.substring(0, 60) || 'N/A',
      nextDeckLoaded: sq.nextDeckLoaded?.substring(0, 60) || 'N/A',
      isPaused: sq.isPaused || false,
      fadeEnabled: sq.fadeEnabled || false,
      mixerGeneration: sq.mixerGeneration || 'N/A',
      connectionStatus: sq.connection?.state?.status || 'disconnected',
      recoveryAttempts: sq.crashRecoveryAttempts || 0,
      voiceChannelMembersCount: sq.voiceChannel?.members?.size || 0
    };

    console.error(`🚨 [MIXER-CRASH] ${JSON.stringify(crashContext)}`);
    logCrashToFile(crashContext);

    // ── STATS: stop all listener timers (recovery restarts them in playSong) ──
    stopAllListeners(guildId);

    // If the mixer was terminated on purpose (endQueue), do not restart it
    if (sq.intentionalKill) {
      sq.intentionalKill = false;
      console.log('ℹ️  [CRASH-RECOVERY] Intentional termination detected, skip recovery');
      return;
    }

    recordMixerCrashTime(guildId);

    sq.crashRecoveryAttempts = (sq.crashRecoveryAttempts || 0) + 1;
    console.warn(`⚠️  [CRASH-RECOVERY] Attempt #${sq.crashRecoveryAttempts} for guild=${guildId}`);

    if (sq.crashRecoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
      console.error(`❌ [CRASH-RECOVERY] Too many recovery attempts (${sq.crashRecoveryAttempts}), disconnecting...`);
      scheduleDisconnectIfAlone(sq, 0);
      return;
    }

    if (isBotAloneInChannel(sq)) {
      console.log('ℹ️  [CRASH-RECOVERY] Bot alone in channel, skip recovery');
      scheduleDisconnectIfAlone(sq, 0);
      return;
    }

    // Kill mixer and reset deck state
    try { if (sq.mixer) sq.mixer.kill(); } catch { /* already dead */ }
    sq.mixer = null;
    sq.currentDeck = null;
    sq.currentDeckLoaded = null;
    sq.nextDeckLoaded = null;
    sq.nextDeckTarget = null;
    clearDeckBindings(sq);

    // Drop commands that would otherwise wait for a now-dead mixer
    commandQueue.flushPending(guildId, `Mixer crash: ${reason}`);

    // Attempt restart if the voice connection is still usable
    const connReady = sq.connection?.state?.status === VoiceConnectionStatus.Ready;
    if (!connReady || !sq.voiceChannel) {
      console.log('ℹ️  [CRASH-RECOVERY] Voice connection not ready, skip recovery');
      scheduleDisconnectIfAlone(sq, 0);
      return;
    }

    const delayMs = 500 + (sq.crashRecoveryAttempts * 500);
    console.log(`⏳ [CRASH-RECOVERY] Scheduling playSong restart in ${delayMs}ms`);
    setTimeout(() => {
      playSong(guildId).catch(e => {
        console.error(`❌ [CRASH-RECOVERY] playSong restart error (guild=${guildId}):`, e);
      });
    }, delayMs);
  } catch (e) {
    console.error('❌ [CRASH-RECOVERY] Fatal error in handleMixerCrash:', e);
  }
}

export {
  handleMixerCrash,
  recordMixerCrashTime,
  getMixerCrashCooldownMs,
  cleanupRecoveryState
};
