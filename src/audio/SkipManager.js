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
 * VERSIONING: Uses StateVersion to track atomic mutations and prevent
 * race conditions caused by stale state reads.
 */

import { queue } from '../state/globals.js';
import { stateVersionManager } from '../state/StateVersion.js';
import { commandQueue } from './CommandQueue.js';
import { CROSSFADE_DURATION_MS, SKIP_THROTTLE_MS } from '../../config/index.js';
import { sanitizeTitle } from '../utils/sanitize.js';
import { saveQueueState } from '../queue/persistence.js';
import { isMixerAlive } from '../queue/QueueManager.js';
import { bindDeckSong } from '../queue/QueueManager.js';
import { clearDeckBindings } from '../queue/QueueManager.js';
import { call, register } from './audio-bridge.js';

// Throttle to prevent spam of rapid skips
const skipThrottle = new Map();  // guildId -> timestamp

function cleanupSkipState(guildId) {
  skipThrottle.delete(guildId);
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

/**
 * Waits for deck buffer to be ready (polling every 50ms)
 * Does not check version: if buffer is ready, it's ready (regardless of other skips)
 */
// ─── Core ───────────────────────────────────────────────────

/**
 * Performs transition to target song with atomic versioning.
 * Handles preload, fade/instant, and state update with version tracking.
 *
 * @param {string} guildId
 * @param {number} targetIndex  – absolute index in songs[]
 * @param {string} reason       – 'manual' | 'manual-select' | 'manual-prev' | 'auto'
 * @returns {Promise<boolean>}
 */
async function performTransition(guildId, targetIndex, reason) {
  const sq = queue.get(guildId);
  if (!sq || !isMixerAlive(sq)) return false;

  // ⚠️  CRITICAL: Do not allow skip during ongoing crossfade
  // Even if isCrossfading flag is false (cleared by onSongStart()),
  // Rust might still be in the middle of crossfade
  // Check timestamp: if crossfade started less than CROSSFADE_DURATION_MS ago, wait
  if (sq.crossfadeStartTime && Date.now() - sq.crossfadeStartTime < CROSSFADE_DURATION_MS) {
    const timeElapsed = Date.now() - sq.crossfadeStartTime;
    console.warn(`⚠️  [SKIP] Crossfade in progress (started ${timeElapsed}ms ago), waiting for it to finish before skipping`);
    return false;
  }

  const stateVersion = stateVersionManager.get(guildId);
  const operationId = `skip_${guildId}_${Date.now()}`;

  // Acquire exclusive lock for this skip operation
  // Timeout: 30s max to complete everything (load, buffer wait, crossfade, etc)
  const lock = stateVersion.acquireLock(operationId, 30000);

  try {
    // Prevent concurrent skips
    if (stateVersion.hasActiveLock(`skip_${guildId}`) && stateVersion.hasActiveLock(operationId) === false) {
      console.warn('⚠️  [SKIP] Ignored – skip already in progress');
      return false;
    }

    const targetSong = sq.songs[targetIndex];
    if (!targetSong || !targetSong.url) {
      console.warn(`⚠️  [SKIP] Invalid target song (index=${targetIndex})`);
      return false;
    }

    stateVersion.incrementVersion('skip_start', {
      targetIndex,
      reason,
      targetSongTitle: sanitizeTitle(targetSong.title)
    });

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

    // Clean up current song timers (preload / end-monitor)
    call('clearAllTimers', guildId);

    if (isPreloaded) {
      // ── FAST PATH: preloaded ──
      // Rust manages buffer internally: if deck has data, it switches immediately.
      // If deck doesn't have data yet, Rust sets a "pending skip" and
      // keeps playing current deck until data arrives.

      // SERIALIZE command through command queue to avoid race conditions
      if (fadeEnabled) {
        sq.isCrossfading = true;
        sq.crossfadeStartTime = Date.now();  // ⚠️  Track start time for sync

        await commandQueue.enqueue(
          guildId,
          'crossfade',
          () => { sq.mixer.crossfade(targetDeck, CROSSFADE_DURATION_MS); },
          { timeout: 5000, priority: 'high' }
        );

        console.log(`🎚️  [SKIP] Crossfade → deck ${targetDeck} (${reason}, preloaded)`);

        // ⚠️  Do NOT clear flag here with setTimeout
        // Flag will be cleared when onSongStart() is called,
        // which means crossfade is definitely complete in Rust
        // and the new song has started playing
      } else {
        await commandQueue.enqueue(
          guildId,
          'skipTo',
          () => { sq.mixer.skipTo(targetDeck); },
          { timeout: 5000, priority: 'high' }
        );
        console.log(`⚡ [SKIP] → deck ${targetDeck} (${reason}, preloaded)`);
      }

    } else {
      // ── NOT preloaded: load from scratch ──
      try { sq.mixer.stopDeck(targetDeck); } catch { /* ignore */ }
      sq.bufferReady = sq.bufferReady || {};
      sq.bufferReady[targetDeck] = false;

      // We are overwriting the deck used for "next" preload: invalidate
      // old preload and bind deck to REAL target song. So any subsequent
      // event (buffer_ready, auto-gapless) knows correct index.
      sq.nextDeckLoaded = null;
      sq.nextDeckTarget = null;
      bindDeckSong(sq, targetDeck, targetIndex, targetUrl);

      // SERIALIZE load command
      await commandQueue.enqueue(
        guildId,
        'load',
        () => { sq.mixer.load(targetUrl, targetDeck, false); },  // autoplay: false, skipTo/crossfade activates it
        { timeout: 8000, priority: 'high' }
      );

      if (reason !== 'auto') {
        sq.loadingFooter = '⏳ Loading in progress...';
        try { call('refreshDashboard', sq); } catch { /* ignore */ }
      }

      // ── DEFERRED TRANSITION ──
      // Download on Linux takes 10-12s; waiting here would block barrier
      // and cause systematic timeouts. Instead we register pendingTransition and
      // return immediately. completePendingTransition() will be called by:
      //   • handleBufferReady()   → deck ready while song still playing
      //   • handleAutoEndSwitch() → Rust switched autonomous via auto-gapless stall

      // Cancel any previous pending for same deck
      if (sq.pendingTransition && sq.pendingTransition.targetDeck === targetDeck) {
        if (sq.pendingTransition._cleanupTimer) clearTimeout(sq.pendingTransition._cleanupTimer);
      }

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
          try { call('refreshDashboard', sq2); } catch { }
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
      return true; // State will be updated by completePendingTransition
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

    // ── STATS: new song started (transition) ──
    try {
      const stats = (await import('../database/stats.js')).default;
      stats.incrementSongsStarted();
      stats.recordSongPlay(guildId, targetSong, sq.voiceChannel);
    } catch { }

    // Increment version after all mutations
    stateVersion.incrementVersion('skip_complete', {
      targetIndex,
      targetDeck,
      reason
    });

    // Save and update UI
    saveQueueState(guildId, sq);
    try { call('refreshDashboard', sq, targetSong.requester); } catch { /* ignore */ }

    // Start preload + end-monitor cycle for new song
    call('onSongStart', guildId);

    // If paused during skip, resume automatically
    try {
      await call('resumeIfPaused', sq, guildId, targetDeck);
    } catch (e) {
      console.warn('⚠️  [SKIP] Error during resumeIfPaused:', e.message);
    }

    console.log(`✅ [SKIP] ${reason}: → "${sanitizeTitle(targetSong.title)}" (idx=${targetIndex}, deck=${targetDeck}, fade=${fadeEnabled})`);
    return true;

  } catch (e) {
    console.error(`❌ [SKIP] Error during transition (${reason}):`, e);
    stateVersion.incrementVersion('skip_error', { reason, error: e.message });
    // Cleanup crossfade flags only on error
    const sqErr = queue.get(guildId);
    if (sqErr) {
      sqErr.isCrossfading = false;
      sqErr.crossfadeStartTime = null;
    }
    return false;
  } finally {
    // Clean up only loading footer — crossfade flags are managed by
    // onSongStart() (success) or catch (error)
    const sqF = queue.get(guildId);
    if (sqF) {
      sqF.loadingFooter = null;
    }
    // Release the lock
    lock.release();
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Manual skip to next song (⏭️ button)
 */
async function skipNext(guildId) {
  if (isThrottled(guildId)) return false;

  const sq = queue.get(guildId);
  if (!sq) return false;

  // Loop → restart current song
  if (sq.loopEnabled) {
    await call('restartCurrentSong', guildId);
    return true;
  }

  const nextIndex = (sq.playIndex || 0) + 1;

  if (nextIndex >= sq.songs.length) {
    // No next song → end queue
    await endQueue(guildId);
    return true;
  }

  return await performTransition(guildId, nextIndex, 'manual');
}

/**
 * Manual skip to previous song (⏮️ button)
 */
async function skipPrev(guildId) {
  if (isThrottled(guildId)) return false;

  const sq = queue.get(guildId);
  if (!sq) return false;

  const prevIndex = (sq.playIndex || 0) - 1;
  if (prevIndex < 0) return false;

  return await performTransition(guildId, prevIndex, 'manual-prev');
}

/**
 * Manual skip to specific index (dropdown menu)
 */
async function skipToIndex(guildId, targetIndex) {
  if (isThrottled(guildId)) return false;

  const sq = queue.get(guildId);
  if (!sq) return false;
  if (targetIndex < 0 || targetIndex >= sq.songs.length) return false;
  if (targetIndex === (sq.playIndex || 0)) return false; // Already playing

  return await performTransition(guildId, targetIndex, 'manual-select');
}

/**
 * Automatic skip at song end (called by PlaybackEngine)
 */
async function autoSkip(guildId) {
  const sq = queue.get(guildId);
  if (!sq) return false;

  // ── STATS: song completed (natural end) ──
  try { (await import('../database/stats.js')).default.incrementSongsCompleted(); } catch { }

  // Loop → restart current song
  if (sq.loopEnabled) {
    await call('restartCurrentSong', guildId);
    return true;
  }

  const nextIndex = (sq.playIndex || 0) + 1;

  if (nextIndex >= sq.songs.length) {
    await endQueue(guildId);
    return true;
  }

  return await performTransition(guildId, nextIndex, 'auto');
}

/**
 * Ends the queue.
 * Keeps last song in songs[0] for replay ("Queue Ended" screen).
 */
async function endQueue(guildId) {
  const sq = queue.get(guildId);
  if (!sq) return;

  call('clearAllTimers', guildId);

  // ── STATS: stop listening timer and save ──
  try {
    const stats = (await import('../database/stats.js')).default;
    stats.flushGuildAndSave(guildId);
  } catch { }

  // Last song played (for "Queue Ended" embed and replay)
  const lastSong = sq.songs[sq.playIndex || 0] || null;

  // Reset state – last song remains for replay
  sq.songs = lastSong ? [lastSong] : [];
  sq.history = [];
  sq.playIndex = 0;
  sq.currentDeckLoaded = null;
  sq.nextDeckLoaded = null;
  sq.nextDeckTarget = null;
  sq.songStartTime = null;
  sq.loadingFooter = null;
  sq.currentDeck = 'A';
  sq.isPaused = false;
  clearDeckBindings(sq);
  // Cancel any pending transition
  if (sq.pendingTransition) {
    if (sq.pendingTransition._cleanupTimer) clearTimeout(sq.pendingTransition._cleanupTimer);
    sq.pendingTransition = null;
  }

  // Stop player and mixer (mark as intentional to avoid crash-recovery)
  try { if (sq.player) sq.player.stop(true); } catch { /* ignore */ }
  sq.intentionalKill = true;
  if (sq.mixer) {
    try { sq.mixer.kill(); } catch { /* ignore */ }
    sq.mixer = null;
  }
  // Destroy low-latency stream to prevent pipe/fd leak
  try { if (sq._llStream) { sq._llStream.unpipe(); sq._llStream.destroy(); sq._llStream = null; } } catch { /* ignore */ }

  saveQueueState(guildId, sq);
  const uiModule = await import('../ui/index.js');
  await uiModule.default.updateDashboardToFinished(sq, lastSong);

  console.log(`🏁 [QUEUE-END] Queue ended${lastSong ? ' (replay: ' + sanitizeTitle(lastSong.title) + ')' : ''}`);
}

/**
 * Checks if a skip is in progress (using state versioning)
 */
function hasSkipInProgress(guildId) {
  const stateVersion = stateVersionManager.get(guildId);
  return stateVersion.hasActiveLock(`skip_${guildId}`);
}

/**
 * Completes a deferred transition when target deck becomes ready.
 * Called by handleBufferReady() or handleAutoEndSwitch() in src/audio/index.js.
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
    try { call('refreshDashboard', sq); } catch { }
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

  try {
    const stats = (await import('../database/stats.js')).default;
    stats.incrementSongsStarted();
    stats.recordSongPlay(guildId, targetSong, sq.voiceChannel);
  } catch { }

  stateVersionManager.get(guildId).incrementVersion('skip_deferred_complete', {
    targetIndex: pt.targetIndex,
    targetDeck: pt.targetDeck,
    reason: pt.reason
  });

  saveQueueState(guildId, sq);
  try { call('refreshDashboard', sq, targetSong.requester); } catch { }

  call('onSongStart', guildId);

  try {
    await call('resumeIfPaused', sq, guildId, pt.targetDeck);
  } catch { }

  console.log(`✅ [SKIP] ${pt.reason}: → "${sanitizeTitle(targetSong.title)}" (idx=${pt.targetIndex}, deck=${pt.targetDeck}, fade=${pt.fadeEnabled}, deferred)`);
}

// ─── Bridge registrations ───────────────────────────────────

register('autoSkip', autoSkip);
register('endQueue', endQueue);
register('hasSkipInProgress', hasSkipInProgress);
register('completePendingTransition', completePendingTransition);

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
