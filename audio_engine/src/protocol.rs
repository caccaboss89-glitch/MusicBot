//! Wire protocol with Node.js: commands read from stdin, events written to stderr.

use serde::{Deserialize, Serialize};

// Default for backward compatibility: LOAD without specific autoplay goes into autoplay
fn default_autoplay() -> bool {
    true
}

#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum InputCommand {
    Load {
        url: String,
        deck: String,
        #[serde(default = "default_autoplay")]
        autoplay: bool
    },
    /// Fades from the active deck to `to_deck` over `duration_ms`.
    Crossfade {
        duration_ms: u64,
        to_deck: String
    },
    /// Starts `deck` from the top and makes it the one being heard.
    Play {
        deck: String
    },
    StopDeck {
        deck: String
    },
    /// Loop mode: when the deck finishes, restart it from full_samples
    SetLoop {
        enabled: bool
    },
    /// Instant switch to `target_deck`, with no fade.
    SkipTo {
        target_deck: String
    },
    /// Replay: restart a deck from the beginning without re-downloading
    RestartDeck {
        deck: String
    },
    /// Halts the output without discarding any deck state.
    PauseAll,
    /// Resumes the output exactly where `PauseAll` left it.
    ResumeAll,
    Stop
}

#[derive(Serialize)]
struct LogMessage {
    event: String,
    data: String
}

pub fn send_log(event: &str, data: &str) {
    let msg = LogMessage {
        event: event.to_string(),
        data: data.to_string()
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        eprintln!("{}", json);
    }
}
