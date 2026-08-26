/**
 * src/audio/rust-events.js
 *
 * Routing of the events emitted by the Rust audio engine, plus the policies that
 * depend on them: crediting a play to the statistics, and reacting to a track
 * that cannot stream.
 *
 * This module sits ABOVE the playback modules: it calls into SkipManager /
 * PlaybackEngine / UI, never the other way around.
 */

import * as PlaybackEngine from './PlaybackEngine.js';
import * as SkipManager from './SkipManager.js';
import { queue } from '../state/globals.js';
import { stateVersionManager } from '../state/StateVersion.js';
import { getNextSong, resolveDeckIndex, bindDeckSong } from '../queue/QueueManager.js';
import { saveQueueState } from '../queue/persistence.js';
import { sanitizeTitle } from '../utils/sanitize.js';
import { MAX_CONSECUTIVE_PLAYBACK_FAILURES } from '../../config/index.js';
import { createPlaybackErrorEmbed, refreshDashboard } from '../ui/index.js';
import { recordSongStart, incrementSongsCompleted } from '../database/stats.js';

// ─── Stream error tracking ─────────────────────────────────

// guildId -> Map<url, { errors: number, lastErrorAt: number, blacklistedAt: number|null }>
// One entry per song holds both the partial error count and the blacklist flag,
// so they always expire together: a song that keeps failing every few minutes
// can never have its progress towards the blacklist silently reset.
const songErrors = new Map();
const SONG_ERROR_TTL_MS = 60 * 60 * 1000; // 1 hour: transient errors are forgotten
const STREAM_ERRORS_BEFORE_BLACKLIST = 3;
const ERROR_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Returns the error record of a song, dropping it if it has expired.
 * @param {string} guildId
 * @param {string} url
 * @returns {{errors: number, lastErrorAt: number, blacklistedAt: number|null}|null}
 */
function getSongErrors(guildId, url) {
  const guildErrors = songErrors.get(guildId);
  if (!guildErrors) return null;
  const entry = guildErrors.get(url);
  if (!entry) return null;
  if (Date.now() - entry.lastErrorAt > SONG_ERROR_TTL_MS) {
    guildErrors.delete(url);
    if (guildErrors.size === 0) songErrors.delete(guildId);
    return null;
  }
  return entry;
}

/**
 * Checks if a song has been marked unplayable and is still within the TTL.
 * @param {string} guildId
 * @param {string} url
 * @returns {boolean}
 */
function isFailedSong(guildId, url) {
  const entry = getSongErrors(guildId, url);
  return !!entry && entry.blacklistedAt !== null;
}

/**
 * Records a stream error for a song, blacklisting it after enough failures.
 * @param {string} guildId
 * @param {string} url
 * @returns {boolean} true if the song has just been marked unplayable
 */
function recordStreamError(guildId, url) {
  if (!songErrors.has(guildId)) songErrors.set(guildId, new Map());
  const guildErrors = songErrors.get(guildId);

  const entry = getSongErrors(guildId, url) || { errors: 0, lastErrorAt: 0, blacklistedAt: null };
  entry.errors++;
  entry.lastErrorAt = Date.now();
  guildErrors.set(url, entry);

  if (entry.blacklistedAt !== null || entry.errors < STREAM_ERRORS_BEFORE_BLACKLIST) return false;

  entry.blacklistedAt = Date.now();
  console.error(`❌ [STREAM] Song marked as unplayable (${entry.errors} errors): ${url.substring(0, 60)}`);
  return true;
}

function clearStreamErrors(guildId) {
  songErrors.delete(guildId);
}

// Periodic sweep so guilds that stop erroring don't hold entries forever
setInterval(() => {
  const now = Date.now();
  for (const [guildId, guildErrors] of songErrors) {
    for (const [url, entry] of guildErrors) {
      if (now - entry.lastErrorAt > SONG_ERROR_TTL_MS) guildErrors.delete(url);
    }
    if (guildErrors.size === 0) songErrors.delete(guildId);
  }
}, ERROR_SWEEP_INTERVAL_MS);

// ─── Buffer ready ───────────────────────────────────────────

/**
 * A deck reported it holds enough audio to be switched to.
 * @param {string} guildId
 * @param {string} deck - 'A' | 'B'
 */
