use anyhow::{anyhow, Result};
use byteorder::{ReadBytesExt, LE}; // Essential for reading audio
use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError};
#[cfg(unix)]
use libc;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

// ─── PATH CONFIGURATION ─────────────────────────────
fn get_base_path() -> String {
    env::var("DISCORD_BOT_PATH").unwrap_or_else(|_| {
        if cfg!(windows) {
            "F:\\Programmi\\Bots\\DiscordMusicBot".to_string()
        } else {
            "/home/ubuntu/DiscordBots/DiscordMusicBot".to_string()
        }
    })
}

const SAMPLE_RATE: usize = 48000;
const CHANNELS: usize = 2;
const CHUNK_SIZE: usize = 960; // 10ms stereo (480 frames × 2 channels)

// Default for backward compatibility: LOAD without specific autoplay goes into autoplay
fn default_autoplay() -> bool {
    true
}

#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "snake_case")]
enum InputCommand {
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

fn send_log(event: &str, data: &str) {
    let msg = LogMessage {
        event: event.to_string(),
        data: data.to_string(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        eprintln!("{}", json);
    }
}

fn get_download_watchdog_secs() -> u64 {
    if let Ok(raw) = env::var("YTDLP_WATCHDOG_SECS") {
        if let Ok(parsed) = raw.trim().parse::<u64>() {
            return parsed.clamp(10, 300);
        }
    }
    60
}

/// Reads an environment variable; empty values or "none"/"off"/"false" → None.
fn env_opt(name: &str) -> Option<String> {
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

fn default_ytdlp_proxy_url() -> String {
    "socks5h://127.0.0.1:5040".to_string()
}

fn default_ytdlp_cookie_browser() -> Option<String> {
    #[cfg(windows)]
    {
        Some("chromium".to_string())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

struct Deck {
    name: String,
    samples: VecDeque<f32>,
    full_samples: Vec<f32>, // All samples received (for replay without re-download)
    is_loading: bool,
    has_ended: bool,
    receiver: Option<Receiver<Vec<f32>>>,
    buffer_level: usize,
    total_samples_read: usize,
    real_samples_received: usize,
    samples_played: usize, // Samples actually PLAYED (not just received)
    cancel_token: Option<Arc<AtomicBool>>, // Signals the download thread to stop
    load_started_at: Option<std::time::Instant>, // When load() was called
    // Flags for edge detection (managed by mixer loop)
    buffer_prev_ready: bool,
    end_sent: bool,
    approaching_end_sent: bool,
    // Download finished without ever producing a sample: the track is unplayable
    download_failed: bool,
    fail_sent: bool,
    // Real audio actually reached the output for this playback (stats gating)
    play_confirmed_sent: bool,
    // Replay: offset to read from full_samples without clone
    replay_offset: Option<usize>,
}

impl Deck {
    fn new(name: &str) -> Self {
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

    fn load(&mut self, url: String) {
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

    fn get_next_sample(&mut self) -> Option<f32> {
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
    fn poll_receiver(&mut self) {
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
                        send_log("info", &format!("✅ [RX-DONE] Deck {} → {} chunks ricevuti, buffer finale: {} samples", self.name, chunks_received, samples_after));
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

    fn is_ready_for_crossfade(&self) -> bool {
        self.available_samples() >= SAMPLE_RATE * CHANNELS / 2
    }

    /// Available samples (streaming + replay)
    fn available_samples(&self) -> usize {
        self.samples.len()
            + match self.replay_offset {
                Some(offset) => self.full_samples.len().saturating_sub(offset),
                None => 0,
            }
    }

    fn has_samples(&self) -> bool {
        !self.samples.is_empty()
            || self
                .replay_offset
                .map_or(false, |o| o < self.full_samples.len())
    }

    /// Restarts the deck from the beginning without re-downloading.
    /// Uses replay_offset to read from full_samples without cloning.
    fn restart(&mut self) {
        self.samples.clear();
        self.replay_offset = Some(0);
        self.has_ended = false;
        self.samples_played = 0;
        self.total_samples_read = 0;
        self.buffer_level = self.full_samples.len();
        self.reset_flags();
    }

    /// Reset of edge detection flags (for transitions)
    fn reset_flags(&mut self) {
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

fn download_and_decode_advanced(
    url: &str,
    tx: Sender<Vec<f32>>,
    cancel: Arc<AtomicBool>,
    deck_name: &str,
) -> Result<()> {
    // Direct streaming flow:
    // 1. yt-dlp downloads/streams audio to stdout
    // 2. yt-dlp's stdout is connected to ffmpeg's stdin
    // 3. ffmpeg decodes and returns PCM

    send_log("info", &format!("Streaming: {}", &url[..url.len().min(60)]));

    // Uses yt-dlp binary from bot directory
    let yt_dlp_binary = format!("{}/bin/yt-dlp", get_base_path());

    let mut yt_dlp_cmd = ProcessCommand::new(yt_dlp_binary);
    yt_dlp_cmd
        .arg("--no-update")
        .arg("-f").arg("ba/b/bestaudio/best")
        .arg("--ignore-no-formats-error")
        .arg("--force-ipv4")
        .arg("--user-agent").arg("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .arg("-o").arg("-")
        .arg("-q")
        .arg("--no-warnings")
        .arg("--no-cache-dir")
        .arg("--no-playlist")
        .arg("--socket-timeout").arg("30")
        .arg("--retries").arg("5")
        .arg("--fragment-retries").arg("5")
        .arg("--concurrent-fragments").arg("1")
        .arg("--js-runtimes").arg("node")
        .arg("--impersonate").arg("chrome");

    yt_dlp_cmd.env("PATH", env::var("PATH").unwrap_or_default());

    // Proxy: default socks5h://127.0.0.1:5040; YTDLP_PROXY_URL=none to disable
    let proxy_url = env_opt("YTDLP_PROXY_URL").or_else(|| {
        if env::var("YTDLP_PROXY_URL").is_ok() {
            None
        } else {
            Some(default_ytdlp_proxy_url())
        }
    });
    if let Some(ref proxy) = proxy_url {
        send_log("info", &format!("yt-dlp proxy attivo: {}", proxy));
        yt_dlp_cmd.arg("--proxy").arg(proxy);
    } else {
        send_log("info", "yt-dlp proxy disabilitato (YTDLP_PROXY_URL=none)");
    }

    // Cookie browser: disabled by default on Linux; YTDLP_COOKIE_BROWSER=chromium to force them
    let cookie_browser = env_opt("YTDLP_COOKIE_BROWSER").or_else(|| {
        if env::var("YTDLP_COOKIE_BROWSER").is_ok() {
            None
        } else {
            default_ytdlp_cookie_browser()
        }
    });
    if let Some(ref browser) = cookie_browser {
        yt_dlp_cmd.arg("--cookies-from-browser").arg(browser);
    } else {
        send_log(
            "info",
            "yt-dlp cookies-from-browser disabilitato (YTDLP_COOKIE_BROWSER=none)",
        );
    }
    yt_dlp_cmd.arg("--mark-watched");

    // Fallback to cookies file if exists
    let cookies_file = format!("{}/youtube-cookies.txt", get_base_path());
    if std::path::Path::new(&cookies_file).exists() {
        yt_dlp_cmd.arg("--cookies").arg(&cookies_file);
    }

    // Extractor args configurable via env
    let extractor_args = env::var("YTDLP_EXTRACTOR_ARGS").unwrap_or_else(|_| {
        "youtube:player_client=web,android,ios,mweb".to_string()
    });
    send_log(
        "info",
        &format!("yt-dlp extractor-args attivi: {}", extractor_args),
    );
    yt_dlp_cmd.arg("--extractor-args").arg(&extractor_args);

    let mut yt_dlp_child = yt_dlp_cmd
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow!("Failed to spawn yt-dlp: {}", e))?;

    let yt_dlp_stdout = yt_dlp_child
        .stdout
        .take()
        .ok_or(anyhow!("Failed to open yt-dlp stdout"))?;
    let yt_dlp_stderr = yt_dlp_child
        .stderr
        .take()
        .ok_or(anyhow!("Failed to open yt-dlp stderr"))?;

    let stderr_lines: Arc<std::sync::Mutex<Vec<String>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let stderr_lines_cap = stderr_lines.clone();
    let cancel_stderr_yt = cancel.clone();
    thread::spawn(move || {
        let reader = BufReader::new(yt_dlp_stderr);
        for line in reader.lines() {
            if cancel_stderr_yt.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(l) = line {
                let trimmed = l.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(mut buf) = stderr_lines_cap.lock() {
                    if buf.len() >= 40 {
                        buf.remove(0);
                    }
                    buf.push(trimmed.to_string());
                }
                let lower = trimmed.to_lowercase();
                if lower.contains("error")
                    || lower.contains("unable")
                    || lower.contains("failed")
                    || lower.contains("blocked")
                    || lower.contains("sign in")
                {
                    send_log("error", &format!("[yt-dlp] {}", trimmed));
                }
            }
        }
    });

    // Uses ffmpeg from system PATH
    let ffmpeg_path = "ffmpeg";

    // Launches ffmpeg on the raw stream provided by yt-dlp.
    let mut ffmpeg_child = ProcessCommand::new(ffmpeg_path)
        .arg("-loglevel")
        .arg("error")
        .arg("-hide_banner")
        .arg("-fflags")
        .arg("+discardcorrupt")
        .arg("-i")
        .arg("pipe:0")
        .arg("-vn")
        .arg("-ac")
        .arg("2")
        .arg("-ar")
        .arg("48000")
        .arg("-af")
        .arg("aformat=s16:48000")
        .arg("-f")
        .arg("s16le")
        .arg("-acodec")
        .arg("pcm_s16le")
        .arg("-")
        .stdin(yt_dlp_stdout)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow!("Failed to spawn ffmpeg: {}", e))?;

    let stdout = ffmpeg_child
        .stdout
        .take()
        .ok_or(anyhow!("Failed to open ffmpeg stdout"))?;
    let stderr = ffmpeg_child
        .stderr
        .take()
        .ok_or(anyhow!("Failed to open ffmpeg stderr"))?;

    // Error log handling thread - cancel-aware
    let cancel_stderr_ff = cancel.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if cancel_stderr_ff.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(l) = line {
                let trimmed = l.trim();
                if !trimmed.is_empty() {
                    send_log("stream_error", &format!("[ffmpeg] {}", trimmed));
                }
            }
        }
    });

    send_log(
        "stream_opened",
        &format!(
            "[Deck {}] Streaming: {}",
            deck_name,
            &url[..url.len().min(60)]
        ),
    );

    // ── Download watchdog ──────────────────────────────────────
    // If yt-dlp/ffmpeg don't produce data within 30 seconds, they're stuck.
    // The watchdog kills them by PID, unblocking the read_i16 (which will get EOF).
    let yt_dlp_pid = yt_dlp_child.id();
    let ffmpeg_pid = ffmpeg_child.id();
    let cancel_wd = cancel.clone();
    let first_data_arrived = Arc::new(AtomicBool::new(false));
    let first_data_wd = first_data_arrived.clone();
    let deck_name_wd = deck_name.to_string();
    thread::spawn(move || {
        let watchdog_secs = get_download_watchdog_secs();
        send_log(
            "info",
            &format!("Download watchdog active: {}s", watchdog_secs),
        );
        // Checks every 500ms until configured timeout.
        let checks = watchdog_secs.saturating_mul(2);
        for _ in 0..checks {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if first_data_wd.load(Ordering::Relaxed) || cancel_wd.load(Ordering::Relaxed) {
                return; // Data arrived or download canceled: watchdog not needed
            }
        }
        // Timeout without data → kill stuck processes
        send_log("error", &format!("⏰ [Deck {}] Download watchdog: {}s senza dati, killing yt-dlp (PID {}) + ffmpeg (PID {})",
            deck_name_wd, watchdog_secs, yt_dlp_pid, ffmpeg_pid));
        #[cfg(windows)]
        {
            // /F = force, /T = tree (kills sub-processes too)
            let _ = ProcessCommand::new("taskkill")
                .args(["/F", "/T", "/PID", &yt_dlp_pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = ProcessCommand::new("taskkill")
                .args(["/F", "/T", "/PID", &ffmpeg_pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(not(windows))]
        unsafe {
            libc::kill(yt_dlp_pid as i32, libc::SIGKILL);
            libc::kill(ffmpeg_pid as i32, libc::SIGKILL);
        }
    });

    // RAW DATA READER - ADVANCED VERSION
    let mut reader = BufReader::new(stdout);
    let mut buffer: Vec<f32> = Vec::with_capacity(8192);
    let mut _samples_read = 0;
    let mut total_samples = 0;
    let mut last_log_time = std::time::Instant::now();
    let stream_start = std::time::Instant::now();
    let mut cancelled = false;

    loop {
        // Checks if download was canceled (deck replaced)
        if cancel.load(Ordering::Relaxed) {
            send_log(
                "info",
                &format!(
                    "🛑 [Deck {}] Download cancelled, killing processes",
                    deck_name
                ),
            );
            cancelled = true;
            break;
        }

        // Read 2 bytes (16 bit)
        match reader.read_i16::<LE>() {
            Ok(sample_i16) => {
                let sample_f32 = sample_i16 as f32 / 32768.0;
                buffer.push(sample_f32);
                _samples_read += 1;
                total_samples += 1;

                // Signals watchdog that data is arriving
                if !first_data_arrived.load(Ordering::Relaxed) {
                    first_data_arrived.store(true, Ordering::Relaxed);
                    send_log(
                        "info",
                        &format!(
                            "📦 [Deck {}] First audio data received after {}ms",
                            deck_name,
                            stream_start.elapsed().as_millis()
                        ),
                    );
                }

                // Sends in ~20ms chunks for buffer_ready reactivity
                if buffer.len() >= 1920 {
                    if tx.send(std::mem::take(&mut buffer)).is_err() {
                        send_log(
                            "info",
                            &format!("🛑 [Deck {}] Receiver chiuso, stopping download", deck_name),
                        );
                        cancelled = true;
                        break;
                    }
                    buffer.reserve(1920);

                    if last_log_time.elapsed().as_secs() >= 1 {
                        _samples_read = 0;
                        last_log_time = std::time::Instant::now();
                    }
                }
            }
            Err(e) => {
                let stream_duration_ms = stream_start.elapsed().as_millis() as u64;
                let audio_seconds = total_samples / (SAMPLE_RATE * CHANNELS);

                if e.kind() == io::ErrorKind::UnexpectedEof {
                    // Normal song end - send remaining buffer
                    if !buffer.is_empty() {
                        let _ = tx.send(std::mem::take(&mut buffer));
                    }
                    if total_samples == 0 {
                        send_log(
                            "error",
                            &format!("❌ CRITICO: Scaricati 0 sample - yt-dlp o ffmpeg fallito!"),
                        );
                        send_log(
                            "error",
                            &format!("Verifica: (1) yt-dlp è installato correttamente"),
                        );
                        send_log(
                            "error",
                            &format!("Verifica: (2) L'URL YouTube è valido e accessibile"),
                        );
                        send_log(
                            "error",
                            &format!(
                                "Verifica: (3) Proxy/tunnel SOCKS attivo (proxy: {})",
                                proxy_url
                                    .as_deref()
                                    .unwrap_or("nessuno")
                            ),
                        );
                        if let Ok(buf) = stderr_lines.lock() {
                            if !buf.is_empty() {
                                send_log("error", "Ultimi messaggi yt-dlp stderr:");
                                for line in buf.iter().rev().take(8).rev() {
                                    send_log("error", &format!("[yt-dlp] {}", line));
                                }
                            }
                        }
                    } else if audio_seconds < 10 {
                        // PREMATURE TERMINATION - important to log
                        send_log("error", &format!("⚠️ PREMATURE STREAM END: only {} seconds of audio after {}ms of streaming!", audio_seconds, stream_duration_ms));
                        send_log("error", &format!("This likely indicates that yt-dlp or ffmpeg failed mid-stream (possible Opus codec issue)"));
                    } else {
                        send_log(
                            "debug",
                            &format!(
                                "Song finished ({} seconds, {} samples total)",
                                audio_seconds, total_samples
                            ),
                        );
                    }
                } else {
                    // Actual read error (e.g. yt-dlp crashed or pipe broken)
                    send_log(
                        "error",
                        &format!(
                            "❌ CRITICAL READ ERROR: {} (read {} samples / {} sec total)",
                            e, total_samples, audio_seconds
                        ),
                    );
                    send_log(
                        "error",
                        &format!("This means the yt-dlp/ffmpeg pipe is broken or crashed"),
                    );
                    // If it's a broken pipe error, it could be due to process issues
                    if total_samples > 0 {
                        send_log(
                            "debug",
                            "Attempted to continue playback with partial audio loaded",
                        );
                    }
                }
                break;
            }
        }
    }

    // If canceled, kill processes immediately to free resources and
    // prevent concurrent downloads of the same URL from blocking each other
    if cancelled {
        let _ = yt_dlp_child.kill();
        let _ = ffmpeg_child.kill();
    } else {
        // Sends remaining data only if NOT canceled
        if !buffer.is_empty() {
            let _ = tx.send(std::mem::take(&mut buffer));
        }
    }

    // Wait for processes to terminate (after kill it's immediate)
    let _ = yt_dlp_child.wait();
    let _ = ffmpeg_child.wait();

    Ok(())
}

/// Writes one PCM chunk to stdout and flushes it.
/// Errors are propagated on purpose: a partial write would shift the 16-bit
/// sample alignment of the whole stream and every following sample would be
/// decoded as noise, so the caller stops the mixer instead of carrying on.
fn write_pcm_chunk<W: Write>(handle: &mut W, bytes: &[u8]) -> io::Result<()> {
    handle.write_all(bytes)?;
    handle.flush()
}

fn mixer_loop(cmd_rx: Receiver<InputCommand>) {
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
    let mut mid_chunk_loop_restart = false; // true se il loop restart è avvenuto mid-chunk

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
                                "Load su deck sorgente durante crossfade → snap to {}",
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

                    // Reset COMPLETO del deck come se fosse nuovo
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
                                &format!("⏳ Crossfade pending: deck target non pronto"),
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

                            send_log("info", &format!("⚡ Skip immediato → deck {}", target_deck));
                            send_log(
                                "deck_changed",
                                &format!("deck={}, triggered_by=skip_command", target_deck),
                            );
                        } else {
                            // ⏳ PENDING SKIP: target deck not ready, continue playing current deck
                            pending_transition =
                                Some((target_deck.clone(), std::time::Instant::now(), false, 0));
                            send_log("info", &format!("⏳ Skip pending: deck {} non pronto, continuo riproduzione corrente", target_deck));
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

                        // Inizia il crossfade verso il deck proposto
                        crossfading = true;
                        target_deck = new_deck.clone();
                        crossfade_total = SAMPLE_RATE * CHANNELS * 6; // 6 secondi di crossfade
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
                            "✅ Pending {} eseguito dopo {}ms (ready={}, done={}, timeout={})",
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

                    send_log("info", &format!("⚡ Skip completato → deck {}", etarget));
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
                        // Active deck è esaurito
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
                                // Riavvia lo stesso deck da full_samples
                                if active_deck == "A" {
                                    deck_a.restart();
                                } else {
                                    deck_b.restart();
                                }
                                mid_chunk_loop_restart = true;

                                // Prendi il primo sample dal deck riavviato
                                if active_deck == "A" {
                                    deck_a.get_next_sample().unwrap_or(0.0)
                                } else {
                                    deck_b.get_next_sample().unwrap_or(0.0)
                                }
                            } else {
                                // ── MID-CHUNK AUTO-SWITCH ──
                                // Prova a switchare all'altro deck che ha dati precaricati
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
                                &format!("⚡ Auto-gapless: switch istantaneo → deck {}", other),
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
                                    send_log("error", &format!("⏰ Auto-gapless: deck {} in download da >30s senza dati → track unplayable", other));
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
                                    send_log("info", &format!("⏸️  Auto-gapless stall: deck {} in download ({}ms), aspetto primi dati...",
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

fn main() {
    // Prevents Rust process from terminating on SIGPIPE when Node closes pipe
    // (Unix only - Windows doesn't have SIGPIPE)
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    // Installs global panic hook: if mixer_loop panics (e.g. division by zero,
    // unwrap on None, OOM), the hook writes an error event to stderr and terminates
    // process with code 1. This ensures Node.js receives exit code and starts
    // crash recovery, instead of leaving the process alive-but-silent.
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        send_log("error", &format!("PANIC in mixer thread: {}", msg));
        std::process::exit(1);
    }));

    let (tx, rx) = bounded::<InputCommand>(10);

    // Audio thread (Priority)
    thread::spawn(move || mixer_loop(rx));

    // Input JSON thread (Node -> Rust)
    let stdin = io::stdin();
    let iterator = serde_json::Deserializer::from_reader(stdin).into_iter::<InputCommand>();
    for item in iterator {
        if let Ok(cmd) = item {
            let _ = tx.send(cmd);
        }
    }
}
