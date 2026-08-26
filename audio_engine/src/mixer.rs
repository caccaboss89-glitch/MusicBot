//! The audio mixing loop: consumes commands from Node.js, mixes the two decks
//! and writes a continuous PCM stream to stdout.
//!
//! Each pass through the loop applies pending commands, lets the transition
//! stages move playback between decks, then produces exactly one PCM chunk.

use crossbeam_channel::Receiver;
use std::io::{self, Write};
use std::thread;
use std::time::{Duration, Instant};

use crate::commands::{apply_command, CommandOutcome};
use crate::config::CHUNK_SIZE;
use crate::events::{emit_approaching_end, emit_playback_confirmed};
use crate::protocol::{send_log, InputCommand};
use crate::state::MixerState;
use crate::transitions::{
    detect_failed_decks, emit_buffer_ready_edges, handle_track_end, poll_crossfade_stall,
    poll_pending, poll_stall
};

/// How long the loop sleeps between checks while nothing is playing.
const IDLE_SLEEP_MS: u64 = 20;

/// Chunks between two buffer-ready sweeps: often enough to be responsive,
/// rare enough not to scan both decks on every single chunk.
const BUFFER_MONITOR_INTERVAL: u32 = 5;

const STATUS_LOG_INTERVAL_SECS: u64 = 30;

/// A deck change that happened part-way through a chunk. Reported after the
/// chunk is written, since the audio for the transition has already gone out.
enum ChunkEvent {
    None,
    /// The active deck ran out and the other one took over gaplessly.
    AutoSwitch(&'static str),
    /// The active deck ran out and restarted itself (loop mode).
    LoopRestart
}

/// Writes one PCM chunk to stdout and flushes it.
/// Errors are propagated on purpose: a partial write would shift the 16-bit
/// sample alignment of the whole stream and every following sample would be
/// decoded as noise, so the caller stops the mixer instead of carrying on.
fn write_pcm_chunk<W: Write>(handle: &mut W, bytes: &[u8]) -> io::Result<()> {
    handle.write_all(bytes)?;
    handle.flush()
}

/// Produces one sample of an in-flight crossfade.
///
/// While the target deck has no audio yet the fade is held in place and the
/// source plays at full volume, so a slow download is heard as a late fade
/// rather than as silence. `poll_crossfade_stall` puts a bound on that wait.
fn mix_crossfade_sample(state: &mut MixerState) -> f32 {
    let target = match state.crossfade.as_ref() {
        Some(crossfade) => crossfade.target,
        None => return 0.0
    };

    if !state.deck(target).has_samples() {
        return state.active_mut().get_next_sample().unwrap_or(0.0);
    }

    // Both decks hold audio: consume from both so neither drifts out of sync.
    let sample_a = state.deck_a.get_next_sample().unwrap_or(0.0);
    let sample_b = state.deck_b.get_next_sample().unwrap_or(0.0);

    let (ratio, completed) = {
        let crossfade = state
            .crossfade
            .as_mut()
            .expect("crossfade presence checked above");
        let ratio = (crossfade.total - crossfade.left) as f32 / crossfade.total as f32;
        crossfade.left = crossfade.left.saturating_sub(1);
        (ratio, crossfade.left == 0)
    };

    let source_is_a = state.active_deck == "A";
    let target_is_a = target == "A";

    if completed {
        // The fade is over: the source deck is not heard any more, so discard
        // it outright instead of only clearing its flags. Every other
        // transition already does this; leaving the deck loaded held its whole
        // sample cache until the next preload overwrote it, and let
        // handle_track_end mistake that leftover audio for a queued track and
        // switch back to the song we just faded away from.
        let previous = state.active_deck;
        state.reset_deck(previous);
        state.crossfade = None;
        state.switch_to(target);
        send_log("info", &format!("Crossfade completed, switched to {}", target));
        send_log(
            "deck_changed",
            &format!("deck={}, triggered_by=crossfade_completion", target)
        );
    }

    let source_sample = if source_is_a { sample_a } else { sample_b };
    let target_sample = if target_is_a { sample_a } else { sample_b };
    let ratio = if completed { 1.0 } else { ratio };

    // Equal-power crossfade: keeps perceived volume constant
    // (linear crossfade causes ~3 dB drop at midpoint)
    source_sample * (1.0 - ratio).sqrt() + target_sample * ratio.sqrt()
}

/// Produces one sample straight from the active deck, taking over from the
/// other deck part-way through the chunk when this one runs dry. Handling the
/// hand-over here rather than after the chunk is what makes it gapless.
fn mix_direct_sample(state: &mut MixerState, event: &mut ChunkEvent) -> f32 {
    if let Some(sample) = state.active_mut().get_next_sample() {
        return sample;
    }

    // `samples_played > 0` guards against ending a deck that never produced
    // audio: that case is an unplayable track, reported as deck_failed.
    let (exhausted, has_played) = {
        let deck = state.active();
        (
            deck.has_ended && deck.receiver.is_none(),
            deck.samples_played > 0
        )
    };
    let can_switch = state.pending.is_none()
        && state.stall.is_none()
        && matches!(event, ChunkEvent::None);

    if !can_switch || !exhausted || !has_played {
        return 0.0;
    }

    if state.loop_mode {
        state.active_mut().restart();
        *event = ChunkEvent::LoopRestart;
        return state.active_mut().get_next_sample().unwrap_or(0.0);
    }

    let other = state.idle_deck();
    if !state.deck(other).has_samples() {
        return 0.0;
    }

    let previous = state.active_deck;
    state.reset_deck(previous);
    state.switch_to(other);
    *event = ChunkEvent::AutoSwitch(other);
    state.active_mut().get_next_sample().unwrap_or(0.0)
}

/// Fills `out` with one chunk of little-endian 16-bit PCM.
/// Returns whether any audible sample was produced, plus any deck change that
/// happened part-way through.
fn mix_chunk(state: &mut MixerState, out: &mut Vec<u8>) -> (bool, ChunkEvent) {
    let mut has_audio = false;
    let mut event = ChunkEvent::None;
    out.clear();

    for _ in 0..CHUNK_SIZE {
        let sample = if state.crossfade.is_some() {
            mix_crossfade_sample(state)
        } else {
            mix_direct_sample(state, &mut event)
        };

        if sample.abs() > 0.0001 {
            has_audio = true;
        }

        let pcm = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&pcm.to_le_bytes());
    }

