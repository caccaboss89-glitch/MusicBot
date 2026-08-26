/**
 * src/audio/recovery.js
 *
 * Mixer crash detection and recovery: decides whether a dead mixer is worth
 * restarting, and restarts playback when it is.
 */

import path from 'path';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { queue } from '../state/globals.js';
import { isBotAloneInChannel, getCurrentSong } from '../queue/QueueManager.js';
import { playSong } from './playback.js';
import { stopGuildAudio, scheduleDisconnectIfAlone } from './teardown.js';
import { recordMixerCrashTime } from './crash-cooldown.js';
import { stopAllListeners } from '../database/stats.js';
import { ROOT_DIR } from '../../config/index.js';
import { appendCapped } from '../utils/logfiles.js';

// Resolved from the project root, so the log lands in the same place no matter
// which working directory the bot was started from.
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * Appends a crash context to the post-mortem log file.
 * @param {object} crashContext
 */
function logCrashToFile(crashContext) {
  appendCapped(path.join(LOGS_DIR, 'mixer-crashes.log'), `${JSON.stringify(crashContext)}\n`);
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

    // If the mixer was terminated on purpose (endQueue, disconnect), do not restart it
    if (sq.intentionalKill) {
      sq.intentionalKill = false;
      console.log('ℹ️  [CRASH-RECOVERY] Intentional termination detected, skip recovery');
      return;
    }

    recordMixerCrashTime(guildId);

    sq.crashRecoveryAttempts = (sq.crashRecoveryAttempts || 0) + 1;
    console.warn(`⚠️  [CRASH-RECOVERY] Attempt #${sq.crashRecoveryAttempts} for guild=${guildId}`);

    // Tear down what the dead mixer left behind. The kill is NOT flagged as
    // intentional: the process already died on its own, and a leftover flag
    // would make the next genuine crash look deliberate and skip recovery.
    stopGuildAudio(sq, { reason: `Mixer crash: ${reason}`, intentional: false });

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

    // Attempt restart if the voice connection is still usable
    const connReady = sq.connection?.state?.status === VoiceConnectionStatus.Ready;
    if (!connReady || !sq.voiceChannel) {
      console.log('ℹ️  [CRASH-RECOVERY] Voice connection not ready, skip recovery');
      scheduleDisconnectIfAlone(sq, 0);
      return;
    }

    const delayMs = 500 + (sq.crashRecoveryAttempts * 500);
    console.log(`⏳ [CRASH-RECOVERY] Scheduling playSong restart in ${delayMs}ms`);
    // Tracked on the queue so any teardown in the meantime cancels it: an
    // untracked timer would restart playback, and rejoin the voice channel,
    // after the bot had already been told to leave.
    sq._recoveryTimer = setTimeout(() => {
      sq._recoveryTimer = null;
      playSong(guildId).catch(e => {
        console.error(`❌ [CRASH-RECOVERY] playSong restart error (guild=${guildId}):`, e);
      });
    }, delayMs);
  } catch (e) {
    console.error('❌ [CRASH-RECOVERY] Fatal error in handleMixerCrash:', e);
  }
}

export { handleMixerCrash };
