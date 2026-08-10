/**
 * Audio timing handler
 * Responsibilities:
 * 1. Preloading: 5s after the start of each song, preload the next one on the other deck
 * 2. Monitoring: Listens to the 'end' event from Rust (natural track end)
 *    - When 'end' arrives, checks if there's a next song and does autoSkip
 * 3. For automatic crossfade 3s before the end:
 *    - Rust must send an 'approaching_end' event (3s before)
 *    - Or Node.js sends a 'schedule_crossfade' command to Rust at the start
 *
 * Does NOT use timers tied to song end. Only uses the 'end' event from Rust.
 */

import { queue } from '../state/globals.js';
import { sanitizeTitle, areSameSong } from '../utils/sanitize.js';
import { CROSSFADE_DURATION_MS } from '../../config/index.js';
import { isMixerAlive } from '../queue/QueueManager.js';
import { call, register } from './audio-bridge.js';

const PRELOAD_DELAY_MS = 5000; // Preload 5 seconds after the start of the song (to allow time for initial audio chunks)
const PRELOAD_RETRY_MIN_DELAY_MS = 250;

// ─── State ──────────────────────────────────────────────────

const timers = new Map(); // guildId -> { preloadTimer }

// ─── Helpers ────────────────────────────────────────────────

function getCurrentSong(sq) {
  if (!sq || !sq.songs || sq.songs.length === 0) return null;
  const idx = sq.playIndex || 0;
  return idx < sq.songs.length ? sq.songs[idx] : null;
}

function getNextSong(sq) {
  if (!sq || !sq.songs) return null;
  const nextIdx = (sq.playIndex || 0) + 1;
  return nextIdx < sq.songs.length ? sq.songs[nextIdx] : null;
}

function hasNextSong(sq) {
  if (!sq || !sq.songs) return false;
  return (sq.playIndex || 0) + 1 < sq.songs.length;
}

// ─── Timer Management ───────────────────────────────────────

function clearAllTimers(guildId) {
  const state = timers.get(guildId);
  if (state && state.preloadTimer) {
    clearTimeout(state.preloadTimer);
  }
  timers.delete(guildId);
}

function schedulePreloadRetry(guildId, delayMs) {
  const safeDelay = Math.max(PRELOAD_RETRY_MIN_DELAY_MS, delayMs || PRELOAD_RETRY_MIN_DELAY_MS);
  const state = timers.get(guildId) || {};
  if (state.preloadTimer) clearTimeout(state.preloadTimer);

  state.preloadTimer = setTimeout(() => {
    preloadNextSong(guildId);
  }, safeDelay);

  timers.set(guildId, state);
  console.log(`⏳ [PRELOAD] Retry scheduled in ${safeDelay}ms`);
}

// ─── Core ───────────────────────────────────────────────────

/**
 * Called when a new song starts playing.
 * Schedules only:
 *  - preload after 5 seconds on the other deck
 *
 * Does not use timers to monitor the end. Waits for the 'end' event from Rust.
 * If you want automatic crossfade 3s before the end, Rust must send
 * an 'approaching_end' event or the bot must send 'schedule_crossfade'
 * to Rust at the start of this song.
 */
function onSongStart(guildId) {
  const sq = queue.get(guildId);
  if (!sq) return;

  // ⚠️  Clear the isCrossfading flag when the new song ACTUALLY starts
  // At this point the crossfade is definitely complete in Rust
  // This synchronizes the Node.js flag with the actual Rust state
  sq.isCrossfading = false;

  const currentSong = getCurrentSong(sq);
  if (!currentSong || !isMixerAlive(sq)) return;

  // Clear previous timers
  clearAllTimers(guildId);

  // ── Timer: Preload the next song after 5 seconds ──
  const preloadTimer = setTimeout(() => {
    preloadNextSong(guildId);
  }, PRELOAD_DELAY_MS);

  // Save the timer
  timers.set(guildId, { preloadTimer });

  console.log(`🎵 [PLAYBACK] Started: "${sanitizeTitle(currentSong.title)}"`);
  if (currentSong.duration && currentSong.duration > 0) {
    console.log(`⏱️  [PLAYBACK] Duration: ${currentSong.duration}s`);
  }
}

