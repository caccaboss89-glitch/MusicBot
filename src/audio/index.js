/**
 * Central entry point for the audio system.
 * Exports public functions and manages Rust event routing.
 */

import AudioMixerController from './AudioMixerController.js';
import * as playback from './playback.js';
import * as PlaybackEngine from './PlaybackEngine.js';
import * as SkipManager from './SkipManager.js';
import { queue } from '../state/globals.js';
import { isBotAloneInChannel, scheduleDisconnectIfAlone, getCurrentSong, resolveDeckIndex, bindDeckSong, clearDeckBindings } from '../queue/QueueManager.js';
import { sanitizeTitle } from '../utils/sanitize.js';
import * as ui from '../ui/index.js';

// Lazy imports for circular dependency prevention (using dynamic imports)

// ─── Stream error tracking ─────────────────────────────────

const failedSongs = new Map();       // guildId -> Map<url, timestamp>
const streamErrorCounts = new Map(); // guildId -> { url: count }
const FAILED_SONG_TTL_MS = 60 * 60 * 1000; // 1 hour: transient errors are forgotten

/**
 * Checks if a song is in the blacklist and if it is still within the TTL.
 */
function isFailedSong(guildId, url) {
  const guildFailed = failedSongs.get(guildId);
  if (!guildFailed) return false;
  const ts = guildFailed.get(url);
  if (ts === undefined) return false;
  if (Date.now() - ts > FAILED_SONG_TTL_MS) {
    guildFailed.delete(url);
    return false;
  }
  return true;
}

function recordStreamError(guildId, url) {
  if (!streamErrorCounts.has(guildId)) streamErrorCounts.set(guildId, {});
  const counts = streamErrorCounts.get(guildId);
  counts[url] = (counts[url] || 0) + 1;

  if (counts[url] >= 3) {
    if (!failedSongs.has(guildId)) failedSongs.set(guildId, new Map());
    failedSongs.get(guildId).set(url, Date.now());
    console.error(`❌ [STREAM] Song marked as unplayable (${counts[url]} errors): ${url.substring(0, 60)}`);
    return true;
  }
  return false;
}

function clearStreamErrors(guildId) {
  streamErrorCounts.delete(guildId);
  failedSongs.delete(guildId);
}

// Periodic cleanup to prevent memory leaks (every 30 minutes)
setInterval(() => {
  const now = Date.now();
  streamErrorCounts.clear();
  // Evict expired blacklist entries (TTL 1 hour)
  for (const [guildId, urlMap] of failedSongs) {
    for (const [url, ts] of urlMap) {
      if (now - ts > FAILED_SONG_TTL_MS) urlMap.delete(url);
    }
    if (urlMap.size === 0) failedSongs.delete(guildId);
  }
}, 30 * 60 * 1000);

// ─── Rust event routing ─────────────────────────────────────

/**
 * Callback invoked by mixer when a deck becomes ready (versioning-aware)
 * Verifies that the buffer is for the correct content (prevents stale buffers)
 */
async function handleBufferReady(guildId, deck) {
  try {
    const sq = queue.get(guildId);
    if (!sq) return;

    // Increment version when buffer becomes ready
    const { stateVersionManager } = await import('../state/StateVersion.js');
    const stateVersion = stateVersionManager.get(guildId);

    sq.bufferReady = sq.bufferReady || {};
    sq.bufferReady[deck] = true;

    stateVersion.incrementVersion('buffer_ready', {
      deck,
      loadedUrl: (deck === 'A' ? sq.currentDeckLoaded : sq.nextDeckLoaded)?.substring(0, 60) || 'N/A'
    });

    console.log(`✅ [BUFFER-READY] Deck ${deck} ready for playback`);

    // If there is a pending transition waiting for this deck, execute it now
    if (sq.pendingTransition && sq.pendingTransition.targetDeck === deck) {
      SkipManager.completePendingTransition(guildId).catch(e => {
        console.error('❌ [BUFFER-READY] Error completePendingTransition:', e);
      });
    }
  } catch (e) {
    console.error('❌ [BUFFER-READY] Error:', e);
  }
}

