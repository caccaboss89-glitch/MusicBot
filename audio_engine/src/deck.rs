//! A single audio deck: owns the decoded sample buffer of one track and the
//! background thread that fills it.

use crossbeam_channel::{bounded, Receiver, TryRecvError};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use crate::config::{CHANNELS, SAMPLE_RATE};
use crate::download::download_and_decode_advanced;
use crate::protocol::send_log;

pub struct Deck {
    name: String,
    samples: VecDeque<f32>,
    pub full_samples: Vec<f32>, // All samples received (for replay without re-download)
    is_loading: bool,
    pub has_ended: bool,
    pub receiver: Option<Receiver<Vec<f32>>>,
    buffer_level: usize,
    total_samples_read: usize,
    real_samples_received: usize,
    pub samples_played: usize, // Samples actually PLAYED (not just received)
    cancel_token: Option<Arc<AtomicBool>>, // Signals the download thread to stop
    pub load_started_at: Option<std::time::Instant>, // When load() was called
    // Flags for edge detection (managed by mixer loop)
    pub buffer_prev_ready: bool,
    pub end_sent: bool,
    pub approaching_end_sent: bool,
    // Download finished without ever producing a sample: the track is unplayable
    pub download_failed: bool,
    pub fail_sent: bool,
    // Real audio actually reached the output for this playback (stats gating)
    pub play_confirmed_sent: bool,
    // Replay: offset to read from full_samples without clone
    replay_offset: Option<usize>,
}

impl Deck {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            samples: VecDeque::new(),
            full_samples: Vec::new(),
            is_loading: false,
            has_ended: false,
            receiver: None,
            buffer_level: 0,
            total_samples_read: 0,
            real_samples_received: 0,
            samples_played: 0,
            cancel_token: None,
            load_started_at: None,
            buffer_prev_ready: false,
            end_sent: false,
            approaching_end_sent: false,
            download_failed: false,
            fail_sent: false,
            play_confirmed_sent: false,
            replay_offset: None,
        }
    }

    pub fn load(&mut self, url: String) {
        // Cancels the previous download (if in progress)
        // This signals the thread to kill yt-dlp/ffmpeg and exit
        if let Some(ref token) = self.cancel_token {
            token.store(true, Ordering::Relaxed);
        }

        self.samples.clear();
        self.full_samples.clear();
        self.buffer_level = 0;
        self.total_samples_read = 0;
        self.real_samples_received = 0;
        self.samples_played = 0;
        self.has_ended = false;
        self.is_loading = true;
        self.load_started_at = Some(std::time::Instant::now());
        self.replay_offset = None;
        self.reset_flags();
        let (tx, rx) = bounded::<Vec<f32>>(100);
        self.receiver = Some(rx);

        let cancel = Arc::new(AtomicBool::new(false));
        self.cancel_token = Some(cancel.clone());
        let deck_name = self.name.clone();

        // Starts download thread
        thread::spawn(move || {
            if let Err(e) = download_and_decode_advanced(&url, tx, cancel, &deck_name) {
                send_log(
                    "error",
                    &format!("[Deck {}] Download error: {}", deck_name, e),
                );
            }
        });
    }

    pub fn get_next_sample(&mut self) -> Option<f32> {
        // Replay mode: reads directly from full_samples without clone
        if let Some(offset) = self.replay_offset {
            if offset < self.full_samples.len() {
                let sample = self.full_samples[offset];
                self.replay_offset = Some(offset + 1);
                self.total_samples_read += 1;
                self.samples_played += 1;
                return Some(sample);
            } else {
                self.replay_offset = None;
                if !self.has_ended {
                    self.has_ended = true;
                }
                return None;
            }
        }

        // Streaming mode: reads from VecDeque
        self.poll_receiver();

        if let Some(sample) = self.samples.pop_front() {
            self.buffer_level = self.buffer_level.saturating_sub(1);
            self.total_samples_read += 1;
            self.samples_played += 1;
            Some(sample)
        } else {
            if !self.has_ended {
                if self.receiver.is_none() && self.samples_played > 0 {
                    self.has_ended = true;
                    return None;
                }
                self.total_samples_read += 1;
                Some(0.0)
            } else {
                None
            }
        }
    }

    // NEW: Updates the buffer without consuming samples (for inactive decks)
    pub fn poll_receiver(&mut self) {
        if let Some(rx) = &self.receiver {
            // Read ALL available chunks, not just one
            let mut chunks_received = 0;
            let _samples_before = self.samples.len();
            loop {
                match rx.try_recv() {
                    Ok(chunk) => {
                        chunks_received += 1;
                        self.real_samples_received += chunk.len();
                        // First data arrived → clear load timestamp
                        if self.load_started_at.is_some() {
                            self.load_started_at = None;
                        }
                        self.full_samples.extend(&chunk); // Saves copy for replay
                        self.samples.extend(chunk);
                        self.buffer_level = self.samples.len(); // Updates based on real queue
                    }
                    Err(TryRecvError::Disconnected) => {
                        let samples_after = self.samples.len();
                        send_log("info", &format!("✅ [RX-DONE] Deck {} → {} chunks received, final buffer: {} samples", self.name, chunks_received, samples_after));
                        // Download over without a single sample: yt-dlp/ffmpeg failed
                        if self.real_samples_received == 0 {
                            self.download_failed = true;
                        }
                        if !self.has_ended {
                            self.has_ended = true;
                        }
                        self.receiver = None;
                        break;
                    }
                    Err(TryRecvError::Empty) => {
                        break;
                    }
                }
            }
        }
    }

    pub fn is_ready_for_crossfade(&self) -> bool {
        self.available_samples() >= SAMPLE_RATE * CHANNELS / 2
    }

    /// Available samples (streaming + replay)
    pub fn available_samples(&self) -> usize {
        self.samples.len()
            + match self.replay_offset {
                Some(offset) => self.full_samples.len().saturating_sub(offset),
                None => 0,
            }
    }

    pub fn has_samples(&self) -> bool {
        !self.samples.is_empty()
            || self
                .replay_offset
                .map_or(false, |o| o < self.full_samples.len())
    }

    /// Restarts the deck from the beginning without re-downloading.
    /// Uses replay_offset to read from full_samples without cloning.
    pub fn restart(&mut self) {
        self.samples.clear();
        self.replay_offset = Some(0);
        self.has_ended = false;
        self.samples_played = 0;
        self.total_samples_read = 0;
        self.buffer_level = self.full_samples.len();
        self.reset_flags();
    }

    /// Reset of edge detection flags (for transitions)
    pub fn reset_flags(&mut self) {
        self.buffer_prev_ready = false;
        self.end_sent = false;
        self.approaching_end_sent = false;
        self.download_failed = false;
        self.fail_sent = false;
        self.play_confirmed_sent = false;
    }
}