/**
 * Preload the next song on the other deck.
 * Called 5 seconds after the start of each song.
 * The deck is loaded but left paused (ready for instant skipTo or crossfade).
 *
 * Invalidates preload only if the queue has actually changed (playIndex, songs array),
 * not if something generic changed like buffer ready or loop mode.
 */
async function preloadNextSong(guildId) {
  const sq = queue.get(guildId);
  if (!sq || !isMixerAlive(sq)) return;

  // ⚠️  Do not preload if the song is paused
  // During pause, Rust is not playing and extra loads could cause snap/issues
  if (sq.isPaused) {
    console.log('⏭️  [PRELOAD] Song paused, skipping preload');
    return;
  }

  const nextSong = getNextSong(sq);
  if (!nextSong || !nextSong.url) {
    console.log('⏭️  [PRELOAD] No next song to preload');
    return;
  }

  const currentSong = getCurrentSong(sq);
  // Do not preload if next == current (same URL)
  if (currentSong && areSameSong(currentSong.url, nextSong.url)) return;

  // Do not preload if already ready
  if (sq.nextDeckLoaded === nextSong.url) {
    console.log(`✅ [PRELOAD] Already preloaded: "${sanitizeTitle(nextSong.title)}"`);
    return;
  }

  const nextDeck = (sq.currentDeck || 'A') === 'A' ? 'B' : 'A';

  try {
    // ⚠️  SAFETY: Do not preload during or shortly after a crossfade
    // The isCrossfading flag might be false but Rust is still doing the crossfade
    // Check the timestamp: if crossfade started less than CROSSFADE_DURATION_MS ago, wait
    if (sq.isCrossfading || (sq.crossfadeStartTime && Date.now() - sq.crossfadeStartTime < CROSSFADE_DURATION_MS)) {
      if (sq.isCrossfading) {
        console.warn('⚠️  [PRELOAD] Skip: crossfade in progress (flag=true), waiting for crossfade to finish before preload');
        schedulePreloadRetry(guildId, CROSSFADE_DURATION_MS);
      } else {
        const timeElapsed = Date.now() - sq.crossfadeStartTime;
        console.warn(`⚠️  [PRELOAD] Skip: crossfade completed only ${timeElapsed}ms ago (< ${CROSSFADE_DURATION_MS}ms), waiting more`);
        const remainingMs = CROSSFADE_DURATION_MS - timeElapsed + 150;
        schedulePreloadRetry(guildId, remainingMs);
      }
      return;
    }

    // IMPORTANT: never stop the other deck during preload.
    // After a crossfade the "old" deck may be the one currently playing;
    // stopping it here causes immediate silence (e.g: track starts and stops after a few seconds).

    // Capture the queue state BEFORE preload
    const playIndexBefore = sq.playIndex || 0;
    const songCountBefore = (sq.songs && sq.songs.length) || 0;
    const nextSongUrlBefore = nextSong.url;
    const nextIndexBefore = playIndexBefore + 1; // index of the song we're preloading

    // Do not stop the deck for preload - Rust will reset the buffer on load
    sq.bufferReady = sq.bufferReady || {};
    sq.bufferReady[nextDeck] = false;

    // Load the song (autoplay=false: deck stays paused, ready for skip/crossfade)
    // SERIALIZE the load command through command queue
    const { commandQueue } = await import('./CommandQueue.js');
    commandQueue.enqueue(
      guildId,
      'preload_load',
      () => { sq.mixer.load(nextSong.url, nextDeck, false); },
      { timeout: 8000, retries: 1 }
    ).then(async () => {
      // Invalidate ONLY if the queue was actually modified (skip, clear, add songs)
      // DO NOT invalidate if version changed for independent reasons (buffer ready, etc)
      const playIndexAfter = sq.playIndex || 0;
      const songCountAfter = (sq.songs && sq.songs.length) || 0;
      const nextSongUrlAfter = getNextSong(sq)?.url || null;

      if (playIndexBefore !== playIndexAfter || songCountBefore !== songCountAfter || nextSongUrlBefore !== nextSongUrlAfter) {
        console.warn(`⚠️  [PRELOAD] Queue changed during load (playIdx: ${playIndexBefore}→${playIndexAfter}, songs: ${songCountBefore}→${songCountAfter}), preload invalidated`);
        sq.nextDeckLoaded = null;
        sq.nextDeckTarget = null;
        return;
      }

      sq.nextDeckLoaded = nextSong.url;
      sq.nextDeckTarget = nextDeck;
      // Bind the preloaded deck to the "next" song: it's the source of truth
      // used by auto-gapless/crossfade to know the actual index.
      try { (await import('../queue/QueueManager.js')).bindDeckSong(sq, nextDeck, nextIndexBefore, nextSong.url); } catch { }
      console.log(`📥 [PRELOAD] Deck ${nextDeck}: "${sanitizeTitle(nextSong.title)}"`);
    }).catch(e => {
      console.error(`❌ [PRELOAD] Command queue error: ${e.message}`);
      sq.nextDeckLoaded = null;
      sq.nextDeckTarget = null;
    });

  } catch (e) {
    console.error(`❌ [PRELOAD] Error: ${e.message}`);
  }
}

