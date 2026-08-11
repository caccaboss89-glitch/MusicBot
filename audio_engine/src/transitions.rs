//! Everything that changes which deck is being heard, outside the mixing loop
//! itself: unplayable-deck reporting, the gapless stall, deferred transitions
//! and the buffer-ready edge detection.

use std::time::{Duration, Instant};

use crate::protocol::send_log;
use crate::state::{Crossfade, MixerState, PendingTransition};

/// How long a deferred skip/crossfade waits for its target before running anyway.
const PENDING_TIMEOUT_SECS: u64 = 8;

/// How long the output stays silent waiting for a still-downloading deck.
const AUTO_GAPLESS_STALL_TIMEOUT_SECS: u64 = 10;

/// How long a fade may sit with a target deck that produces no audio.
/// A fade blocks every recovery path in the loop, so it must not wait forever.
const CROSSFADE_STALL_TIMEOUT_SECS: u64 = 10;

/// A download that produced no data at all for this long is not coming back.
const DOWNLOAD_STUCK_SECS: u64 = 30;

/// Reports decks whose download ended without a single sample.
///
/// `blocking` tells Node.js whether playback is actually stuck on this deck, as
/// opposed to a preload that simply went to waste: only the former warrants
/// warning the users and skipping the track.
pub fn detect_failed_decks(state: &mut MixerState) {
    for name in ["A", "B"] {
        let just_failed = {
            let deck = state.deck(name);
            deck.download_failed && !deck.fail_sent
        };
        if !just_failed {
            continue;
        }
        state.deck_mut(name).fail_sent = true;

        let is_active = state.active_deck == name;
        let is_stall_target = state.stall.as_ref().is_some_and(|s| s.target == name);
        let is_crossfade_target = state.crossfade.as_ref().is_some_and(|c| c.target == name);
        let blocking = is_active || state.is_awaited(name);

        send_log(
            "deck_failed",
            &format!("deck={}, blocking={}", name, blocking)
        );

        if !blocking {
            continue;
        }

        if is_stall_target {
            state.stall = None;
        }
        if state.pending.as_ref().is_some_and(|p| p.target == name) {
            state.pending = None;
        }
        // A fade towards a deck that will never produce audio would hold
        // `crossfade` set for good, and the checks below (plus the end-of-track
        // events) all require that no fade is in flight.
        if is_crossfade_target {
            state.crossfade = None;
        }

        // Stop emitting audio only when nothing is left to play: the failed
        // deck is the active one, or the active one already ran out and was
        // waiting for it. A deck that was merely the target of a skip must not
        // silence the track still playing.
        if state.crossfade.is_none() && (is_active || is_stall_target) {
            state.is_playing = false;
        }
    }
}

/// Resolves a gapless stall: the active deck ended while the other one was
/// still downloading, so the output is silent until its first samples land.
pub fn poll_stall(state: &mut MixerState) {
    let Some(stall) = state.stall.as_ref() else {
        return;
    };
    let target = stall.target;
    let since = stall.since;

    state.deck_mut(target).poll_receiver();

    if state.deck(target).has_samples() {
        send_log(
            "info",
            &format!(
                "⚡ Auto-gapless stall resolved after {}ms → deck {}",
                since.elapsed().as_millis(),
                target
            )
        );

        let previous = state.active_deck;
        state.reset_deck(previous);
        state.switch_to(target);
        state.stall = None;

        send_log("auto_end_switch", target);
        send_log(
            "deck_changed",
            &format!("deck={}, triggered_by=auto_gapless_stall", target)
        );
        return;
    }

    if since.elapsed() >= Duration::from_secs(AUTO_GAPLESS_STALL_TIMEOUT_SECS) {
        send_log(
            "info",
            &format!(
                "⏰ Auto-gapless stall timeout ({}s) → deck {} unplayable",
                AUTO_GAPLESS_STALL_TIMEOUT_SECS, target
            )
        );
        send_log("deck_failed", &format!("deck={}, blocking=true", target));
        // Already reported: keep `detect_failed_decks` from sending a second
        // report when the stuck download finally gives up with no samples.
        state.deck_mut(target).fail_sent = true;
        state.stall = None;
        state.is_playing = false;
    }
}

/// Runs a deferred transition once its target deck is usable, or once waiting
/// any longer would cost more than starting slightly early.
pub fn poll_pending(state: &mut MixerState) {
    let Some(pending) = state.pending.as_ref() else {
        return;
    };
    let PendingTransition {
        target,
        since,
        is_crossfade,
        duration_ms
    } = *pending;

    let ready = state.is_ready(target);
    let download_done = state.download_complete(target);
    let timed_out = since.elapsed() >= Duration::from_secs(PENDING_TIMEOUT_SECS);

    if !ready && !download_done && !timed_out {
        return;
    }

    send_log(
        "info",
        &format!(
            "✅ Pending {} executed after {}ms (ready={}, done={}, timeout={})",
            if is_crossfade { "crossfade" } else { "skip" },
            since.elapsed().as_millis(),
            ready,
            download_done,
            timed_out
        )
    );
    state.pending = None;

    if is_crossfade {
        // Do NOT reset the previous deck: the fade still mixes its audio.
        state.is_playing = true;
        send_log(
            "crossfade_started",
            &format!("from={}, to={}", state.active_deck, target)
        );
        state.crossfade = Some(Crossfade::new(target, duration_ms));
    } else {
        let previous = state.active_deck;
        state.reset_deck(previous);
        state.crossfade = None;
        state.is_playing = true;
        state.switch_to(target);
        send_log("info", &format!("⚡ Skip completed → deck {}", target));
        send_log(
            "deck_changed",
            &format!("deck={}, triggered_by=pending_skip", target)
        );
    }

    send_log("buffer_ready", target);
}

