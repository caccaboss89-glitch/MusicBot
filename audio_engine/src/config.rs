//! Environment-driven configuration and audio format constants.

use std::env;

pub const SAMPLE_RATE: usize = 48000;
pub const CHANNELS: usize = 2;
pub const CHUNK_SIZE: usize = 960; // 10ms stereo (480 frames × 2 channels)

/// Longest track the bot accepts, mirrored from the Node.js side
/// (MAX_SONG_DURATION_SECONDS in config/constants.js). Everything the engine
/// caps is expressed in terms of this, so the two limits cannot drift apart.
pub const MAX_TRACK_MINUTES: usize = 12;

/// Samples of one full-length track: 12 min × 48 kHz × 2 channels ≈ 69.1 M
/// samples, 276 MB as f32. Hard ceiling for a deck's replay cache.
pub const MAX_TRACK_SAMPLES: usize = SAMPLE_RATE * CHANNELS * MAX_TRACK_MINUTES * 60;

/// Ceiling for audio downloaded but not played yet. One minute of slack over
/// MAX_TRACK_SAMPLES so a track sitting exactly on the limit is never clipped.
pub const MAX_BUFFERED_SAMPLES: usize = MAX_TRACK_SAMPLES + SAMPLE_RATE * CHANNELS * 60;

// ─── PATH CONFIGURATION ─────────────────────────────
/// Project root. Node.js always passes DISCORD_BOT_PATH; the fallback only
/// matters when the binary is started by hand, and is derived from the
/// executable itself (<root>/audio_engine/target/<profile>/<bin>) so that no
/// machine specific path is baked into the build.
pub fn get_base_path() -> String {
    if let Ok(path) = env::var("DISCORD_BOT_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(root) = exe.ancestors().nth(4) {
            return root.to_string_lossy().into_owned();
        }
    }
    ".".to_string()
}

pub fn get_download_watchdog_secs() -> u64 {
    if let Ok(raw) = env::var("YTDLP_WATCHDOG_SECS") {
        if let Ok(parsed) = raw.trim().parse::<u64>() {
            return parsed.clamp(10, 300);
        }
    }
    60
}

/// Reads an environment variable; empty values or "none"/"off"/"false" → None.
pub fn env_opt(name: &str) -> Option<String> {
    env::var(name).ok().and_then(|v| {
        let t = v.trim();
        if t.is_empty() {
            return None;
        }
        match t.to_lowercase().as_str() {
            "none" | "off" | "false" | "0" | "no" => None,
            _ => Some(t.to_string()),
        }
    })
}

pub fn default_ytdlp_cookie_browser() -> Option<String> {
    #[cfg(windows)]
    {
        Some("chromium".to_string())
    }
    #[cfg(not(windows))]
    {
        None
    }
}
