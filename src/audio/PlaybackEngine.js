/**
 * Audio timing handler
 * Responsibilities:
 * 1. Preloading: 5s after the start of each song, preload the next one on the other deck
 * 2. Reacting to the 'end' event from Rust (natural track end): skip to the next
 *    song, or close the queue when there is none
 * 3. Crediting the play to the statistics if the engine never confirms playback
 * 4. Asking the TTSBot to read the title of the song that just started
 *
 * Does NOT use timers tied to the song end: the automatic crossfade 3 seconds
 * before the end is driven by the 'approaching_end' event sent by Rust.
 */

import { queue } from '../state/globals.js';
import { sanitizeTitle, areSameSong } from '../utils/sanitize.js';
import { announceSong } from '../utils/ttsAnnounce.js';
import { CROSSFADE_DURATION_MS, TTS_ANNOUNCE_DELAY_MS, isTtsAnnounceEnabled } from '../../config/index.js';
import { isMixerAlive, getCurrentSong, getNextSong, hasNextSong, bindDeckSong } from '../queue/QueueManager.js';
import { commandQueue } from './SerialQueue.js';
import { autoSkip, endQueue, hasSkipInProgress } from './SkipManager.js';
import { confirmPlayback } from './rust-events.js';

const PRELOAD_DELAY_MS = 5000; // Preload 5 seconds after the start of the song (to allow time for initial audio chunks)
const PRELOAD_RETRY_MIN_DELAY_MS = 250;
// Waited on top of a crossfade before preloading: the fade runs on the engine's
// own sample clock, so it never ends exactly when our timestamp says it should.
const PRELOAD_CROSSFADE_MARGIN_MS = 150;
// Safety net for the statistics: the audio engine confirms real playback after
// ~1 second, so this only fires with an engine build that never sends the event.
// It is longer than the download watchdog so an unplayable song is reported and
// skipped before it could be wrongly credited as listened.
const PLAYBACK_CONFIRM_FALLBACK_MS = 90000;

// ─── State ──────────────────────────────────────────────────

const timers = new Map(); // guildId -> { preloadTimer, confirmTimer, announceTimer }

// ─── Timer Management ───────────────────────────────────────

function clearAllTimers(guildId) {
  const state = timers.get(guildId);
  if (state) {
    if (state.preloadTimer) clearTimeout(state.preloadTimer);
    if (state.confirmTimer) clearTimeout(state.confirmTimer);
    if (state.announceTimer) clearTimeout(state.announceTimer);
  }
  timers.delete(guildId);
}

function schedulePreloadRetry(guildId, delayMs) {
  const safeDelay = Math.max(PRELOAD_RETRY_MIN_DELAY_MS, delayMs || PRELOAD_RETRY_MIN_DELAY_MS);
  const state = timers.get(guildId) || {};
  if (state.preloadTimer) clearTimeout(state.preloadTimer);

  state.preloadTimer = setTimeout(() => {
    preloadNextSong(guildId).catch(e => console.error('[PRELOAD] Retry error:', e));
  }, safeDelay);

  timers.set(guildId, state);
  console.log(`⏳ [PRELOAD] Retry scheduled in ${safeDelay}ms`);
}

/**
 * Cancels the statistics fallback of a guild, leaving the preload timer alone.
 * Called as soon as the engine confirms playback: the fallback exists only for
 * the case where that confirmation never arrives.
 * @param {string} guildId
 */
function cancelPlaybackFallback(guildId) {
  const state = timers.get(guildId);
  if (!state || !state.confirmTimer) return;
  clearTimeout(state.confirmTimer);
  state.confirmTimer = null;
}

/**
 * Delay before preloading the next song: the usual 5 seconds, pushed back so it
 * never lands inside a crossfade that is still running. Preloading during a fade
 * is refused by preloadNextSong() anyway, so scheduling it there would only cost
 * a wasted attempt and a misleading warning on every faded transition.
 * @param {object} sq - Server queue
 * @returns {number}
 */
function preloadDelayFor(sq) {
  const sinceCrossfade = sq.crossfadeStartTime ? Date.now() - sq.crossfadeStartTime : Infinity;
  if (sinceCrossfade >= CROSSFADE_DURATION_MS) return PRELOAD_DELAY_MS;
  return Math.max(PRELOAD_DELAY_MS, CROSSFADE_DURATION_MS - sinceCrossfade + PRELOAD_CROSSFADE_MARGIN_MS);
}

// ─── Core ───────────────────────────────────────────────────

/**
 * Asks the TTSBot to read the title, unless the song that was playing when the
 * timer was armed is no longer the one on air. Five seconds are enough for a
 * skip, a pause or a disconnection to happen in between.
 * @param {string} guildId
 * @param {object} song - Song the announcement was scheduled for
 */
function announceCurrentSong(guildId, song) {
  const sq = queue.get(guildId);
  if (!sq || sq.isPaused || !isMixerAlive(sq)) return;

  const playing = getCurrentSong(sq);
  if (!playing || !areSameSong(playing.url, song.url)) return;

  const channelId = sq.voiceChannel?.id;
  if (!channelId) return;

  void announceSong({ guildId, channelId, title: playing.title });
}