/// Aborts a fade whose target deck never starts producing audio.
///
/// The mixing loop holds a fade in place while the target is empty, so that it
/// plays the source at full volume instead of fading into silence. If the
/// target stays empty for good, that hold would outlive the source deck and the
/// output would be silent forever, with every end-of-track and auto-gapless
/// path disabled because a fade is nominally in flight.
pub fn poll_crossfade_stall(state: &mut MixerState) {
    let Some(crossfade) = state.crossfade.as_ref() else {
        return;
    };
    let target = crossfade.target;
    let target_has_audio = state.deck(target).has_samples();

    let Some(crossfade) = state.crossfade.as_mut() else {
        return;
    };
    if target_has_audio {
        crossfade.stalled_since = None;
        return;
    }

    let stalled_since = *crossfade.stalled_since.get_or_insert_with(Instant::now);
    if stalled_since.elapsed() < Duration::from_secs(CROSSFADE_STALL_TIMEOUT_SECS) {
        return;
    }

    send_log(
        "error",
        &format!(
            "⏰ Crossfade to deck {} stalled {}s with no audio → track unplayable",
            target, CROSSFADE_STALL_TIMEOUT_SECS
        )
    );
    send_log("deck_failed", &format!("deck={}, blocking=true", target));
    state.deck_mut(target).fail_sent = true;
    state.crossfade = None;

    // The source deck keeps playing if it still has audio: Node.js is skipping
    // past the failed track and there is no reason to go silent before it does.
    if !state.active().has_samples() {
        state.is_playing = false;
    }
}

/// Tells Node.js when the idle deck becomes playable, on the rising edge only.
pub fn emit_buffer_ready_edges(state: &mut MixerState) {
    for name in ["A", "B"] {
        let ready = state.is_ready(name);
        // Only the idle deck is worth reporting: the active one is audibly ready.
        if name != state.active_deck && ready && !state.deck(name).buffer_prev_ready {
            send_log("buffer_ready", name);
        }
        state.deck_mut(name).buffer_prev_ready = ready;
    }
}

/// Decides what happens when the active deck runs out and the mixing loop could
/// not switch mid-chunk: loop the track, wait for a download, or report the end.
pub fn handle_track_end(state: &mut MixerState) {
    let should_handle_end = {
        let deck = state.active();
        deck.has_ended
            && deck.receiver.is_none()
            && deck.samples_played > 0
            && !deck.end_sent
            && !deck.has_samples()
    };
    if !should_handle_end {
        return;
    }
    state.active_mut().end_sent = true;

    if state.loop_mode {
        state.active_mut().restart();
        send_log("auto_loop_restart", state.active_deck);
        send_log(
            "info",
            &format!("🔁 Auto-loop: deck {} restarted from cache", state.active_deck)
        );
        return;
    }

    let other = state.idle_deck();
    let other_deck = state.deck(other);
    let other_samples = other_deck.available_samples();
    let other_downloading = other_deck.receiver.is_some();
    let other_cached = other_deck.full_samples.len();
    let load_started_at = other_deck.load_started_at;

    send_log(
        "info",
        &format!(
            "🔍 Auto-gapless check: other deck {} → samples={}, downloading={}, has_ended={}, full_samples={}",
            other, other_samples, other_downloading, other_deck.has_ended, other_cached
        )
    );

    if other_samples > 0 {
        // The next track is buffered: switch with no gap.
        let previous = state.active_deck;
        state.reset_deck(previous);
        state.switch_to(other);
        send_log("auto_end_switch", other);
        send_log(
            "deck_changed",
            &format!("deck={}, triggered_by=auto_gapless", other)
        );
        send_log("info", &format!("⚡ Auto-gapless: instant switch → deck {}", other));
        return;
    }

    if other_downloading {
        let stuck = load_started_at
            .is_some_and(|started| started.elapsed() >= Duration::from_secs(DOWNLOAD_STUCK_SECS));
        if stuck {
            send_log(
                "error",
                &format!(
                    "⏰ Auto-gapless: deck {} downloading for >{}s with no data → track unplayable",
                    other, DOWNLOAD_STUCK_SECS
                )
            );
            send_log("deck_failed", &format!("deck={}, blocking=true", other));
            // Already reported: don't report it again when the stuck download
            // finally gives up with no samples.
            state.deck_mut(other).fail_sent = true;
            state.is_playing = false;
        } else {
            send_log(
                "info",
                &format!(
                    "⏸️  Auto-gapless stall: deck {} downloading ({}ms), waiting for first data...",
                    other,
                    load_started_at.map(|t| t.elapsed().as_millis()).unwrap_or(0)
                )
            );
            state.stall = Some(crate::state::Stall {
                target: other,
                since: Instant::now()
            });
        }
        return;
    }

    // Nothing queued on the other deck: the queue is over as far as the engine
    // is concerned, and Node.js decides what happens next.
    send_log("end", state.active_deck);
    send_log(
        "debug",
        &format!(
            "Deck {} ended (no next song ready on deck {}, full_samples={})",
            state.active_deck, other, other_cached
        )
    );
    state.is_playing = false;
}