    (has_audio, event)
}

pub fn mixer_loop(cmd_rx: Receiver<InputCommand>) {
    let mut state = MixerState::new();
    let mut buffer_monitor_counter: u32 = 0;
    // 0 = Node.js asked us to stop, 1 = the PCM stream broke. Leaving the
    // process alive after either would make it a silent zombie: Node.js only
    // learns the engine is gone from the exit of the process.
    let mut exit_code = 0;

    let stdout = io::stdout();
    let mut handle = stdout.lock();
    // Chunk assembled in memory and written in one go: never leaves stdout
    // holding half a sample.
    let mut out_bytes: Vec<u8> = Vec::with_capacity(CHUNK_SIZE * 2);

    send_log("info", "Rust Mixer Ready");
    let mut last_status_log = Instant::now();

    'main: loop {
        // Node -> Rust command handling
        while let Ok(cmd) = cmd_rx.try_recv() {
            if matches!(apply_command(&mut state, cmd), CommandOutcome::Shutdown) {
                break 'main;
            }
        }

        // Updates buffers of ALL decks, even inactive ones
        state.deck_a.poll_receiver();
        state.deck_b.poll_receiver();

        detect_failed_decks(&mut state);
        poll_stall(&mut state);
        poll_pending(&mut state);
        poll_crossfade_stall(&mut state);

        buffer_monitor_counter += 1;
        if buffer_monitor_counter >= BUFFER_MONITOR_INTERVAL {
            buffer_monitor_counter = 0;
            emit_buffer_ready_edges(&mut state);
        }

        // Nothing to play: idle without burning CPU on silent chunks
        if !state.is_playing {
            thread::sleep(Duration::from_millis(IDLE_SLEEP_MS));
            continue;
        }

        // Waiting on a download: emit silence without consuming any samples
        if state.stall.is_some() {
            out_bytes.clear();
            out_bytes.resize(CHUNK_SIZE * 2, 0u8);
            if let Err(e) = write_pcm_chunk(&mut handle, &out_bytes) {
                send_log("error", &format!("Fatal stdout write error: {}", e));
                exit_code = 1;
                break 'main;
            }
            continue;
        }

        let (has_audio, chunk_event) = mix_chunk(&mut state, &mut out_bytes);
        if let Err(e) = write_pcm_chunk(&mut handle, &out_bytes) {
            send_log("error", &format!("Fatal stdout write error: {}", e));
            exit_code = 1;
            break 'main;
        }

        emit_playback_confirmed(&mut state);
        emit_approaching_end(&mut state);

        match chunk_event {
            ChunkEvent::LoopRestart => {
                send_log("auto_loop_restart", state.active_deck);
                send_log(
                    "info",
                    &format!(
                        "🔁 Mid-chunk auto-loop: deck {} restarted from cache",
                        state.active_deck
                    )
                );
            }
            ChunkEvent::AutoSwitch(deck) => {
                send_log("auto_end_switch", deck);
                send_log(
                    "deck_changed",
                    &format!("deck={}, triggered_by=mid_chunk_auto_gapless", deck)
                );
                send_log(
                    "info",
                    &format!("⚡ Mid-chunk auto-gapless: instant switch → deck {}", deck)
                );
            }
            // No transition happened inside the chunk: if the chunk was silent
            // the active deck may have ended without anywhere to go.
            ChunkEvent::None => {
                if !has_audio && state.crossfade.is_none() && state.pending.is_none() {
                    handle_track_end(&mut state);
                }
            }
        }

        if last_status_log.elapsed().as_secs() >= STATUS_LOG_INTERVAL_SECS {
            send_log(
                "debug",
                &format!(
                    "Status - Active: {}, A: {}s played, B: {}s played, pending: {}",
                    state.active_deck,
                    state.deck_a.played_seconds(),
                    state.deck_b.played_seconds(),
                    state.pending.is_some()
                )
            );
            last_status_log = Instant::now();
        }
    }

    // The mixer thread is the process: once it is done there is nothing left to
    // produce audio, so exit instead of idling with stdin still open.
    send_log("info", &format!("Mixer loop ended (exit {})", exit_code));
    std::process::exit(exit_code);
}