/**
 * Handles the 'end' event from Rust (track ended naturally).
 *
 * When Rust sends the 'end' event, tries to skip to the next song
 * (autoSkip). If there isn't one, ends the queue.
 *
 * Notes:
 * - If fade is ON, who initiated the crossfade? It should have been done by:
 *   a) An 'approaching_end' event from Rust (3s before) that triggers autoSkip
 *   b) A 'schedule_crossfade' command sent to Rust at song start
 *   c) The user pressing skip manually
 * - If fade is OFF, instant skip happens here when 'end' arrives
 */
async function handleTrackEnd(guildId) {
  const sq = queue.get(guildId);
  if (!sq) return;

  // Ignore events if mixer is no longer active
  if (!isMixerAlive(sq)) return;

  // Clean preload timers when track ends
  clearAllTimers(guildId);

  // Check if a skip is in progress (avoid race condition)
  const SkipManager_hasSkipInProgress = bridge.get('hasSkipInProgress');
  if (SkipManager_hasSkipInProgress && SkipManager_hasSkipInProgress(guildId)) {
    console.log('⏳ [TRACK-END] Skip already in progress, ignoring');
    return;
  }

  // If there's a deferred transition waiting for buffer, let it complete
  // (handleBufferReady or handleAutoEndSwitch will handle it)
  if (sq.pendingTransition) {
    console.log('⏳ [TRACK-END] Pending transition in progress – waiting for buffer');
    return;
  }

  // Proceed with auto-skip if there's a next song
  if (hasNextSong(sq)) {
    console.log('⏭️  [TRACK-END] Natural end, automatic skip');
    await call('autoSkip', guildId);
  } else {
    console.log('🏁 [TRACK-END] Last song ended, queue finished');
    await call('endQueue', guildId);
  }
}

/**
 * Handles the 'deck_changed' event from Rust (logging only).
 * State is already updated by SkipManager optimistically.
 */
function handleDeckChanged(guildId, newDeck) {
  console.log(`🔀 [DECK-CHANGED] Rust: deck=${newDeck}`);
}
// ─── Bridge registrations ───────────────────────────────────

register('onSongStart', onSongStart);
register('clearAllTimers', clearAllTimers);
register('preloadNextSong', preloadNextSong);
// ─── Exports ────────────────────────────────────────────────

export {
  onSongStart,
  preloadNextSong,
  handleTrackEnd,
  handleDeckChanged,
  clearAllTimers
};