/**
 * Receives logs/events from the Rust process
 */
async function handleRustEvent(guildId, log) {
  try {
    if (!log || !log.event) return;

    // Ignore events from obsolete mixer (generation no longer current)
    if (log._mixerGeneration) {
      const sq_gen = queue.get(guildId);
      if (sq_gen && sq_gen.mixerGeneration && log._mixerGeneration !== sq_gen.mixerGeneration) {
        return;
      }
    }

    // Stream errors
    if (log.event === 'stream_error') {
      const dataStr = (log.data || '').toLowerCase();
      if (dataStr.includes('opus') && dataStr.includes('error')) {
        const sq = queue.get(guildId);
        if (sq && sq.currentDeckLoaded) {
          const marked = recordStreamError(guildId, sq.currentDeckLoaded);
          if (marked) {
            console.error('🛑 [STREAM] Auto-skip corrupted song');
            SkipManager.autoSkip(guildId);
          }
        }
      }
      return;
    }

    // Crossfade started by Rust (confirmation)
    if (log.event === 'crossfade_started') {
      console.log('🎚️  [RUST] Crossfade started');
      return;
    }

    // 3 seconds before the end of the song
    if (log.event === 'approaching_end') {
      const sq = queue.get(guildId);
      if (sq) {
        const fadeEnabled = !!(sq.fadeEnabled && sq.mixer && sq.mixer.crossfade);
        const { getNextSong } = await import('../queue/QueueManager.js');
        const nextSong = getNextSong(sq);

        // If there is already a pending transition, do not start another auto-skip:
        // completePendingTransition() will handle the change when the buffer is ready.
        // Tolerate only if expired (> 25s), then proceed normally.
        const ptAge = sq.pendingTransition ? (Date.now() - sq.pendingTransition.startTime) : Infinity;
        if (sq.pendingTransition && ptAge < 25000) {
          console.log(`⏳ [APPROACHING-END] Pending transition in progress (${Math.round(ptAge / 1000)}s) – skip auto-crossfade`);
          return;
        }

        if (fadeEnabled && nextSong) {
          // Fade active + there is a next song: start automatic crossfade
          console.log('🎚️  [APPROACHING-END] 3s before the end – automatic crossfade');
          SkipManager.autoSkip(guildId).catch(e => {
            console.error('❌ [APPROACHING-END] autoSkip error:', e);
          });
        } else if (!nextSong) {
          // No next song: Rust will play until natural end
          console.log('⏭️  [APPROACHING-END] No next track – waiting for natural end');
        } else {
          // Fade inactive + there is a next song: do nothing, instant skip at natural end
          console.log('⏭️  [APPROACHING-END] 3s before the end – fade OFF, waiting for natural end');
        }
      }
      return;
    }

    // Track end
    if (log.event === 'end') {
      PlaybackEngine.handleTrackEnd(guildId).catch(e => {
        console.error('❌ [TRACK-END] Error in handleTrackEnd:', e);
      });
      return;
    }

    // ── AUTO-GAPLESS: Rust switched deck autonomously (zero round-trip) ──
    if (log.event === 'auto_end_switch') {
      handleAutoEndSwitch(guildId, log.data).catch(e => {
        console.error('❌ [AUTO-GAPLESS] Error in handleAutoEndSwitch:', e);
      });
      return;
    }

    // ── AUTO-LOOP: Rust restarted the current deck for loop mode ──
    if (log.event === 'auto_loop_restart') {
      handleAutoLoopRestart(guildId, log.data);
      return;
    }

    // Deck change (confirmation – state already updated by SkipManager)
    if (log.event === 'deck_changed') {
      const deckStr = log.data || '';
      const match = deckStr.match(/deck=([A-C])/);
      const newDeck = match ? match[1] : deckStr;
      PlaybackEngine.handleDeckChanged(guildId, newDeck);
      return;
    }

    // deck_proposal legacy – ignored
    if (log.event === 'deck_proposal') return;

    // ── Proactive crossfade proposal from Rust ──
    if (log.event === 'proactive_crossfade_proposal') {
      const sq = queue.get(guildId);
      if (sq && !sq.isCrossfading) {
        const fadeEnabled = sq.fadeEnabled !== false;
        const qmModule = await import('../queue/QueueManager.js');
        const nextSong = qmModule.getNextSong(sq);
        if (fadeEnabled && nextSong) {
          console.log('🎚️  [PROACTIVE-CROSSFADE] Rust proposes crossfade – starting autoSkip');
          SkipManager.autoSkip(guildId).catch(e => {
            console.error('❌ [PROACTIVE-CROSSFADE] autoSkip error:', e);
          });
        } else {
          console.log('⏭️  [PROACTIVE-CROSSFADE] Proposal ignored (fade off or no next track)');
        }
      }
      return;
    }

    // Errors
    if (log.event === 'error' || log.event === 'yt_error') {
      console.error(`🦀 [RUST-${guildId}] ERROR`, log.data || '');
    }
  } catch { /* ignora */ }
}

