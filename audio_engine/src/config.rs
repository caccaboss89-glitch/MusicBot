//! Environment-driven configuration and audio format constants.

use std::env;

pub const SAMPLE_RATE: usize = 48000;
pub const CHANNELS: usize = 2;
pub const CHUNK_SIZE: usize = 960; // 10ms stereo (480 frames × 2 channels)

// ─── PATH CONFIGURATION ─────────────────────────────
pub fn get_base_path() -> String {
    env::var("DISCORD_BOT_PATH").unwrap_or_else(|_| {
        if cfg!(windows) {
            "F:\\Programmi\\Bots\\DiscordMusicBot".to_string()
        } else {
            "/home/ubuntu/DiscordBots/DiscordMusicBot".to_string()
        }
    })
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

pub fn default_ytdlp_proxy_url() -> String {
    "socks5h://127.0.0.1:5040".to_string()
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
