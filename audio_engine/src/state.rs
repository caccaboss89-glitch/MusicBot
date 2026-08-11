//! The mixer's mutable state, plus the deck lookup every stage is built on.
//!
//! The engine only ever has two decks, named "A" and "B". Keeping the names as
//! `&'static str` means a deck reference is a `Copy` value: the loop can read
//! `state.active_deck` and immediately borrow the matching deck mutably, which
//! is what lets the transition and event stages live in their own modules.

use std::time::Instant;

use crate::config::{CHANNELS, SAMPLE_RATE};
use crate::deck::Deck;

/// Resolves a deck name coming from Node.js. Anything the engine does not know
/// about is rejected here, so no stage further down has to guard against it.
pub fn deck_name(raw: &str) -> Option<&'static str> {
    match raw {
        "A" => Some("A"),
        "B" => Some("B"),
        _ => None
    }
}

/// A crossfade in flight from the active deck to `target`.
pub struct Crossfade {
    pub target: &'static str,
    /// Total samples the fade spans, used to derive the mix ratio.
    pub total: usize,
    /// Samples still to go; the fade completes when this reaches zero.
    pub left: usize,
    /// Set while the target deck has produced no audio yet. The fade cannot
    /// advance in that state, so this timestamps how long it has been waiting.
    pub stalled_since: Option<Instant>
}

impl Crossfade {
    /// Builds a fade spanning `duration_ms` of audio. The span is never zero,
    /// so the mix ratio can always be divided by it.
    pub fn new(target: &'static str, duration_ms: u64) -> Self {
        let total = ((duration_ms as usize * SAMPLE_RATE / 1000) * CHANNELS).max(1);
        Self {
            target,
            total,
            left: total,
            stalled_since: None
        }
    }
}

/// A skip or crossfade that was requested while its target deck was still
/// downloading: playback stays on the current deck until the target is usable.
pub struct PendingTransition {
    pub target: &'static str,
    pub since: Instant,
    pub is_crossfade: bool,
    pub duration_ms: u64
}

/// The active deck ran out while the other one was still downloading: the
/// output is silence until the first samples arrive.
pub struct Stall {
    pub target: &'static str,
    pub since: Instant
}

pub struct MixerState {
    pub deck_a: Deck,
    pub deck_b: Deck,
    pub active_deck: &'static str,
    /// False while paused or after an unplayable track stopped the output.
    pub is_playing: bool,
    /// When set, a finished deck restarts from its cache instead of advancing.
    pub loop_mode: bool,
    pub crossfade: Option<Crossfade>,
    pub pending: Option<PendingTransition>,
    pub stall: Option<Stall>
}

impl MixerState {
    pub fn new() -> Self {
        Self {
            deck_a: Deck::new("A"),
            deck_b: Deck::new("B"),
            active_deck: "A",
            is_playing: false,
            loop_mode: false,
            crossfade: None,
            pending: None,
            stall: None
        }
    }

    pub fn deck(&self, name: &str) -> &Deck {
        if name == "A" {
            &self.deck_a
        } else {
            &self.deck_b
        }
    }

    pub fn deck_mut(&mut self, name: &str) -> &mut Deck {
        if name == "A" {
            &mut self.deck_a
        } else {
            &mut self.deck_b
        }
    }

    pub fn active(&self) -> &Deck {
        self.deck(self.active_deck)
    }

    pub fn active_mut(&mut self) -> &mut Deck {
        self.deck_mut(self.active_deck)
    }

    /// The deck that is not currently playing: the one preload writes to.
    pub fn idle_deck(&self) -> &'static str {
        if self.active_deck == "A" {
            "B"
        } else {
            "A"
        }
    }

    /// Discards a deck entirely, which also cancels its download thread through
    /// `Deck::drop`. Used whenever a deck's audio has been consumed for good.
    pub fn reset_deck(&mut self, name: &'static str) {
        *self.deck_mut(name) = Deck::new(name);
    }

    /// Makes `name` the deck being heard and restarts its played-sample count,
    /// which gates both the playback confirmation and the end-of-track check.
    pub fn switch_to(&mut self, name: &'static str) {
        self.active_deck = name;
        self.deck_mut(name).samples_played = 0;
    }

    /// True when the deck is holding enough audio to be faded into.
    pub fn is_ready(&self, name: &str) -> bool {
        self.deck(name).is_ready_for_crossfade()
    }

    /// True when the download is over and left some audio behind: the deck can
    /// be switched to even if it never buffered a full half second.
    pub fn download_complete(&self, name: &str) -> bool {
        let deck = self.deck(name);
        deck.receiver.is_none() && deck.has_samples()
    }

    /// True when a deck is the target of work that playback is waiting on, so
    /// its failure leaves the output stuck rather than merely wasting a preload.
    pub fn is_awaited(&self, name: &str) -> bool {
        self.stall.as_ref().is_some_and(|s| s.target == name)
            || self.pending.as_ref().is_some_and(|p| p.target == name)
            || self.crossfade.as_ref().is_some_and(|c| c.target == name)
    }
}
