//! Handling of the commands Node.js sends over stdin.

use crate::protocol::{send_log, InputCommand};
use crate::state::{deck_name, Crossfade, MixerState, PendingTransition};

/// Outcome of a command: the mixer loop stops when Node.js asks it to.
pub enum CommandOutcome {
    Continue,
    Shutdown
}

/// Applies one command from Node.js. Commands naming an unknown deck are
/// ignored: `deck_name` is the single place deck identity is validated.
pub fn apply_command(state: &mut MixerState, cmd: InputCommand) -> CommandOutcome {
    match cmd {
        InputCommand::Load {
            url,
            deck,
            autoplay
        } => {
            let Some(deck) = deck_name(&deck) else {
                return CommandOutcome::Continue;
            };

            // Loading over the deck a crossfade is fading OUT of would pull the
            // source audio away mid-fade: finish the fade instantly instead.
            if let (Some(cf), true) = (state.crossfade.as_ref(), deck == state.active_deck) {
                let target = cf.target;
                send_log(
                    "info",
                    &format!("Load on source deck during crossfade → snap to {}", target)
                );
                state.crossfade = None;
                state.switch_to(target);
                send_log(
                    "deck_changed",
                    &format!("deck={}, triggered_by=crossfade_snap", target)
                );
            }

            state.deck_mut(deck).load(url);
            send_log(
                "info",
                &format!(
                    "{} on deck {}",
                    if autoplay { "Load" } else { "Preload" },
                    deck
                )
            );
        }

        InputCommand::Play { deck } => {
            let Some(deck) = deck_name(&deck) else {
                return CommandOutcome::Continue;
            };
            state.crossfade = None;
            state.stall = None;
            state.is_playing = true;
            state.switch_to(deck);
            send_log("info", &format!("Play deck {}", deck));
            send_log(
                "deck_changed",
                &format!("deck={}, triggered_by=play_command", deck)
            );
        }

        InputCommand::StopDeck { deck } => {
            let Some(deck) = deck_name(&deck) else {
                return CommandOutcome::Continue;
            };
            state.stall = None;
            send_log("debug", &format!("Stopping deck {}", deck));

            // Full deck reset, as if it were brand new
            state.reset_deck(deck);

            if deck == state.active_deck {
                state.is_playing = false;
                send_log("info", &format!("Playback stopped on deck {}", deck));
            }
        }

        InputCommand::Crossfade {
            duration_ms,
            to_deck
        } => {
            let Some(target) = deck_name(&to_deck) else {
                return CommandOutcome::Continue;
            };
            state.stall = None;
            if target == state.active_deck || state.crossfade.is_some() {
                return CommandOutcome::Continue;
            }

            state.deck_mut(target).poll_receiver();
            if state.is_ready(target) || state.download_complete(target) {
                // A crossfade always means playback, even if the output was
                // halted because the previous deck turned out unplayable.
                state.is_playing = true;
                state.pending = None;
                send_log(
                    "crossfade_started",
                    &format!("from={}, to={}", state.active_deck, target)
                );
                // Built through the constructor, like the deferred path does:
                // it is the only place that guarantees a non-zero span, and the
                // mix ratio is divided by it on every sample.
                state.crossfade = Some(Crossfade::new(target, duration_ms));
            } else {
                // Target not ready: keep playing the current deck and fade as
                // soon as the download delivers something.
                state.pending = Some(PendingTransition {
                    target,
                    since: std::time::Instant::now(),
                    is_crossfade: true,
                    duration_ms
                });
                send_log("info", "⏳ Crossfade pending: target deck not ready");
            }
        }

        InputCommand::SetLoop { enabled } => {
            state.loop_mode = enabled;
            send_log(
                "info",
                &format!(
                    "Loop mode: {}",
                    if enabled { "enabled" } else { "disabled" }
                )
            );
        }

        InputCommand::SkipTo { target_deck } => {
            let Some(target) = deck_name(&target_deck) else {
                return CommandOutcome::Continue;
            };
            state.stall = None;
            if target == state.active_deck {
                return CommandOutcome::Continue;
            }

            send_log(
                "info",
                &format!("Skip: {} -> {}", state.active_deck, target)
            );
            state.deck_mut(target).poll_receiver();

            if state.is_ready(target) || state.download_complete(target) {
                send_log("buffer_ready", target);

                let old = state.active_deck;
                state.reset_deck(old);
                state.crossfade = None;
                state.pending = None;
                state.is_playing = true;
                state.switch_to(target);

                send_log("info", &format!("⚡ Immediate skip → deck {}", target));
                send_log(
                    "deck_changed",
                    &format!("deck={}, triggered_by=skip_command", target)
                );
            } else {
                // Target not ready: keep playing the current deck for now.
                state.pending = Some(PendingTransition {
                    target,
                    since: std::time::Instant::now(),
                    is_crossfade: false,
                    duration_ms: 0
                });
                send_log(
                    "info",
                    &format!(
                        "⏳ Skip pending: deck {} not ready, continuing current playback",
                        target
                    )
                );
            }
        }

        InputCommand::PauseAll => {
            state.is_playing = false;
            send_log("info", "Paused all playback");
        }

        InputCommand::ResumeAll => {
            state.is_playing = true;
            send_log("info", "Resumed all playback");
        }

        InputCommand::RestartDeck { deck } => {
            let Some(deck) = deck_name(&deck) else {
                return CommandOutcome::Continue;
            };
            send_log(
                "info",
                &format!(
                    "Restarting deck {} for replay ({} samples available)",
                    deck,
                    state.deck(deck).full_samples.len()
                )
            );
            state.deck_mut(deck).restart();
            send_log("deck_restarted", &format!("deck={}", deck));
        }

        InputCommand::Stop => {
            send_log("info", "Graceful shutdown");
            return CommandOutcome::Shutdown;
        }
    }

    CommandOutcome::Continue
}