// ─── Auto-gapless handlers ──────────────────────────────────

/**
 * Rust switched automatically to the preloaded deck when the active deck finished.
 * Updates Node.js state without sending commands to Rust (the transition has already occurred).
 */
async function handleAutoEndSwitch(guildId, newDeck) {
  try {
    const sq = queue.get(guildId);
    if (!sq) return;

    // If there is a pending transition for this deck (user had already pressed skip
    // while the deck was downloading), let completePendingTransition handle
    // everything: it knows the correct index (may be ≠ nextIndex).
    if (sq.pendingTransition && sq.pendingTransition.targetDeck === newDeck) {
      try { (await import('../database/stats.js')).default.incrementSongsCompleted(); } catch { }
      console.log(`⚡ [AUTO-GAPLESS] Deck ${newDeck} has pending transition – delegating completePendingTransition`);
      sq.currentDeck = newDeck; // update currentDeck to reflect Rust reality
      await SkipManager.completePendingTransition(guildId, true /* alreadySwitched */);
      return;
    }

    // ── Idempotency ──
    // If we are ALREADY on the deck that Rust says it switched to, another path
    // (e.g., completePendingTransition via buffer_ready) has already handled the transition.
    // This event is a duplicate: do NOT advance again (would cause song skipping and
    // embed/menu desynchronization). Only re-align the preload.
    if (sq.currentDeck === newDeck) {
      console.log(`↩️  [AUTO-GAPLESS] Duplicate event for deck ${newDeck} already active – ignoring (no double advancement)`);
      PlaybackEngine.onSongStart(guildId);
      return;
    }

    // ── STATS: song completed (gapless auto-switch) ──
    try { (await import('../database/stats.js')).default.incrementSongsCompleted(); } catch { }

    // SOURCE OF TRUTH: Rust switched to deck `newDeck`; the REAL index of the
    // song now playing is the one linked to that deck (binding), not a
    // generic playIndex+1. Fallback to playIndex+1 only if binding is absent.
    let nextIndex = resolveDeckIndex(sq, newDeck);
    if (nextIndex === null || nextIndex === undefined) nextIndex = (sq.playIndex || 0) + 1;

    // If there are no more songs, end the queue
    if (nextIndex >= sq.songs.length) {
      console.log('🏁 [AUTO-GAPLESS] Queue end reached after auto-switch');
      await SkipManager.endQueue(guildId);
      return;
    }

    const nextSong = sq.songs[nextIndex];

    // Update state (no command to Rust — the transition is already done)
    sq.playIndex = nextIndex;
    sq.currentDeck = newDeck;
    sq.currentDeckLoaded = nextSong ? nextSong.url : null;
    sq.nextDeckLoaded = null;
    sq.nextDeckTarget = null;
    sq.songStartTime = Date.now();
    sq.loadingFooter = null;
    sq._lastTransitionTime = Date.now();
    // Realign the bindings: the active deck has the current song, the other is free
    bindDeckSong(sq, newDeck, nextIndex, nextSong ? nextSong.url : null);
    bindDeckSong(sq, (newDeck === 'A' ? 'B' : 'A'), null, null);

    // ── STATS: new song started (auto-gapless) ──
    try {
      const stats = (await import('../database/stats.js')).default;
      stats.incrementSongsStarted();
      stats.recordSongPlay(guildId, nextSong, sq.voiceChannel);
    } catch { }

    // Salva stato e aggiorna UI
    const { saveQueueState } = await import('../queue/persistence.js');
    saveQueueState(guildId, sq);
    ui.refreshDashboard(sq, nextSong ? nextSong.requester : null);

    // Preload the next song on the other deck
    PlaybackEngine.onSongStart(guildId);

    console.log(`⚡ [AUTO-GAPLESS] → "${nextSong ? sanitizeTitle(nextSong.title) : '?'}" (idx=${nextIndex}, deck=${newDeck})`);
  } catch (e) {
    console.error('❌ [AUTO-GAPLESS] Errore handleAutoEndSwitch:', e);
  }
}
/**
 * Rust automatically restarted the current deck (loop mode).
 * Updates only the timestamps and starts a new preload cycle.
 */
