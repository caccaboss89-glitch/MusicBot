//! Edge-triggered notifications the mixer sends to Node.js about the deck that
//! is currently being heard. Both are suppressed during a crossfade, when
//! "the active deck" is momentarily ambiguous.

use crate::config::{CHANNELS, SAMPLE_RATE};
use crate::protocol::send_log;
use crate::state::MixerState;

/// Audio actually pushed out before a playback counts as real (1 second).
const PLAYBACK_CONFIRM_THRESHOLD: usize = SAMPLE_RATE * CHANNELS;

/// Remaining audio at which the track is announced as nearly over (3 seconds).
const APPROACHING_END_THRESHOLD: usize = SAMPLE_RATE * CHANNELS * 3;

/// Reports that the active deck is really producing audio.
///
/// Node.js credits a track to the statistics only on this event, so a track
/// that never manages to stream is never counted as listened to.
pub fn emit_playback_confirmed(state: &mut MixerState) {
    if !state.is_playing || state.crossfade.is_some() {
        return;
    }

    let deck = state.active();
    if deck.play_confirmed_sent || deck.samples_played < PLAYBACK_CONFIRM_THRESHOLD {
        return;
    }

    state.active_mut().play_confirmed_sent = true;
    send_log("playback_confirmed", state.active_deck);
}

/// Reports that the active deck is about to run out, giving Node.js the chance
/// to start a crossfade before the track actually ends.
pub fn emit_approaching_end(state: &mut MixerState) {
    if !state.is_playing || state.crossfade.is_some() {
        return;
    }

    let deck = state.active();
    let approaching = deck.has_ended
        && deck.receiver.is_none()
        && !deck.approaching_end_sent
        && deck.available_samples() < APPROACHING_END_THRESHOLD;
    if !approaching {
        return;
    }

    state.active_mut().approaching_end_sent = true;
    send_log("approaching_end", state.active_deck);
}
