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
        autoplay: bool,
    },
    Crossfade {
        duration_ms: u64,
        to_deck: String,
    },
    Play {
        deck: String,
    },
    StopDeck {
        deck: String,
    },
    SetProactiveCrossfade {
        enabled: bool,
    }, // 🔥 Controls proactive crossfade
    SetLoop {
        enabled: bool,
    }, // 🔁 Loop mode: when the deck finishes, restart from full_samples
    SkipTo {
        target_deck: String,
    }, // 🎵 NEW: Direct skip to Rust (switches to target_deck)
    ApproveProposal {
        new_deck: String,
    }, // 🤝 NEW: Approves a deck change proposal (and does crossfade)
    RestartDeck {
        deck: String,
    }, // 🔄 Replay: restart deck from beginning without re-downloading
    PauseAll,
    ResumeAll,
    Stop,
}

#[derive(Serialize)]
struct LogMessage {
    event: String,
    data: String,
}

pub fn send_log(event: &str, data: &str) {
    let msg = LogMessage {
        event: event.to_string(),
        data: data.to_string(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        eprintln!("{}", json);
    }
}