async function handleAutoLoopRestart(guildId, deck) {
  try {
    const sq = queue.get(guildId);
    if (!sq) return;

    sq.songStartTime = Date.now();

    const currentSong = sq.songs[sq.playIndex || 0];

    // ── STATS: song completed + restarted (loop) ──
    try {
      const stats = (await import('../database/stats.js')).default;
      stats.incrementSongsCompleted();
      stats.incrementSongsStarted();
      if (currentSong) {
        stats.recordSongPlay(guildId, currentSong, sq.voiceChannel);
      }
    } catch { }

    // Restart the preload timer for the next song
    PlaybackEngine.onSongStart(guildId);

    console.log(`🔁 [AUTO-LOOP] "${currentSong ? sanitizeTitle(currentSong.title) : '?'}" restarted (deck ${deck})`);
  } catch (e) {
    console.error('❌ [AUTO-LOOP] Error handleAutoLoopRestart:', e);
  }
}

// ─── Mixer crash recovery with structured logging ───────────────────

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

    // ── STATS: stop all listener timers (recovery will restart them in playSong) ──
    try { (await import('../database/stats.js')).default.stopAllListeners(guildId); } catch { }

    // Log to file for post-mortem analysis
    try {
      const fs = await import('fs');
      const path = await import('path');
      const logPath = path.default.join('./logs', 'mixer-crashes.log');
      const logEntry = `${JSON.stringify(crashContext)}\n`;
      fs.default.appendFileSync(logPath, logEntry);
    } catch { /* ignore */ }

    // If mixer was intentionally terminated (by endQueue), do not restart
    if (sq.intentionalKill) {
      sq.intentionalKill = false;  // Clean the flag
      console.log('ℹ️  [CRASH-RECOVERY] Intentional termination detected, skip recovery');
      return;
    }

    try { playback.recordMixerCrashTime(guildId); } catch { /* ignora */ }

    sq.crashRecoveryAttempts = (sq.crashRecoveryAttempts || 0) + 1;
    console.warn(`⚠️  [CRASH-RECOVERY] Attempt #${sq.crashRecoveryAttempts} for guild=${guildId}`);

    if (sq.crashRecoveryAttempts > 2) {
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
    try { if (sq.mixer) sq.mixer.kill(); sq.mixer = null; } catch { /* ignore */ }
    sq.currentDeck = null;
    sq.currentDeckLoaded = null;
    sq.nextDeckLoaded = null;
    sq.nextDeckTarget = null;
    clearDeckBindings(sq);

    // Flush pending commands that would wait for a now-dead mixer
    try { (await import('./CommandQueue.js')).commandQueue.flushAndReject(guildId, `Mixer crash: ${reason}`); } catch { /* ignore */ }

    // Attempt restart if voice connection is ready
    try {
      const voiceModule = await import('@discordjs/voice');
      const VCS = voiceModule.VoiceConnectionStatus;
      const connReady = sq.connection && sq.connection.state && sq.connection.state.status === VCS.Ready;
      if (connReady && sq.voiceChannel) {
        const delayMs = 500 + (sq.crashRecoveryAttempts * 500);
        console.log(`⏳ [CRASH-RECOVERY] Scheduling playSong restart in ${delayMs}ms`);
        setTimeout(() => {
          try { playback.playSong(guildId); } catch (e) { console.error(`❌ [CRASH-RECOVERY] playSong restart error (guild=${guildId}):`, e); }
        }, delayMs);
      } else {
        console.log(`ℹ️  [CRASH-RECOVERY] Voice connection not ready (status=${connReady ? 'ready' : 'not ready'}), skip recovery`);
        scheduleDisconnectIfAlone(sq, 0);
      }
    } catch (e) { console.error('❌ [CRASH-RECOVERY] Error during recovery attempt:', e); }
  } catch (e) { console.error('❌ [CRASH-RECOVERY] Fatal error in handleMixerCrash:', e); }
}

