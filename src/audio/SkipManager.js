/**
 * Clean and unified skip system
 *
 * Two types of skips:
 * 1. MANUAL: buttons (next/prev) and dropdown menu (skipToIndex)
 * 2. AUTOMATIC: song end (autoSkip called by PlaybackEngine)
 *
 * Central logic (performTransition):
 *  - Checks if target song is preloaded on other deck
 *  - Checks if fade is active
 *  - If preloaded + fade → crossfade
 *  - If preloaded + no fade → instant transition (skipTo)
 *  - If NOT preloaded → show "Loading...", load, then transition
 *  - After transition updates playIndex (without touching songs array)
 *
 * The queue (songs[]) stays IMMUTABLE during skips.
 * Navigation happens only via playIndex.
 *
 * RESULT: every public function returns a SkipOutcome (see below) so callers can
 * tell a transient refusal (crossfade running, throttle) from a real failure.
 *
 * VERSIONING: Uses StateVersion to track atomic mutations and prevent
 * race conditions caused by stale state reads.
 */

import { queue } from '../state/globals.js';
import { stateVersionManager } from '../state/StateVersion.js';
import { commandQueue } from './SerialQueue.js';
import { CROSSFADE_DURATION_MS, SKIP_THROTTLE_MS } from '../../config/index.js';
import { sanitizeTitle } from '../utils/sanitize.js';
import { saveQueueState } from '../queue/persistence.js';
import { isMixerAlive, bindDeckSong } from '../queue/QueueManager.js';
import { clearAllTimers, onSongStart } from './PlaybackEngine.js';
import { restartCurrentSong, resumeIfPaused } from './playback.js';
import { stopGuildAudio } from './teardown.js';
import { refreshDashboard, updateDashboardToFinished } from '../ui/index.js';
import { LOADING_FOOTER } from '../ui/messages.js';
import { flushGuildAndSave, incrementSongsCompleted } from '../database/stats.js';

// Throttle to prevent spam of rapid skips
const skipThrottle = new Map();  // guildId -> timestamp

function cleanupSkipState(guildId) {
  skipThrottle.delete(guildId);
}

// ─── Outcome ────────────────────────────────────────────────

/**
 * @typedef {{ok: true} | {ok: false, reason: string, retryable: boolean, retryAfterMs: number}} SkipOutcome
 */

const SKIP_OK = Object.freeze({ ok: true });

/**
 * Builds a failed SkipOutcome.
 * @param {string} reason - Machine-readable cause
 * @param {object} [opts]
 * @param {boolean} [opts.retryable=false] - true when the same call could succeed later
 * @param {number} [opts.retryAfterMs=0] - Suggested wait before retrying
 * @returns {SkipOutcome}
 */
function skipFailed(reason, { retryable = false, retryAfterMs = 0 } = {}) {
  return { ok: false, reason, retryable, retryAfterMs };
}

// ─── Helpers ────────────────────────────────────────────────

function getOtherDeck(sq) {
  return (sq.currentDeck || 'A') === 'A' ? 'B' : 'A';
}

function isThrottled(guildId) {
  const now = Date.now();
  const last = skipThrottle.get(guildId) || 0;
  if (now - last < SKIP_THROTTLE_MS) return true;
  skipThrottle.set(guildId, now);
  return false;
}

// ─── Core ───────────────────────────────────────────────────

/**
 * Performs transition to target song with atomic versioning.
 * Handles preload, fade/instant, and state update with version tracking.
 *
 * @param {string} guildId
 * @param {number} targetIndex  – absolute index in songs[]
 * @param {string} reason       – 'manual' | 'manual-select' | 'manual-prev' | 'auto'
 * @returns {Promise<SkipOutcome>}
 */