async function handleBufferReady(guildId, deck) {
  try {
    const sq = queue.get(guildId);
    if (!sq) return;

    const stateVersion = stateVersionManager.get(guildId);

    sq.bufferReady = sq.bufferReady || {};
    sq.bufferReady[deck] = true;

    stateVersion.incrementVersion('buffer_ready');

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

// ─── Event routing ──────────────────────────────────────────

// A deferred transition older than this is considered stuck, so the engine's own
// end-of-track signals are allowed to take over again.
const STUCK_TRANSITION_MS = 25000;

// Events the Rust engine emits and this module reacts to. Anything else it
// sends (info, debug, stream_opened, deck_restarted, …) is logged by
// AudioMixerController and needs no handling here.
const RUST_EVENT_HANDLERS = {
  buffer_ready: handleBufferReady,
  stream_error: handleStreamError,
  crossfade_started: () => console.log('🎚️  [RUST] Crossfade started'),
  approaching_end: handleApproachingEnd,
  end: (guildId) => PlaybackEngine.handleTrackEnd(guildId).catch(e => {
    console.error('❌ [TRACK-END] Error in handleTrackEnd:', e);
  }),
  auto_end_switch: (guildId, data) => handleAutoEndSwitch(guildId, data).catch(e => {
    console.error('❌ [AUTO-GAPLESS] Error in handleAutoEndSwitch:', e);
  }),
  auto_loop_restart: (guildId, data) => handleAutoLoopRestart(guildId, data),
  playback_confirmed: (guildId, data) => {
    // The engine reported real audio: the statistics fallback it guards against
    // can no longer happen for this song, so it must not fire (and warn) later.
    PlaybackEngine.cancelPlaybackFallback(guildId);
    return confirmPlayback(guildId, data).catch(e => {
      console.error('❌ [PLAY-CONFIRM] Error in confirmPlayback:', e);
    });
  },
  deck_failed: (guildId, data) => handleDeckFailed(guildId, data).catch(e => {
    console.error('❌ [DECK-FAILED] Error in handleDeckFailed:', e);
  }),
  deck_changed: (guildId, data) => {
    const match = String(data || '').match(/deck=([A-C])/);
    PlaybackEngine.handleDeckChanged(guildId, match ? match[1] : String(data || ''));
  },
  error: (guildId, data) => console.error(`🦀 [RUST-${guildId}] ERROR`, data || '')
};

/**
 * Receives logs/events from the Rust process.
 * @param {string} guildId
 * @param {{event: string, data?: string, _mixerGeneration?: number}} log
 */
async function handleRustEvent(guildId, log) {
  try {
    if (!log || !log.event) return;

    // Ignore events from an obsolete mixer (generation no longer current)
    if (log._mixerGeneration) {
      const sq = queue.get(guildId);
      if (sq && sq.mixerGeneration && log._mixerGeneration !== sq.mixerGeneration) return;
    }

    const handler = RUST_EVENT_HANDLERS[log.event];
    if (handler) await handler(guildId, log.data);
  } catch (e) {
    console.error('❌ [RUST-EVENT] Error routing event:', e);
  }
}

/**
 * A deck reported a decoding error: blacklist the song after enough of them.
 * @param {string} guildId
 * @param {string} data - Event payload
 */
function handleStreamError(guildId, data) {
  const dataStr = String(data || '').toLowerCase();
  if (!dataStr.includes('opus') || !dataStr.includes('error')) return;

  const sq = queue.get(guildId);
  if (!sq || !sq.currentDeckLoaded) return;

  if (recordStreamError(guildId, sq.currentDeckLoaded)) {
    console.error('🛑 [STREAM] Auto-skip corrupted song');
    SkipManager.autoSkip(guildId).catch(e => {
      console.error('❌ [STREAM] autoSkip error:', e);
    });
  }
}

/**
 * Rust signals the active track is 3 seconds from its end.
 * @param {string} guildId
 */
function handleApproachingEnd(guildId) {
  const sq = queue.get(guildId);
  if (!sq) return;

  // A pending transition already owns the change: completePendingTransition()
  // fires when the buffer is ready. Only override it once it is clearly stuck.
  const ptAge = sq.pendingTransition ? (Date.now() - sq.pendingTransition.startTime) : Infinity;
  if (ptAge < STUCK_TRANSITION_MS) {
    console.log(`⏳ [APPROACHING-END] Pending transition in progress (${Math.round(ptAge / 1000)}s) – skip auto-crossfade`);
    return;
  }

  const fadeEnabled = !!(sq.fadeEnabled && sq.mixer && sq.mixer.crossfade);
  const nextSong = getNextSong(sq);

  if (fadeEnabled && nextSong) {
    console.log('🎚️  [APPROACHING-END] 3s before the end – automatic crossfade');
    SkipManager.autoSkip(guildId).catch(e => {
      console.error('❌ [APPROACHING-END] autoSkip error:', e);
    });
  } else if (!nextSong) {
    console.log('⏭️  [APPROACHING-END] No next track – waiting for natural end');
  } else {
    console.log('⏭️  [APPROACHING-END] 3s before the end – fade OFF, waiting for natural end');
  }
}

// ─── Playback confirmation (statistics) ─────────────────────

/**
 * A deck confirmed it is really pushing audio out (or the fallback expired).
 * This is the ONLY place where a song is credited to the statistics: counting
 * here means every transition type is covered (skip, crossfade, gapless, loop)
 * while a song that never manages to stream is never counted.
 * @param {string} guildId
 * @param {string} deck - Deck that confirmed playback ('A' | 'B')
 * @param {string} [source='engine'] - 'engine' (Rust event) or 'fallback' (timer)
 */
async function confirmPlayback(guildId, deck, source = 'engine') {
  try {
    const sq = queue.get(guildId);
    if (!sq || sq.isPaused || !deck) return;

    let index = resolveDeckIndex(sq, deck);
    if (index === null || index === undefined) {
      // No binding for this deck: only the active deck can be trusted
      if (deck !== sq.currentDeck) return;
      index = sq.playIndex || 0;
    }
    const song = sq.songs && sq.songs[index];
    if (!song || !song.url) return;

    // songStartTime changes on every real (re)start, so replays and loops are
    // counted again while duplicate events for the same playback are not.
    const playToken = `${deck}:${index}:${sq.songStartTime}`;
    if (sq._countedPlayToken === playToken) return;
    sq._countedPlayToken = playToken;

    // Real audio is flowing: the streaming chain works again
    sq._consecutiveFailures = 0;

    recordSongStart(guildId, song, sq.voiceChannel);
    console.log(`📊 [STATS] Play counted (${source}): "${sanitizeTitle(song.title)}"`);
  } catch (e) {
    console.warn('⚠️ [PLAY-CONFIRM] Unable to credit the play:', e.message);
  }
}

// ─── Unplayable song handling ───────────────────────────────

// A deck failure can only be worked around a few times before giving up: past
// that, retrying just delays the "playback is broken" message.
const MAX_SKIP_RETRIES = 3;

/**
 * Sends the playback error warning to the guild text channel.
 * @param {object} sq - Server queue
 * @param {object|null} song - Song that failed to stream
 * @param {boolean} willSkip - true if the next song is being started
 */
async function notifyPlaybackError(sq, song, willSkip) {
  try {
    const channel = sq.textChannel;
    if (!channel || !channel.send) return;
    await channel.send({ embeds: [createPlaybackErrorEmbed(song, willSkip)] });
  } catch (e) {
    console.warn('⚠️ [DECK-FAILED] Unable to notify the text channel:', e.message);
  }
}

/**
 * Moves past an unplayable song. A skip can be refused for a transient reason
 * (crossfade running, throttle, another skip in flight): those are retried
 * rather than treated as "playback is stuck", which would kill the whole queue.
 * @param {string} guildId
 * @param {number} targetIndex
 * @param {number} [attempt=1]
 * @returns {Promise<boolean>} true if the skip went through
 */
async function skipPastFailure(guildId, targetIndex, attempt = 1) {
  const outcome = await SkipManager.skipToIndex(guildId, targetIndex);
  if (outcome.ok) return true;

  if (outcome.retryable && attempt < MAX_SKIP_RETRIES) {
    const delay = outcome.retryAfterMs || 500;
    console.log(`⏳ [DECK-FAILED] Skip refused (${outcome.reason}), retry ${attempt + 1}/${MAX_SKIP_RETRIES} in ${delay}ms`);
    await new Promise(r => setTimeout(r, delay));
    return skipPastFailure(guildId, targetIndex, attempt + 1);
  }

  console.warn(`⚠️  [DECK-FAILED] Skip definitively refused (${outcome.reason})`);
  return false;
}

/**
 * Rust reported a deck whose download produced no audio at all.
 * Blocking means playback is stuck on that deck: warn the users and move past
 * the song. Otherwise it is only a stale preload, silently discarded.
 * @param {string} guildId
 * @param {string} data - Event payload, "deck=<A|B>, blocking=<bool>"
 */
async function handleDeckFailed(guildId, data) {
  const sq = queue.get(guildId);
  if (!sq) return;

  const payload = String(data || '');
  const deck = (payload.match(/deck=([AB])/) || [])[1];
  if (!deck) return;

  // A deferred transition waiting on this deck is invisible to Rust, but it
  // means playback is stuck here too — including a replacement song that fails
  // right after the one it was meant to replace.
  const awaitingDeck = !!(sq.pendingTransition && sq.pendingTransition.targetDeck === deck);
  const blocking = payload.includes('blocking=true') || awaitingDeck;

  const failedIndex = resolveDeckIndex(sq, deck);
  const song = (failedIndex !== null && failedIndex !== undefined) ? sq.songs[failedIndex] : null;
  const title = song ? sanitizeTitle(song.title) : 'unknown song';

  if (!blocking) {
    // Failed preload: drop it, the song is retried when its turn actually comes
    console.warn(`⚠️  [DECK-FAILED] Preload on deck ${deck} received no audio ("${title}"), discarded`);
    if (sq.nextDeckTarget === deck) {
      sq.nextDeckLoaded = null;
      sq.nextDeckTarget = null;
    }
    bindDeckSong(sq, deck, null, null);
    return;
  }

  console.error(`❌ [DECK-FAILED] Deck ${deck} received no audio: "${title}"`);

  // A transition waiting on this deck will never complete: drop it
  if (sq.pendingTransition && sq.pendingTransition.targetDeck === deck) {
    if (sq.pendingTransition._cleanupTimer) clearTimeout(sq.pendingTransition._cleanupTimer);
    sq.pendingTransition = null;
  }
  sq.loadingFooter = null;
  bindDeckSong(sq, deck, null, null);

  // Move past the unplayable song, or close the queue if it was the last one.
  // Failing songs in a row means streaming itself is broken (yt-dlp, network,
  // YouTube blocking): stop instead of grinding through the queue one error at a time.
  const nextIndex = ((failedIndex !== null && failedIndex !== undefined) ? failedIndex : (sq.playIndex || 0)) + 1;
  sq._consecutiveFailures = (sq._consecutiveFailures || 0) + 1;
  const giveUp = sq._consecutiveFailures >= MAX_CONSECUTIVE_PLAYBACK_FAILURES || nextIndex >= sq.songs.length;

  if (song) {
    recordStreamError(guildId, song.url);
    await notifyPlaybackError(sq, song, !giveUp);
  }

  if (giveUp) {
    console.log(`🏁 [DECK-FAILED] Ending queue (failures=${sq._consecutiveFailures}, next=${nextIndex}/${sq.songs.length})`);
    sq._consecutiveFailures = 0;
    await SkipManager.endQueue(guildId);
    return;
  }

  // The engine stopped the output: if the skip cannot go through we would be
  // left silent with a dashboard still showing a song, so close the queue.
  if (!await skipPastFailure(guildId, nextIndex)) {
    console.warn('⚠️  [DECK-FAILED] Ending queue to avoid a stuck playback');
    sq._consecutiveFailures = 0;
    await SkipManager.endQueue(guildId);
  }
}

// ─── Auto-gapless handlers ──────────────────────────────────

/**
 * Rust switched automatically to the preloaded deck when the active deck finished.
 * Updates Node.js state without sending commands to Rust (the transition has already occurred).
 * @param {string} guildId
 * @param {string} newDeck
 */
async function handleAutoEndSwitch(guildId, newDeck) {
  try {
    const sq = queue.get(guildId);
    if (!sq) return;

    // If there is a pending transition for this deck (user had already pressed skip
    // while the deck was downloading), let completePendingTransition handle
    // everything: it knows the correct index (may be ≠ nextIndex).
    if (sq.pendingTransition && sq.pendingTransition.targetDeck === newDeck) {
      incrementSongsCompleted();
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

    incrementSongsCompleted();

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

    // Save state and update UI
    saveQueueState(guildId, sq);
    refreshDashboard(sq);

    // Preload the next song on the other deck
    PlaybackEngine.onSongStart(guildId);

    console.log(`⚡ [AUTO-GAPLESS] → "${nextSong ? sanitizeTitle(nextSong.title) : '?'}" (idx=${nextIndex}, deck=${newDeck})`);
  } catch (e) {
    console.error('❌ [AUTO-GAPLESS] handleAutoEndSwitch error:', e);
  }
}

/**
 * Rust automatically restarted the current deck (loop mode).
 * Updates only the timestamps and starts a new preload cycle.
 * @param {string} guildId
 * @param {string} deck
 */
function handleAutoLoopRestart(guildId, deck) {
  try {
    const sq = queue.get(guildId);
    if (!sq) return;

    sq.songStartTime = Date.now();

    const currentSong = sq.songs[sq.playIndex || 0];

    // ── STATS: song completed (loop) – the new play is credited by confirmPlayback ──
    incrementSongsCompleted();

    // Restart the preload timer for the next song
    PlaybackEngine.onSongStart(guildId);

    console.log(`🔁 [AUTO-LOOP] "${currentSong ? sanitizeTitle(currentSong.title) : '?'}" restarted (deck ${deck})`);
  } catch (e) {
    console.error('❌ [AUTO-LOOP] Error handleAutoLoopRestart:', e);
  }
}

// handleBufferReady, handleDeckFailed and recordStreamError are reached through
// the event table above, so they stay internal to this module.
export {
  handleRustEvent,
  confirmPlayback,
  clearStreamErrors,
  isFailedSong
};
