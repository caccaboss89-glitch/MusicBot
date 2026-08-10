//! The audio mixing loop: consumes commands from Node.js, mixes the two decks
//! and writes a continuous PCM stream to stdout.

use crossbeam_channel::Receiver;
use std::io::{self, Write};

use crate::config::{CHANNELS, CHUNK_SIZE, SAMPLE_RATE};
use crate::deck::Deck;
use crate::protocol::{send_log, InputCommand};

/// Writes one PCM chunk to stdout and flushes it.
/// Errors are propagated on purpose: a partial write would shift the 16-bit
/// sample alignment of the whole stream and every following sample would be
/// decoded as noise, so the caller stops the mixer instead of carrying on.
fn write_pcm_chunk<W: Write>(handle: &mut W, bytes: &[u8]) -> io::Result<()> {
    handle.write_all(bytes)?;
    handle.flush()
}

pub fn mixer_loop(cmd_rx: Receiver<InputCommand>) {
    let mut deck_a = Deck::new("A");
    let mut deck_b = Deck::new("B");
    let mut active_deck = "A".to_string();
    let mut crossfading = false;
    let mut crossfade_total = 0;
    let mut crossfade_left = 0;
    let mut target_deck = String::new();
    let mut proactive_crossfade_triggered = false;
    let mut proactive_crossfade_enabled = true; // 🔥 Controls if proactive crossfade is enabled
    let mut loop_mode = false; // 🔁 Loop mode: end of song → restart same deck from full_samples
    let mut buffer_monitor_counter = 0;
    let mut is_playing = false; // NEW: tracks if we're actually playing

    // Pending transition: when target deck is not yet ready,
    // continues to play current deck and switches when data arrives
    // (target_deck_name, since, is_crossfade, crossfade_duration_ms)
    let mut pending_transition: Option<(String, std::time::Instant, bool, u64)> = None;
    const PENDING_TIMEOUT_SECS: u64 = 8;

    // Auto-gapless stall: when active deck ends and other deck has a download
    // in progress but no sample yet, we're in stall (silence) until they arrive.
    // (target_deck_name, stall_start_instant)
    let mut auto_gapless_stall: Option<(String, std::time::Instant)> = None;
    const AUTO_GAPLESS_STALL_TIMEOUT_SECS: u64 = 10;

    // Mid-chunk auto-switch: tracks if an auto-gapless switch happened INSIDE the chunk loop
    // If Some(deck_name), means we switched to that deck inside the chunk
    // After the chunk, we'll send appropriate events
    #[allow(unused_assignments)]
    let mut mid_chunk_auto_switch: Option<String> = None;
    #[allow(unused_assignments)]
    let mut mid_chunk_loop_restart = false; // true if the loop restart happened mid-chunk

    let stdout = io::stdout();
    let mut handle = stdout.lock();
    // Chunk assembled in memory and written in one go: never leaves stdout
    // holding half a sample.
    let mut out_bytes: Vec<u8> = Vec::with_capacity(CHUNK_SIZE * 2);

    send_log("info", "Rust Mixer Ready");

    let mut last_status_log = std::time::Instant::now();

    'main: loop {
        // Node -> Rust Command Handling
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                InputCommand::Load {
                    url,
                    deck,
                    autoplay,
                } => {
                    // If we're loading on the SOURCE deck of an active crossfade,
                    // complete the crossfade instantly before overwriting
                    if crossfading && deck == active_deck {
                        send_log(
                            "info",
                            &format!(
                                "Load on source deck during crossfade → snap to {}",
                                target_deck
                            ),
                        );
                        crossfading = false;
                        proactive_crossfade_triggered = false;
                        crossfade_left = 0;
                        crossfade_total = 0;
                        active_deck = target_deck.clone();
                        if target_deck == "A" {
                            deck_a.samples_played = 0;
                        } else if target_deck == "B" {
                            deck_b.samples_played = 0;
                        }
                        send_log(
                            "deck_changed",
                            &format!("deck={}, triggered_by=crossfade_snap", active_deck),
                        );
                    }

                    if deck == "A" {
                        deck_a.load(url);
                        send_log(
                            "info",
                            &format!("{} on deck A", if autoplay { "Load" } else { "Preload" }),
                        );
                    } else if deck == "B" {
                        deck_b.load(url);
                        send_log(
                            "info",
                            &format!("{} on deck B", if autoplay { "Load" } else { "Preload" }),
                        );
                    }
                }
                InputCommand::Play { deck } => {
                    active_deck = deck.clone();
                    crossfading = false;
                    proactive_crossfade_triggered = false;
                    is_playing = true;
                    auto_gapless_stall = None;
                    if deck == "A" {
                        deck_a.samples_played = 0;
                    } else if deck == "B" {
                        deck_b.samples_played = 0;
                    }
                    send_log("info", &format!("Play deck {}", deck));
                    send_log(
                        "deck_changed",
                        &format!("deck={}, triggered_by=play_command", deck),
                    );
                }
                InputCommand::StopDeck { deck } => {
                    auto_gapless_stall = None;
                    send_log("debug", &format!("Stopping deck {}", deck));

                    // Full deck reset, as if it were brand new
                    if deck == "A" {
                        deck_a = Deck::new("A");
                    } else if deck == "B" {
                        deck_b = Deck::new("B");
                    }

                    if deck == active_deck {
                        is_playing = false;
                        send_log("info", &format!("Playback stopped on deck {}", deck));
                    }
                }
                InputCommand::Crossfade {
                    duration_ms,
                    to_deck,
                } => {
                    auto_gapless_stall = None;
                    if to_deck != active_deck && !crossfading {
                        // Updates target deck buffer
                        if to_deck == "A" {
                            deck_a.poll_receiver();
                        } else if to_deck == "B" {
                            deck_b.poll_receiver();
                        }

                        let target_ready = if to_deck == "A" {
                            deck_a.is_ready_for_crossfade()
                        } else {
                            deck_b.is_ready_for_crossfade()
                        };
                        let download_done = if to_deck == "A" {
                            deck_a.receiver.is_none() && deck_a.has_samples()
                        } else {
                            deck_b.receiver.is_none() && deck_b.has_samples()
                        };

                        if target_ready || download_done {
                            // Target ready → immediate crossfade
                            crossfading = true;
                            // A crossfade always means playback, even if output was
                            // halted because the previous deck turned out unplayable
                            is_playing = true;
                            target_deck = to_deck;
                            crossfade_total =
                                (duration_ms as usize * SAMPLE_RATE / 1000) * CHANNELS;
                            crossfade_left = crossfade_total;
                            pending_transition = None;
                            send_log(
                                "crossfade_started",
                                &format!("from={}, to={}", active_deck, target_deck),
                            );
                        } else {
                            // Target not ready → pending crossfade (continues playing current deck)
                            pending_transition =
                                Some((to_deck, std::time::Instant::now(), true, duration_ms));
                            send_log(
                                "info",
                                &format!("⏳ Crossfade pending: target deck not ready"),
                            );
                        }
                    }
                }
                InputCommand::SetProactiveCrossfade { enabled } => {
                    proactive_crossfade_enabled = enabled;
                    send_log(
                        "info",
                        &format!(
                            "Proactive crossfade: {}",
                            if enabled { "enabled" } else { "disabled" }
                        ),
                    );
                }
                InputCommand::SetLoop { enabled } => {
                    loop_mode = enabled;
                    send_log(
                        "info",
                        &format!(
                            "Loop mode: {}",
                            if enabled { "enabled" } else { "disabled" }
                        ),
                    );
                }
                InputCommand::SkipTo { target_deck } => {
                    auto_gapless_stall = None;
                    if target_deck != active_deck && target_deck != "C" {
                        send_log("info", &format!("Skip: {} -> {}", active_deck, target_deck));

                        // Updates target deck buffer
                        let target_is_ready = if target_deck == "A" {
                            deck_a.poll_receiver();
                            deck_a.is_ready_for_crossfade()
                        } else if target_deck == "B" {
                            deck_b.poll_receiver();
                            deck_b.is_ready_for_crossfade()
                        } else {
                            false
                        };

                        // Download completed (even if few samples)?
                        let download_done = if target_deck == "A" {
                            deck_a.receiver.is_none() && deck_a.has_samples()
                        } else {
                            deck_b.receiver.is_none() && deck_b.has_samples()
                        };

                        if target_is_ready || download_done {
                            // ✅ IMMEDIATE SWITCH: target deck ready
                            send_log("buffer_ready", target_deck.as_str());

                            if active_deck == "A" {
                                deck_a = Deck::new("A");
                            } else if active_deck == "B" {
                                deck_b = Deck::new("B");
                            }

                            active_deck = target_deck.clone();
                            crossfading = false;
                            proactive_crossfade_triggered = false;
                            crossfade_left = 0;
                            crossfade_total = 0;
                            is_playing = true;
                            pending_transition = None;

                            if target_deck == "A" {
                                deck_a.samples_played = 0;
                            } else if target_deck == "B" {
                                deck_b.samples_played = 0;
                            }

                            send_log("info", &format!("⚡ Immediate skip → deck {}", target_deck));
                            send_log(
                                "deck_changed",
                                &format!("deck={}, triggered_by=skip_command", target_deck),
                            );
                        } else {
                            // ⏳ PENDING SKIP: target deck not ready, continue playing current deck
                            pending_transition =
                                Some((target_deck.clone(), std::time::Instant::now(), false, 0));
                            send_log("info", &format!("⏳ Skip pending: deck {} not ready, continuing current playback", target_deck));
                        }
                    }
                }
                InputCommand::ApproveProposal { new_deck } => {
                    // 🤝 NEW: Approves the deck change proposal and does crossfade
                    if new_deck != active_deck && new_deck != "C" && proactive_crossfade_triggered {
                        send_log(
                            "info",
                            &format!("Approved deck proposal: {} -> {}", active_deck, new_deck),
                        );

                        // Start the crossfade towards the proposed deck
                        crossfading = true;
                        target_deck = new_deck.clone();
                        crossfade_total = SAMPLE_RATE * CHANNELS * 6; // 6 seconds of crossfade
                        crossfade_left = crossfade_total;
                        proactive_crossfade_triggered = false;

                        send_log("info", "Starting crossfade from approved proposal");
                    }
                }
                InputCommand::PauseAll => {
                    is_playing = false;
                    send_log("info", "Paused all playback");
                }
                InputCommand::ResumeAll => {
                    is_playing = true;
                    send_log("info", "Resumed all playback");
                }
                InputCommand::RestartDeck { deck } => {
                    send_log(
                        "info",
                        &format!(
                            "Restarting deck {} for replay ({} samples available)",
                            deck,
                            if deck == "A" {
                                deck_a.full_samples.len()
                            } else {
                                deck_b.full_samples.len()
                            }
                        ),
                    );
                    if deck == "A" {
                        deck_a.restart();
                    } else if deck == "B" {
                        deck_b.restart();
                    }
                    send_log("deck_restarted", &format!("deck={}", deck));
                }
                InputCommand::Stop => {
                    send_log("info", "Graceful shutdown");
                    break 'main;
                }
            }
        }

        // Updates buffers of ALL decks, even inactive ones
        deck_a.poll_receiver();
        deck_b.poll_receiver();

        // ── Unplayable deck detection ────────────────────────────
        // A download that ended without producing a single sample can never play.
        // Report it once so Node.js can warn the users and move on; `blocking`
        // tells Node.js whether playback is actually stuck waiting for this deck.
        for name in ["A", "B"] {
            let just_failed = if name == "A" {
                deck_a.download_failed && !deck_a.fail_sent
            } else {
                deck_b.download_failed && !deck_b.fail_sent
            };
            if !just_failed {
                continue;
            }
            if name == "A" {
                deck_a.fail_sent = true;
            } else {
                deck_b.fail_sent = true;
            }

            let is_stall_target = auto_gapless_stall
                .as_ref()
                .map_or(false, |(t, _)| t.as_str() == name);
            let is_pending_target = pending_transition
                .as_ref()
                .map_or(false, |(t, _, _, _)| t.as_str() == name);
            let blocking = active_deck == name || is_stall_target || is_pending_target;

            send_log(
                "deck_failed",
                &format!("deck={}, blocking={}", name, blocking),
            );

            if blocking {
                if is_stall_target {
                    auto_gapless_stall = None;
                }
                if is_pending_target {
                    pending_transition = None;
                }
                // Stop emitting audio only when nothing is left to play: the
                // failed deck is the active one, or the active one already ran
                // out and was waiting for it. A deck that was merely the target
                // of a skip must not silence the track still playing.
                if !crossfading && (active_deck == name || is_stall_target) {
                    is_playing = false;
                }
            }
        }

        // ── Auto-gapless stall check ─────────────────────────────
        // If we're stalled waiting for the other deck to receive first data,
        // check if it now has audio. If yes, do the switch.
        if let Some((ref stall_target, stall_since)) = auto_gapless_stall.clone() {
            // Poll the target deck to receive fresh data
            if stall_target == "A" {
                deck_a.poll_receiver();
            } else {
                deck_b.poll_receiver();
            }

            let target_has_audio = if stall_target == "A" {
                deck_a.has_samples()
            } else {
                deck_b.has_samples()
            };
            let timed_out = stall_since.elapsed()
                >= std::time::Duration::from_secs(AUTO_GAPLESS_STALL_TIMEOUT_SECS);

            if target_has_audio {
                // Data arrived! Auto-switch gapless
                send_log(
                    "info",
                    &format!(
                        "⚡ Auto-gapless stall resolved after {}ms → deck {}",
                        stall_since.elapsed().as_millis(),
                        stall_target
                    ),
                );

                // Clean up old deck
                if active_deck == "A" {
                    deck_a = Deck::new("A");
                } else {
                    deck_b = Deck::new("B");
                }

                let new_deck = stall_target.clone();
                active_deck = new_deck.clone();
                if new_deck == "A" {
                    deck_a.samples_played = 0;
                } else {
                    deck_b.samples_played = 0;
                }

                send_log("auto_end_switch", &new_deck);
                send_log(
                    "deck_changed",
                    &format!("deck={}, triggered_by=auto_gapless_stall", new_deck),
                );
                auto_gapless_stall = None;
            } else if timed_out {
                // Timeout: the target deck never received any data → unplayable
                send_log(
                    "info",
                    &format!(
                        "⏰ Auto-gapless stall timeout ({}s) → deck {} unplayable",
                        AUTO_GAPLESS_STALL_TIMEOUT_SECS, stall_target
                    ),
                );
                send_log(
                    "deck_failed",
                    &format!("deck={}, blocking=true", stall_target),
                );
                auto_gapless_stall = None;
                is_playing = false;
            }
            // If neither data nor timeout, continue stalling (output silence)
        }

        // ── Pending transition check ──────────────────────────────
        // If there's a pending transition (skip or crossfade), check if the deck
        // target is now ready. If yes, execute the transition. If timeout, execute anyway.
        {
            let mut execute_target: Option<(String, bool, u64)> = None; // (deck, is_crossfade, duration_ms)
            if let Some((ref ptarget, since, is_cf, cf_dur)) = pending_transition {
                let ready = if ptarget == "A" {
                    deck_a.is_ready_for_crossfade()
                } else {
                    deck_b.is_ready_for_crossfade()
                };
                let rx_done = if ptarget == "A" {
                    deck_a.receiver.is_none() && deck_a.has_samples()
                } else {
                    deck_b.receiver.is_none() && deck_b.has_samples()
                };
                let timed_out =
                    since.elapsed() >= std::time::Duration::from_secs(PENDING_TIMEOUT_SECS);

                if ready || rx_done || timed_out {
                    send_log(
                        "info",
                        &format!(
                            "✅ Pending {} executed after {}ms (ready={}, done={}, timeout={})",
                            if is_cf { "crossfade" } else { "skip" },
                            since.elapsed().as_millis(),
                            ready,
                            rx_done,
                            timed_out
                        ),
                    );
                    execute_target = Some((ptarget.clone(), is_cf, cf_dur));
                }
            }

            if let Some((ref etarget, is_cf, cf_dur_ms)) = execute_target {
                if is_cf {
                    // Crossfade: DON'T clean up the old deck — it's needed for the mix!
                    // Crossfade completion in mixing loop will clean up the source deck.
                    crossfading = true;
                    is_playing = true;
                    target_deck = etarget.clone();
                    crossfade_total = (cf_dur_ms as usize * SAMPLE_RATE / 1000) * CHANNELS;
                    crossfade_left = crossfade_total;
                    proactive_crossfade_triggered = false;
                    send_log(
                        "crossfade_started",
                        &format!("from={}, to={}", active_deck, etarget),
                    );
                } else {
                    // Instant skip: clean up old deck
                    if active_deck == "A" {
                        deck_a = Deck::new("A");
                    } else if active_deck == "B" {
                        deck_b = Deck::new("B");
                    }

                    active_deck = etarget.clone();
                    crossfading = false;
                    proactive_crossfade_triggered = false;
                    crossfade_left = 0;
                    crossfade_total = 0;
                    is_playing = true;

                    if etarget == "A" {
                        deck_a.samples_played = 0;
                    } else if etarget == "B" {
                        deck_b.samples_played = 0;
                    }

                    send_log("info", &format!("⚡ Skip completed → deck {}", etarget));
                    send_log(
                        "deck_changed",
                        &format!("deck={}, triggered_by=pending_skip", etarget),
                    );
                }

                pending_transition = None;
                send_log("buffer_ready", etarget.as_str());
            }
        }

        // Buffer monitoring (edge detection for buffer_ready)
        buffer_monitor_counter += 1;
        if buffer_monitor_counter >= 5 {
            buffer_monitor_counter = 0;

            let b_ready = deck_b.is_ready_for_crossfade();
            let a_ready = deck_a.is_ready_for_crossfade();

            if (active_deck == "A" || active_deck == "C") && b_ready && !deck_b.buffer_prev_ready {
                send_log("buffer_ready", "B");
            }
            deck_b.buffer_prev_ready = b_ready;

            if (active_deck == "B" || active_deck == "C") && a_ready && !deck_a.buffer_prev_ready {
                send_log("buffer_ready", "A");
            }
            deck_a.buffer_prev_ready = a_ready;
        }

        // CRITICAL CHANGE: Don't generate output if we're not playing
        if !is_playing {
            // Sleep to avoid wasting CPU
            std::thread::sleep(std::time::Duration::from_millis(20));
            continue;
        }

        // If we're stalled for auto-gapless, output silence without consuming samples
        if auto_gapless_stall.is_some() {
            out_bytes.clear();
            out_bytes.resize(CHUNK_SIZE * 2, 0u8);
            if let Err(e) = write_pcm_chunk(&mut handle, &out_bytes) {
                send_log("error", &format!("Fatal stdout write error: {}", e));
                break 'main;
            }
            continue;
        }

        // 🔥 AUTOMATIC CROSSFADE: 3 seconds before end of song
        // If the fade is active and target deck is ready, start crossfade DIRECTLY
        // If fade is disabled, do nothing (deck will end and send end event)
        if !crossfading
            && !proactive_crossfade_triggered
            && is_playing
            && proactive_crossfade_enabled
        {
            let current_buffer_len = if active_deck == "A" {
                deck_a.available_samples()
            } else {
                deck_b.available_samples()
            };
            let target_deck_obj = if active_deck == "A" { &deck_b } else { &deck_a };
            let target_deck_name = if active_deck == "A" { "B" } else { "A" };
            let target_ready = target_deck_obj.is_ready_for_crossfade();
            // 3 seconds before end = 288000 stereo samples at 48kHz
            let threshold = SAMPLE_RATE * CHANNELS * 3;

            if current_buffer_len < threshold && target_ready {
                // Send proposal to Node.js instead of direct crossfade
                // Node.js will decide whether to approve crossfade (via approaching_end handler)
                send_log(
                    "proactive_crossfade_proposal",
                    &format!(
                        "from={}, to={}, buffer={}",
                        active_deck, target_deck_name, current_buffer_len
                    ),
                );
                proactive_crossfade_triggered = true;
            }
        }

        // Mixing Loop
        let mut has_audio = false;
        mid_chunk_auto_switch = None; // Reset for this chunk
        mid_chunk_loop_restart = false;
        out_bytes.clear();

        for _ in 0..CHUNK_SIZE {
            let out = if crossfading {
                // FIRST check if target deck has audio BEFORE consuming samples
                let target_has_audio = if target_deck == "A" {
                    deck_a.has_samples()
                } else {
                    deck_b.has_samples()
                };

                if !target_has_audio {
                    // Target deck doesn't have audio yet: DON'T advance the crossfade.
                    // Play only source deck at full volume to avoid silences.
                    // Consume ONLY from source deck (not from target which is empty)
                    let source = if active_deck == "A" {
                        deck_a.get_next_sample().unwrap_or(0.0)
                    } else {
                        deck_b.get_next_sample().unwrap_or(0.0)
                    };
                    source
                } else {
                    // Both decks have audio → consume from both for crossfade
                    let s_a = deck_a.get_next_sample().unwrap_or(0.0);
                    let s_b = deck_b.get_next_sample().unwrap_or(0.0);

                    let ratio =
                        (crossfade_total as f32 - crossfade_left as f32) / crossfade_total as f32;
                    crossfade_left = crossfade_left.saturating_sub(1);

                    let final_ratio = if crossfade_left == 0 { 1.0 } else { ratio };

                    if crossfade_left == 0 {
                        crossfading = false;
                        proactive_crossfade_triggered = false;

                        // Reset only edge-detection flags.
                        if active_deck == "A" {
                            deck_a.reset_flags();
                        } else if active_deck == "B" {
                            deck_b.reset_flags();
                        }

                        if target_deck == "A" {
                            deck_a.samples_played = 0;
                        } else if target_deck == "B" {
                            deck_b.samples_played = 0;
                        }

                        active_deck = target_deck.clone();
                        send_log(
                            "info",
                            &format!("Crossfade completed, switched to {}", active_deck),
                        );
                        send_log(
                            "deck_changed",
                            &format!("deck={}, triggered_by=crossfade_completion", active_deck),
                        );
                    }

                    let source_sample = if active_deck == "A" { s_a } else { s_b };
                    let target_sample = if target_deck == "A" { s_a } else { s_b };

                    // Equal-power crossfade: keeps perceived volume constant
                    // (linear crossfade causes ~3 dB drop at midpoint)
                    source_sample * (1.0 - final_ratio).sqrt() + target_sample * final_ratio.sqrt()
                }
            } else {
                // No crossfade - direct output from active deck
                // 🔥 CRITICAL: Implement mid-chunk auto-gapless to eliminate silences
                // If active deck is exhausted (samples.len() == 0 and has_ended),
                // try to switch to other deck or restart loop MID-CHUNK
                let sample = if active_deck == "A" {
                    deck_a.get_next_sample()
                } else {
                    deck_b.get_next_sample()
                };

                match sample {
                    Some(s) => s,
                    None => {
                        // Active deck is exhausted
                        let should_try_switch = !crossfading
                            && pending_transition.is_none()
                            && auto_gapless_stall.is_none()
                            && is_playing;

                        // `has_played` guards against ending a deck that never produced
                        // audio: that case is an unplayable track, reported as deck_failed.
                        let (is_exhausted, has_played) = if active_deck == "A" {
                            (
                                deck_a.has_ended && deck_a.receiver.is_none(),
                                deck_a.samples_played > 0,
                            )
                        } else {
                            (
                                deck_b.has_ended && deck_b.receiver.is_none(),
                                deck_b.samples_played > 0,
                            )
                        };

                        if should_try_switch
                            && is_exhausted
                            && has_played
                            && mid_chunk_auto_switch.is_none()
                        {
                            // Active deck played its audio and is now exhausted
                            if loop_mode {
                                // ── MID-CHUNK LOOP RESTART ──
                                // Restart the same deck from full_samples
                                if active_deck == "A" {
                                    deck_a.restart();
                                } else {
                                    deck_b.restart();
                                }
                                mid_chunk_loop_restart = true;

                                // Take the first sample from the restarted deck
                                if active_deck == "A" {
                                    deck_a.get_next_sample().unwrap_or(0.0)
                                } else {
                                    deck_b.get_next_sample().unwrap_or(0.0)
                                }
                            } else {
                                // ── MID-CHUNK AUTO-SWITCH ──
                                // Try switching to the other deck holding preloaded data
                                let other = if active_deck == "A" { "B" } else { "A" };
                                let other_has_audio = if other == "A" {
                                    deck_a.has_samples()
                                } else {
                                    deck_b.has_samples()
                                };

                                if other_has_audio {
                                    // Other deck has audio → switch MID-CHUNK
                                    // Clean up old deck
                                    if active_deck == "A" {
                                        deck_a = Deck::new("A");
                                    } else {
                                        deck_b = Deck::new("B");
                                    }

                                    // Update active deck
                                    active_deck = other.to_string();
                                    if other == "A" {
                                        deck_a.samples_played = 0;
                                    } else {
                                        deck_b.samples_played = 0;
                                    }

                                    mid_chunk_auto_switch = Some(other.to_string());

                                    // Get first sample from new deck
                                    if active_deck == "A" {
                                        deck_a.get_next_sample().unwrap_or(0.0)
                                    } else {
                                        deck_b.get_next_sample().unwrap_or(0.0)
                                    }
                                } else {
                                    // No audio available
                                    0.0
                                }
                            }
                        } else {
                            // Can't switch - output silence
                            0.0
                        }
                    }
                }
            };

            // Track if there's actually audio
            if out.abs() > 0.0001 {
                has_audio = true;
            }

            // Clipping and PCM i16 Output
            let pcm = (out.max(-1.0).min(1.0) * 32767.0) as i16;
            out_bytes.extend_from_slice(&pcm.to_le_bytes());
        }
        if let Err(e) = write_pcm_chunk(&mut handle, &out_bytes) {
            send_log("error", &format!("Fatal stdout write error: {}", e));
            break 'main;
        }

        // playback_confirmed event: the active deck really pushed audio out.
        // Node.js counts a track as listened only on this event, so tracks that
        // never manage to stream are never credited to the statistics.
        const PLAYBACK_CONFIRM_THRESHOLD: usize = SAMPLE_RATE * CHANNELS; // 1 second
        if is_playing && !crossfading {
            let confirmed = if active_deck == "A" {
                !deck_a.play_confirmed_sent && deck_a.samples_played >= PLAYBACK_CONFIRM_THRESHOLD
            } else if active_deck == "B" {
                !deck_b.play_confirmed_sent && deck_b.samples_played >= PLAYBACK_CONFIRM_THRESHOLD
            } else {
                false
            };
            if confirmed {
                if active_deck == "A" {
                    deck_a.play_confirmed_sent = true;
                } else {
                    deck_b.play_confirmed_sent = true;
                }
                send_log("playback_confirmed", &active_deck);
            }
        }

        // approaching_end event: 3 seconds before end
        // Sent when decoder has finished (has_ended=true) and <3 sec of samples remain
        const APPROACHING_END_THRESHOLD: usize = SAMPLE_RATE * CHANNELS * 3; // 3 seconds

        if is_playing && !crossfading {
            // Deck A
            if active_deck == "A" && deck_a.has_ended && deck_a.receiver.is_none() {
                if !deck_a.approaching_end_sent
                    && deck_a.available_samples() < APPROACHING_END_THRESHOLD
                {
                    send_log("approaching_end", "A");
                    deck_a.approaching_end_sent = true;
                }
            }
            // Deck B
            if active_deck == "B" && deck_b.has_ended && deck_b.receiver.is_none() {
                if !deck_b.approaching_end_sent
                    && deck_b.available_samples() < APPROACHING_END_THRESHOLD
                {
                    send_log("approaching_end", "B");
                    deck_b.approaching_end_sent = true;
                }
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // MID-CHUNK EVENTS: If an auto-gapless switch happened MID-CHUNK,
        // send appropriate events and skip post-chunk auto-gapless check
        // ═══════════════════════════════════════════════════════════════
        if mid_chunk_auto_switch.is_some() || mid_chunk_loop_restart {
            if mid_chunk_loop_restart {
                // Loop restart mid-chunk
                send_log("auto_loop_restart", &active_deck);
                send_log(
                    "info",
                    &format!(
                        "🔁 Mid-chunk auto-loop: deck {} restarted from cache",
                        active_deck
                    ),
                );
            } else if let Some(ref new_deck) = mid_chunk_auto_switch {
                // Auto-switch mid-chunk
                send_log("auto_end_switch", new_deck);
                send_log(
                    "deck_changed",
                    &format!("deck={}, triggered_by=mid_chunk_auto_gapless", new_deck),
                );
                send_log(
                    "info",
                    &format!(
                        "⚡ Mid-chunk auto-gapless: instant switch → deck {}",
                        new_deck
                    ),
                );
            }
            // Reset for next chunk (assignments deliberately dead for clarity)
            let _ = std::mem::take(&mut mid_chunk_auto_switch);
            let _ = std::mem::take(&mut mid_chunk_loop_restart);
            // ⚠️ SKIP post-chunk auto-gapless - the transition was already handled mid-chunk
        } else {
            // ═══════════════════════════════════════════════════════════════
            // AUTO-GAPLESS POST-CHUNK: Handle song end if it hasn't been
            // Three cases:
            //  1. Loop ON  → restart current deck from full_samples (zero gap)
            //  2. Other deck ready → instant switch (zero gap)
            //  3. Neither → send 'end' to Node.js (fallback)
            // ═══════════════════════════════════════════════════════════════

            if !has_audio
                && !crossfading
                && is_playing
                && pending_transition.is_none()
                && auto_gapless_stall.is_none()
            {
                let should_handle_end = if active_deck == "A" {
                    deck_a.has_ended
                        && deck_a.receiver.is_none()
                        && deck_a.samples_played > 0
                        && !deck_a.end_sent
                        && !deck_a.has_samples()
                } else {
                    deck_b.has_ended
                        && deck_b.receiver.is_none()
                        && deck_b.samples_played > 0
                        && !deck_b.end_sent
                        && !deck_b.has_samples()
                };

                if should_handle_end {
                    // Mark as handled to avoid re-trigger
                    if active_deck == "A" {
                        deck_a.end_sent = true;
                    } else {
                        deck_b.end_sent = true;
                    }

                    if loop_mode {
                        // ── CASE 1: LOOP → restart current deck from cache ──
                        if active_deck == "A" {
                            deck_a.restart();
                        } else {
                            deck_b.restart();
                        }
                        send_log("auto_loop_restart", &active_deck);
                        send_log(
                            "info",
                            &format!("🔁 Auto-loop: deck {} restarted from cache", active_deck),
                        );
                    } else {
                        // Check if other deck has audio ready
                        let other = if active_deck == "A" { "B" } else { "A" };
                        let other_samples = if other == "A" {
                            deck_a.available_samples()
                        } else {
                            deck_b.available_samples()
                        };
                        let other_has_receiver = if other == "A" {
                            deck_a.receiver.is_some()
                        } else {
                            deck_b.receiver.is_some()
                        };
                        let other_has_ended = if other == "A" {
                            deck_a.has_ended
                        } else {
                            deck_b.has_ended
                        };
                        let other_full = if other == "A" {
                            deck_a.full_samples.len()
                        } else {
                            deck_b.full_samples.len()
                        };

                        send_log("info", &format!("🔍 Auto-gapless check: other deck {} → samples={}, receiver={}, has_ended={}, full_samples={}",
                        other, other_samples, other_has_receiver, other_has_ended, other_full));

                        let other_has_audio = other_samples > 0;

                        if other_has_audio {
                            // ── CASE 2: AUTO-SWITCH → instant gapless transition ──
                            // Clean up old deck (data is consumed)
                            if active_deck == "A" {
                                deck_a = Deck::new("A");
                            } else {
                                deck_b = Deck::new("B");
                            }

                            // Switch to new deck
                            active_deck = other.to_string();
                            if other == "A" {
                                deck_a.samples_played = 0;
                            } else {
                                deck_b.samples_played = 0;
                            }

                            send_log("auto_end_switch", other);
                            send_log(
                                "deck_changed",
                                &format!("deck={}, triggered_by=auto_gapless", other),
                            );
                            send_log(
                                "info",
                                &format!("⚡ Auto-gapless: instant switch → deck {}", other),
                            );
                        } else {
                            // Other deck has no audio. Check if it has a download in progress.
                            let other_has_receiver = if other == "A" {
                                deck_a.receiver.is_some()
                            } else {
                                deck_b.receiver.is_some()
                            };
                            // Check if it was loaded (has full_samples or a receiver)
                            let other_was_loaded = other_has_receiver
                                || (if other == "A" {
                                    deck_a.full_samples.len() > 0
                                } else {
                                    deck_b.full_samples.len() > 0
                                });

                            if other_has_receiver {
                                // Check if download is stuck (>30s without data)
                                let load_age = if other == "A" {
                                    deck_a.load_started_at
                                } else {
                                    deck_b.load_started_at
                                };
                                let download_stuck = match load_age {
                                    Some(t) => t.elapsed() >= std::time::Duration::from_secs(30),
                                    None => false, // load_started_at is None only if data already arrived
                                };

                                if download_stuck {
                                    // ── CASE 3a-stuck: Download stuck, don't stall ──
                                    send_log("error", &format!("⏰ Auto-gapless: deck {} downloading for >30s with no data → track unplayable", other));
                                    send_log(
                                        "deck_failed",
                                        &format!("deck={}, blocking=true", other),
                                    );
                                    // Already reported: don't report it again when the
                                    // stuck download finally gives up with no samples
                                    if other == "A" {
                                        deck_a.fail_sent = true;
                                    } else {
                                        deck_b.fail_sent = true;
                                    }
                                    is_playing = false;
                                } else {
                                    // ── CASE 3a: STALL → download in progress, wait for data ──
                                    send_log("info", &format!("⏸️  Auto-gapless stall: deck {} downloading ({}ms), waiting for first data...",
                                    other, load_age.map(|t| t.elapsed().as_millis()).unwrap_or(0)));
                                    auto_gapless_stall =
                                        Some((other.to_string(), std::time::Instant::now()));
                                }
                            } else if other_was_loaded {
                                // ── CASE 3b: Deck loaded but empty (has full_samples but samples exhausted?) ──
                                // This shouldn't happen, but handle it as fallback
                                send_log("end", &active_deck);
                                send_log("debug", &format!("Deck {} ended (other deck {} loaded but empty, full_samples={})",
                                active_deck, other,
                                if other == "A" { deck_a.full_samples.len() } else { deck_b.full_samples.len() }));
                                is_playing = false;
                            } else {
                                // ── CASE 3c: FALLBACK → no deck loaded, end of queue ──
                                send_log("end", &active_deck);
                                send_log(
                                    "debug",
                                    &format!("Deck {} ended (no next song preloaded)", active_deck),
                                );
                                is_playing = false;
                            }
                        }
                    }
                }
            }
        } // End else block (post-chunk auto-gapless skip)

        // Status log every 30 seconds
        if last_status_log.elapsed().as_secs() >= 30 {
            send_log(
                "debug",
                &format!(
                    "Status - Active: {}, A: {}s played, B: {}s played, pending: {}",
                    active_deck,
                    deck_a.samples_played / (SAMPLE_RATE * CHANNELS),
                    deck_b.samples_played / (SAMPLE_RATE * CHANNELS),
                    pending_transition.is_some()
                ),
            );
            last_status_log = std::time::Instant::now();
        }
    }
}