/**
 * Called when a new song starts playing.
 * Schedules:
 *  - preload after 5 seconds on the other deck
 *  - the statistics fallback, in case the engine never confirms playback
 *  - the spoken announcement of the title, when it is enabled
 *
 * Does not use timers to monitor the end: it waits for the 'end' (or
 * 'approaching_end') event from Rust.
 * @param {string} guildId
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
    preloadNextSong(guildId).catch(e => console.error('[PRELOAD] Error:', e));
  }, preloadDelayFor(sq));

  // ── Timer: statistics fallback ──
  // Cancelled by cancelPlaybackFallback() as soon as the engine confirms real
  // playback (~1s in), so it only ever fires when that event never arrives.
  const confirmTimer = setTimeout(() => {
    const sqNow = queue.get(guildId);
    if (!sqNow || sqNow.isPaused || !isMixerAlive(sqNow)) return;
    console.warn('⚠️  [PLAYBACK] No playback confirmation from the engine, crediting the play from the fallback');
    confirmPlayback(guildId, sqNow.currentDeck || 'A', 'fallback').catch(e => {
      console.error('❌ [PLAYBACK] Fallback confirmPlayback error:', e);
    });
  }, PLAYBACK_CONFIRM_FALLBACK_MS);

  // ── Timer: spoken announcement of the title ──
  // Armed only when the feature is on, so a disabled announcement costs nothing.
  const announceTimer = isTtsAnnounceEnabled()
    ? setTimeout(() => announceCurrentSong(guildId, currentSong), TTS_ANNOUNCE_DELAY_MS)
    : null;

  // Save the timers
  timers.set(guildId, { preloadTimer, confirmTimer, announceTimer });

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
 * @param {string} guildId
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
    const sinceCrossfade = sq.crossfadeStartTime ? Date.now() - sq.crossfadeStartTime : Infinity;
    if (sq.isCrossfading || sinceCrossfade < CROSSFADE_DURATION_MS) {
      if (sq.isCrossfading) {
        console.warn('⚠️  [PRELOAD] Skip: crossfade in progress (flag=true), waiting for crossfade to finish before preload');
        schedulePreloadRetry(guildId, CROSSFADE_DURATION_MS);
      } else {
        console.warn(`⚠️  [PRELOAD] Skip: crossfade started only ${sinceCrossfade}ms ago (< ${CROSSFADE_DURATION_MS}ms), waiting more`);
        schedulePreloadRetry(guildId, CROSSFADE_DURATION_MS - sinceCrossfade + PRELOAD_CROSSFADE_MARGIN_MS);
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
    const outcome = await commandQueue.run(
      guildId,
      'preload_load',
      () => { sq.mixer.load(nextSong.url, nextDeck, false); },
      { timeout: 8000, retries: 1 }
    );

    if (!outcome.success) {
      console.error(`❌ [PRELOAD] Load failed: ${outcome.error.message}`);
      sq.nextDeckLoaded = null;
      sq.nextDeckTarget = null;
      return;
    }

    // Invalidate ONLY if the queue was actually modified (skip, clear, add songs).
    // DO NOT invalidate if the version changed for independent reasons (buffer ready, etc).
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
    bindDeckSong(sq, nextDeck, nextIndexBefore, nextSong.url);
    console.log(`📥 [PRELOAD] Deck ${nextDeck}: "${sanitizeTitle(nextSong.title)}"`);
  } catch (e) {
    console.error(`❌ [PRELOAD] Error: ${e.message}`);
  }
}

/**
 * Invalidates the current preload and starts a new one.
 * Called whenever the queue content changes (add, remove, shuffle, clear),
 * because the song sitting on the inactive deck may no longer be the next one.
 * @param {string} guildId
 */
async function updatePreloadAfterQueueChange(guildId) {
  try {
    const sq = queue.get(guildId);
    if (!sq || !isMixerAlive(sq)) return;

    sq.nextDeckLoaded = null;
    sq.nextDeckTarget = null;
    // Also invalidate the binding of the inactive deck (it was the preload deck):
    // it will be rewritten by the new preload with the correct song.
    if (sq.currentDeck) {
      bindDeckSong(sq, sq.currentDeck === 'A' ? 'B' : 'A', null, null);
    }
    await preloadNextSong(guildId);
  } catch (e) {
    console.error('❌ [PRELOAD-UPDATE] Error:', e);
  }
}

/**
 * Handles the 'end' event from Rust (track ended naturally).
 *
 * When fade is ON the transition has normally already been started by the
 * 'approaching_end' event (3s earlier) or by a manual skip; when fade is OFF
 * the instant skip happens right here.
 * @param {string} guildId
 */
async function handleTrackEnd(guildId) {
  const sq = queue.get(guildId);
  if (!sq) return;

  // Ignore events if mixer is no longer active
  if (!isMixerAlive(sq)) return;

  // Clean preload timers when track ends
  clearAllTimers(guildId);

  // Check if a skip is in progress (avoid race condition)
  if (hasSkipInProgress(guildId)) {
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
    await autoSkip(guildId);
  } else {
    console.log('🏁 [TRACK-END] Last song ended, queue finished');
    await endQueue(guildId);
  }
}

/**
 * Handles the 'deck_changed' event from Rust (logging only).
 * State is already updated by SkipManager optimistically.
 * @param {string} guildId
 * @param {string} newDeck
 */
function handleDeckChanged(guildId, newDeck) {
  console.log(`🔀 [DECK-CHANGED] guild=${guildId} Rust: deck=${newDeck}`);
}

export {
  onSongStart,
  preloadNextSong,
  updatePreloadAfterQueueChange,
  handleTrackEnd,
  handleDeckChanged,
  clearAllTimers,
  cancelPlaybackFallback
};