impl Drop for Deck {
    fn drop(&mut self) {
        // When the Deck is destroyed (e.g. deck_a = Deck::new()),
        // signals the download thread to stop and kill yt-dlp/ffmpeg
        if let Some(ref token) = self.cancel_token {
            token.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a deck holding `n` cached samples, as if a download had completed.
    fn deck_with_cache(n: usize) -> Deck {
        let mut deck = Deck::new("A");
        deck.full_samples = (0..n).map(|i| i as f32).collect();
        deck
    }

    #[test]
    fn fresh_deck_outputs_silence_without_ending() {
        let mut deck = Deck::new("A");
        // No receiver and nothing played yet: the mixer must get silence, not an
        // end-of-track, otherwise loading a deck would instantly close the queue.
        assert_eq!(deck.get_next_sample(), Some(0.0));
        assert!(!deck.has_ended);
    }

    #[test]
    fn deck_ends_once_it_has_played_and_the_download_is_over() {
        let mut deck = Deck::new("A");
        deck.samples_played = 10;
        // This is the exact condition mixer_loop tests to emit 'end'
        assert_eq!(deck.get_next_sample(), None);
        assert!(deck.has_ended);
        assert!(deck.receiver.is_none());
    }

    #[test]
    fn restart_replays_the_cache_from_the_beginning() {
        let mut deck = deck_with_cache(3);
        deck.restart();

        assert_eq!(deck.get_next_sample(), Some(0.0));
        assert_eq!(deck.get_next_sample(), Some(1.0));
        assert_eq!(deck.get_next_sample(), Some(2.0));
        // Cache exhausted: the deck ends instead of looping forever
        assert_eq!(deck.get_next_sample(), None);
        assert!(deck.has_ended);
    }

    #[test]
    fn restart_is_repeatable_and_resets_counters() {
        let mut deck = deck_with_cache(2);
        deck.restart();
        deck.get_next_sample();
        deck.get_next_sample();
        deck.get_next_sample(); // exhausts it

        // Loop mode restarts the same deck over and over
        deck.restart();
        assert!(!deck.has_ended);
        assert_eq!(deck.samples_played, 0);
        assert_eq!(deck.get_next_sample(), Some(0.0));
    }

    #[test]
    fn available_samples_tracks_replay_progress() {
        let mut deck = deck_with_cache(4);
        assert_eq!(deck.available_samples(), 0); // not replaying yet
        deck.restart();
        assert_eq!(deck.available_samples(), 4);
        deck.get_next_sample();
        assert_eq!(deck.available_samples(), 3);
        assert!(deck.has_samples());
    }

    #[test]
    fn crossfade_readiness_needs_half_a_second_of_audio() {
        let half_second = SAMPLE_RATE * CHANNELS / 2;

        let mut short = deck_with_cache(half_second - 1);
        short.restart();
        assert!(!short.is_ready_for_crossfade());

        let mut ready = deck_with_cache(half_second);
        ready.restart();
        assert!(ready.is_ready_for_crossfade());
    }

    #[test]
    fn reset_flags_clears_every_edge_detection_flag() {
        let mut deck = Deck::new("A");
        deck.end_sent = true;
        deck.approaching_end_sent = true;
        deck.download_failed = true;
        deck.fail_sent = true;
        deck.play_confirmed_sent = true;
        deck.buffer_prev_ready = true;

        deck.reset_flags();

        assert!(!deck.end_sent);
        assert!(!deck.approaching_end_sent);
        assert!(!deck.download_failed);
        assert!(!deck.fail_sent);
        assert!(!deck.play_confirmed_sent);
        assert!(!deck.buffer_prev_ready);
    }
}
