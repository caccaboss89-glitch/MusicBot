//! Download and decode pipeline: yt-dlp streams the audio, ffmpeg decodes it to
//! PCM, and the samples are pushed to the owning deck over a channel.

use anyhow::{anyhow, Result};
use byteorder::{ReadBytesExt, LE}; // Essential for reading audio
use crossbeam_channel::Sender;
#[cfg(not(windows))]
use libc;
use std::env;
use std::io::{self, BufRead, BufReader};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use crate::config::{
    default_ytdlp_cookie_browser, default_ytdlp_proxy_url, env_opt, get_base_path,
    get_download_watchdog_secs, CHANNELS, SAMPLE_RATE,
};
use crate::protocol::send_log;

pub fn download_and_decode_advanced(
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
        send_log("info", &format!("yt-dlp proxy active: {}", proxy));
        yt_dlp_cmd.arg("--proxy").arg(proxy);
    } else {
        send_log("info", "yt-dlp proxy disabled (YTDLP_PROXY_URL=none)");
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
            "yt-dlp cookies-from-browser disabled (YTDLP_COOKIE_BROWSER=none)",
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
        &format!("yt-dlp extractor-args active: {}", extractor_args),
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
        send_log("error", &format!("⏰ [Deck {}] Download watchdog: {}s without data, killing yt-dlp (PID {}) + ffmpeg (PID {})",
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
                            &format!("🛑 [Deck {}] Receiver closed, stopping download", deck_name),
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
                            &format!("❌ CRITICAL: 0 samples downloaded - yt-dlp or ffmpeg failed!"),
                        );
                        send_log(
                            "error",
                            &format!("Check: (1) yt-dlp is installed correctly"),
                        );
                        send_log(
                            "error",
                            &format!("Check: (2) the YouTube URL is valid and reachable"),
                        );
                        send_log(
                            "error",
                            &format!(
                                "Check: (3) SOCKS proxy/tunnel active (proxy: {})",
                                proxy_url
                                    .as_deref()
                                    .unwrap_or("none")
                            ),
                        );
                        if let Ok(buf) = stderr_lines.lock() {
                            if !buf.is_empty() {
                                send_log("error", "Last yt-dlp stderr messages:");
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