// ─── Preload update ─────────────────────────────────────────

async function updatePreloadAfterQueueChange(guildId) {
  try {
    const sq = queue.get(guildId);
    if (!sq || !sq.mixer || !sq.mixer.isProcessAlive()) return;
    // Invalidate current preload and reload
    sq.nextDeckLoaded = null;
    sq.nextDeckTarget = null;
    // Also invalidate the binding of the inactive deck (was the preload deck):
    // it will be rewritten by the new preload with the correct song.
    if (sq.currentDeck) {
      const otherDeck = sq.currentDeck === 'A' ? 'B' : 'A';
      bindDeckSong(sq, otherDeck, null, null);
    }
    PlaybackEngine.preloadNextSong(guildId);
  } catch (e) {
    console.error('❌ [PRELOAD-UPDATE] Error:', e);
  }
}


// ─── Bridge registrations (breaks circular dependencies) ──────

import { register } from './audio-bridge.js';
register('handleMixerCrash', handleMixerCrash);
register('handleBufferReady', handleBufferReady);
register('handleRustEvent', handleRustEvent);
register('refreshDashboard', (sq, userId) => ui.refreshDashboard(sq, userId));
register('isFailedSong', isFailedSong);
register('updatePreloadAfterQueueChange', updatePreloadAfterQueueChange);

// ─── Exports ────────────────────────────────────────────────

// Aliases for playback functions
const playSong = playback.playSong;
const restartCurrentSong = playback.restartCurrentSong;
const togglePauseResume = playback.togglePauseResume;

// Aliases for skip manager functions
const skipNext = SkipManager.skipNext;
const skipPrev = SkipManager.skipPrev;
const skipToIndex = SkipManager.skipToIndex;
const autoSkip = SkipManager.autoSkip;
const endQueue = SkipManager.endQueue;
const hasSkipInProgress = SkipManager.hasSkipInProgress;

// Aliases for preload functions
const preloadNextSongs = updatePreloadAfterQueueChange;

// Aliases for UI functions
const refreshDashboard = (sq, userId = null) => ui.refreshDashboard(sq, userId);
const updateDashboardToFinished = ui.updateDashboardToFinished;

export {
  AudioMixerController,
  playSong,
  restartCurrentSong,
  togglePauseResume,
  PlaybackEngine,
  skipNext,
  skipPrev,
  skipToIndex,
  autoSkip,
  endQueue,
  hasSkipInProgress,
  updatePreloadAfterQueueChange,
  preloadNextSongs,
  handleBufferReady,
  handleRustEvent,
  handleMixerCrash,
  recordStreamError,
  clearStreamErrors,
  isFailedSong,
  refreshDashboard,
  updateDashboardToFinished
};