async function performTransition(guildId, targetIndex, reason) {
  const sq = queue.get(guildId);
  if (!sq || !isMixerAlive(sq)) return skipFailed('mixer_dead');

  // ⚠️  CRITICAL: Do not allow skip during ongoing crossfade
  // Even if isCrossfading flag is false (cleared by onSongStart()),
  // Rust might still be in the middle of crossfade
  // Check timestamp: if crossfade started less than CROSSFADE_DURATION_MS ago, wait
  if (sq.crossfadeStartTime) {
    const elapsed = Date.now() - sq.crossfadeStartTime;
    if (elapsed < CROSSFADE_DURATION_MS) {
      console.warn(`⚠️  [SKIP] Crossfade in progress (started ${elapsed}ms ago), waiting for it to finish before skipping`);
      return skipFailed('crossfade_in_progress', {
        retryable: true,
        retryAfterMs: CROSSFADE_DURATION_MS - elapsed + 100
      });
    }
  }

  const stateVersion = stateVersionManager.get(guildId);
  const lockPrefix = `skip_${guildId}`;

  // Prevent concurrent skips. MUST run before acquiring our own lock, otherwise
  // the check would always match the lock we just added.
  if (stateVersion.hasActiveLock(lockPrefix)) {
    console.warn('⚠️  [SKIP] Ignored – skip already in progress');
    return skipFailed('skip_in_progress', { retryable: true, retryAfterMs: 500 });
  }

  const targetSong = sq.songs[targetIndex];
  if (!targetSong || !targetSong.url) {
    console.warn(`⚠️  [SKIP] Invalid target song (index=${targetIndex})`);
    return skipFailed('invalid_target');
  }

  // Acquire exclusive lock for this skip operation
  // Timeout: 30s max to complete everything (load, buffer wait, crossfade, etc)
  const lock = stateVersion.acquireLock(`${lockPrefix}_${Date.now()}`, 30000);

  try {
    stateVersion.incrementVersion('skip_start');

    const fadeEnabled = !!(sq.fadeEnabled && sq.mixer && sq.mixer.crossfade);
    const targetDeck = getOtherDeck(sq);
    const oldDeck = sq.currentDeck || 'A';
    const targetUrl = targetSong.url;

    // Check if song is preloaded on target deck
    // CRITICAL: Check both URL and bufferReady state to avoid false-positives
    // "preloaded" means Rust has audio data ready, not just that URL was sent
    const isPreloaded = sq.nextDeckLoaded === targetUrl
      && sq.nextDeckTarget === targetDeck
      && sq.bufferReady && sq.bufferReady[targetDeck];

    // Clean up current song timers (preload / statistics fallback)
    clearAllTimers(guildId);

    if (isPreloaded) {
      // ── FAST PATH: preloaded ──
      // Rust manages buffer internally: if deck has data, it switches immediately.
      // If deck doesn't have data yet, Rust sets a "pending skip" and
      // keeps playing current deck until data arrives.

      // SERIALIZE command through the command queue to avoid race conditions
      if (fadeEnabled) {
        sq.isCrossfading = true;
        sq.crossfadeStartTime = Date.now();  // ⚠️  Track start time for sync

        const outcome = await commandQueue.run(
          guildId,
          'crossfade',
          () => { sq.mixer.crossfade(targetDeck, CROSSFADE_DURATION_MS); },
          { timeout: 5000, priority: 'high' }
        );
        if (!outcome.success) {
          sq.isCrossfading = false;
          sq.crossfadeStartTime = null;
          console.error('❌ [SKIP] Crossfade command failed:', outcome.error.message);
          return skipFailed('command_failed');
        }

        console.log(`🎚️  [SKIP] Crossfade → deck ${targetDeck} (${reason}, preloaded)`);

        // ⚠️  Do NOT clear the flag here with setTimeout
        // It is cleared by onSongStart(), which means the crossfade is
        // definitely complete in Rust and the new song has started playing
      } else {
        const outcome = await commandQueue.run(
          guildId,
          'skipTo',
          () => { sq.mixer.skipTo(targetDeck); },
          { timeout: 5000, priority: 'high' }
        );
        if (!outcome.success) {
          console.error('❌ [SKIP] skipTo command failed:', outcome.error.message);
          return skipFailed('command_failed');
        }
        console.log(`⚡ [SKIP] → deck ${targetDeck} (${reason}, preloaded)`);
      }

    } else {
      // ── NOT preloaded: load from scratch ──
      try { sq.mixer.stopDeck(targetDeck); } catch { /* mixer may already be gone */ }
      sq.bufferReady = sq.bufferReady || {};
      sq.bufferReady[targetDeck] = false;

      // We are overwriting the deck used for "next" preload: invalidate
      // old preload and bind deck to REAL target song. So any subsequent
      // event (buffer_ready, auto-gapless) knows correct index.
      sq.nextDeckLoaded = null;
      sq.nextDeckTarget = null;
      bindDeckSong(sq, targetDeck, targetIndex, targetUrl);

      // SERIALIZE load command
      const outcome = await commandQueue.run(
        guildId,
        'load',
        () => { sq.mixer.load(targetUrl, targetDeck, false); },  // autoplay: false, skipTo/crossfade activates it
        { timeout: 8000, priority: 'high' }
      );
      if (!outcome.success) {
        bindDeckSong(sq, targetDeck, null, null);
        console.error('❌ [SKIP] Load command failed:', outcome.error.message);
        return skipFailed('command_failed');
      }

      if (reason !== 'auto') {
        // Published in the embed below; cleared by completePendingTransition()
        // or by the expiry timer, never by this function.
        sq.loadingFooter = LOADING_FOOTER;
        refreshDashboard(sq);
      }

      // ── DEFERRED TRANSITION ──
      // Download on Linux takes 10-12s; waiting here would block the barrier
      // and cause systematic timeouts. Instead we register pendingTransition and
      // return immediately. completePendingTransition() will be called by:
      //   • handleBufferReady()   → deck ready while song still playing
      //   • handleAutoEndSwitch() → Rust switched autonomously via auto-gapless stall

      // The pending transition is replaced below whichever deck it targeted, so
      // its expiry timer has to go with it rather than linger for another 30s.
      if (sq.pendingTransition?._cleanupTimer) clearTimeout(sq.pendingTransition._cleanupTimer);

      const pendingStartTime = Date.now();
      const timeoutMs = sq.isPaused ? 2000 : 30000;
      const cleanupTimer = setTimeout(() => {
        const sq2 = queue.get(guildId);
        if (!sq2 || !sq2.pendingTransition || sq2.pendingTransition.startTime !== pendingStartTime) return;

        if (sq2.isPaused) {
          console.warn(`⚠️  [SKIP] Pending transition expired (${timeoutMs}ms) while paused – forcing transition`);
          // Force transition even if we didn't get buffer_ready from Rust.
          completePendingTransition(guildId).catch(e => {
            console.error('❌ [SKIP] Error forcing completePendingTransition:', e);
          });
        } else {
          console.warn(`⚠️  [SKIP] Pending transition expired (${timeoutMs}ms) – canceling`);
          sq2.pendingTransition = null;
          sq2.loadingFooter = null;
          refreshDashboard(sq2);
        }
      }, timeoutMs);

      sq.pendingTransition = {
        targetIndex,
        targetDeck,
        targetUrl,
        fadeEnabled,
        reason,
        startTime: pendingStartTime,
        _cleanupTimer: cleanupTimer
      };

      console.log(`⏳ [SKIP] Deck ${targetDeck} downloading (${reason}) – deferred transition`);
      return SKIP_OK; // State will be updated by completePendingTransition
    }

    // ── Update state ATOMICALLY ──
    // All mutations in one logical transaction to prevent state corruption
    sq.playIndex = targetIndex;
    sq.currentDeck = targetDeck;
    sq.currentDeckLoaded = targetSong.url;
    sq.nextDeckLoaded = null;
    sq.nextDeckTarget = null;
    sq.songStartTime = Date.now();
    sq.loadingFooter = null;
    sq._lastTransitionTime = Date.now();
    // Confirm binding: target deck now plays song at target index, clear other deck
    bindDeckSong(sq, targetDeck, targetIndex, targetSong.url);
    bindDeckSong(sq, oldDeck, null, null);

    // Increment version after all mutations
    stateVersion.incrementVersion('skip_complete');

    // Save and update UI
    saveQueueState(guildId, sq);
    refreshDashboard(sq);

    // Start preload + statistics fallback cycle for the new song
    onSongStart(guildId);

    // If paused during skip, resume automatically
    resumeIfPaused(sq, guildId);

    console.log(`✅ [SKIP] ${reason}: → "${sanitizeTitle(targetSong.title)}" (idx=${targetIndex}, deck=${targetDeck}, fade=${fadeEnabled})`);
    return SKIP_OK;

  } catch (e) {
    console.error(`❌ [SKIP] Error during transition (${reason}):`, e);
    stateVersion.incrementVersion('skip_error');
    // Cleanup crossfade flags and loading footer only on error
    const sqErr = queue.get(guildId);
    if (sqErr) {
      sqErr.isCrossfading = false;
      sqErr.crossfadeStartTime = null;
      sqErr.loadingFooter = null;
    }
    return skipFailed('error');
  } finally {
    lock.release();
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Manual skip to next song (⏭️ button)
 * @param {string} guildId
 * @returns {Promise<SkipOutcome>}
 */
async function skipNext(guildId) {
  if (isThrottled(guildId)) return skipFailed('throttled', { retryable: true, retryAfterMs: SKIP_THROTTLE_MS });

  const sq = queue.get(guildId);
  if (!sq) return skipFailed('no_queue');

  // Loop → restart current song
  if (sq.loopEnabled) {
    await restartCurrentSong(guildId);
    return SKIP_OK;
  }

  const nextIndex = (sq.playIndex || 0) + 1;

  if (nextIndex >= sq.songs.length) {
    // No next song → end queue
    await endQueue(guildId);
    return SKIP_OK;
  }

  return performTransition(guildId, nextIndex, 'manual');
}

/**
 * Manual skip to previous song (⏮️ button)
 * @param {string} guildId
 * @returns {Promise<SkipOutcome>}
 */
async function skipPrev(guildId) {
  if (isThrottled(guildId)) return skipFailed('throttled', { retryable: true, retryAfterMs: SKIP_THROTTLE_MS });

  const sq = queue.get(guildId);
  if (!sq) return skipFailed('no_queue');

  const prevIndex = (sq.playIndex || 0) - 1;
  if (prevIndex < 0) return skipFailed('no_previous_song');

  return performTransition(guildId, prevIndex, 'manual-prev');
}

/**
 * Manual skip to specific index (dropdown menu, unplayable song recovery)
 * @param {string} guildId
 * @param {number} targetIndex
 * @returns {Promise<SkipOutcome>}
 */
async function skipToIndex(guildId, targetIndex) {
  if (isThrottled(guildId)) return skipFailed('throttled', { retryable: true, retryAfterMs: SKIP_THROTTLE_MS });

  const sq = queue.get(guildId);
  if (!sq) return skipFailed('no_queue');
  if (targetIndex < 0 || targetIndex >= sq.songs.length) return skipFailed('invalid_index');
  if (targetIndex === (sq.playIndex || 0)) return skipFailed('already_playing');

  return performTransition(guildId, targetIndex, 'manual-select');
}

/**
 * Automatic skip at song end (called by PlaybackEngine and the Rust event router)
 * @param {string} guildId
 * @returns {Promise<SkipOutcome>}
 */
async function autoSkip(guildId) {
  const sq = queue.get(guildId);
  if (!sq) return skipFailed('no_queue');

  // ── STATS: song completed (natural end) ──
  incrementSongsCompleted();

  // Loop → restart current song
  if (sq.loopEnabled) {
    await restartCurrentSong(guildId);
    return SKIP_OK;
  }

  const nextIndex = (sq.playIndex || 0) + 1;

  if (nextIndex >= sq.songs.length) {
    await endQueue(guildId);
    return SKIP_OK;
  }

  return performTransition(guildId, nextIndex, 'auto');
}

/**
 * Ends the queue.
 * Keeps last song in songs[0] for replay ("Queue Ended" screen).
 * @param {string} guildId
 */
async function endQueue(guildId) {
  const sq = queue.get(guildId);
  if (!sq) return;

  // ── STATS: stop listening timer and save ──
  flushGuildAndSave(guildId);

  // Last song played (for "Queue Ended" embed and replay)
  const lastSong = sq.songs[sq.playIndex || 0] || null;

  // Stops the mixer, the player and every timer, and clears the deck state
  stopGuildAudio(sq, { reason: 'Queue ended' });

  // Reset the queue – the last song stays available for replay
  sq.songs = lastSong ? [lastSong] : [];
  sq.playIndex = 0;
  sq.songStartTime = null;
  sq.isPaused = false;

  saveQueueState(guildId, sq);
  await updateDashboardToFinished(sq, lastSong);

  console.log(`🏁 [QUEUE-END] Queue ended${lastSong ? ' (replay: ' + sanitizeTitle(lastSong.title) + ')' : ''}`);
}

/**
 * Checks if a skip is in progress (using state versioning)
 * @param {string} guildId
 * @returns {boolean}
 */
function hasSkipInProgress(guildId) {
  return stateVersionManager.get(guildId).hasActiveLock(`skip_${guildId}`);
}

/**
 * Completes a deferred transition when target deck becomes ready.
 * Called by handleBufferReady() or handleAutoEndSwitch() in src/audio/rust-events.js.
 *
 * @param {string} guildId
 * @param {boolean} [alreadySwitched=false] – true if Rust already switched (auto-gapless):
 *   in that case we don't send skip_to/crossfade, only update Node.js state.
 */
async function completePendingTransition(guildId, alreadySwitched = false) {
  const sq = queue.get(guildId);
  if (!sq) return;

  const pt = sq.pendingTransition;
  if (!pt) return;

  // Remove immediately to avoid double execution
  sq.pendingTransition = null;
  if (pt._cleanupTimer) clearTimeout(pt._cleanupTimer);

  if (!isMixerAlive(sq)) {
    sq.loadingFooter = null;
    return;
  }

  // Check that target song is still valid in queue
  const targetSong = sq.songs[pt.targetIndex];
  if (!targetSong || targetSong.url !== pt.targetUrl) {
    console.warn('⚠️  [SKIP] Pending transition invalidated: song removed from queue');
    // Target deck loaded audio for song no longer in queue: invalidate binding.
    bindDeckSong(sq, pt.targetDeck, null, null);
    sq.loadingFooter = null;
    refreshDashboard(sq);
    return;
  }

  // If we're already on target deck (auto-gapless already switched), don't send commands to Rust
  const rustAlreadySwitched = alreadySwitched || (sq.currentDeck === pt.targetDeck);

  if (!rustAlreadySwitched) {
    // Execute switch command
    try {
      if (pt.fadeEnabled) {
        sq.isCrossfading = true;
        sq.crossfadeStartTime = Date.now();
        sq.mixer.crossfade(pt.targetDeck, CROSSFADE_DURATION_MS);
        console.log(`🎚️  [SKIP] Crossfade → deck ${pt.targetDeck} (${pt.reason}, deferred)`);
      } else {
        sq.mixer.skipTo(pt.targetDeck);
        console.log(`⚡ [SKIP] → deck ${pt.targetDeck} (${pt.reason}, deferred)`);
      }
    } catch (e) {
      console.error('❌ [SKIP] Error in pending transition command:', e.message);
      sq.isCrossfading = false;
      sq.crossfadeStartTime = null;
      sq.loadingFooter = null;
      return;
    }
  }

  // ── Update state ──
  sq.playIndex = pt.targetIndex;
  sq.currentDeck = pt.targetDeck;
  sq.currentDeckLoaded = pt.targetUrl;
  sq.nextDeckLoaded = null;
  sq.nextDeckTarget = null;
  sq.songStartTime = Date.now();
  sq.loadingFooter = null;
  sq._lastTransitionTime = Date.now();
  // Confirm binding: target deck now plays song at target index
  bindDeckSong(sq, pt.targetDeck, pt.targetIndex, pt.targetUrl);
  bindDeckSong(sq, (pt.targetDeck === 'A' ? 'B' : 'A'), null, null);

  stateVersionManager.get(guildId).incrementVersion('skip_deferred_complete');

  saveQueueState(guildId, sq);
  refreshDashboard(sq);

  onSongStart(guildId);

  resumeIfPaused(sq, guildId);

  console.log(`✅ [SKIP] ${pt.reason}: → "${sanitizeTitle(targetSong.title)}" (idx=${pt.targetIndex}, deck=${pt.targetDeck}, fade=${pt.fadeEnabled}, deferred)`);
}

export {
  skipNext,
  skipPrev,
  skipToIndex,
  autoSkip,
  endQueue,
  hasSkipInProgress,
  completePendingTransition,
  cleanupSkipState
};
