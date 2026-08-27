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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use crate::config::{
    default_ytdlp_cookie_browser, env_opt, get_base_path, get_download_watchdog_secs, CHANNELS,
    SAMPLE_RATE,
};
use crate::protocol::send_log;

/// First `max` characters of a URL, cut on a character boundary.
/// Slicing a String by byte index panics in the middle of a multi-byte
/// character, and the engine has no business dying over a log line.
fn url_preview(url: &str, max: usize) -> String {
    url.chars().take(max).collect()
}

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

    send_log("info", &format!("Streaming: {}", url_preview(url, 60)));

    // yt-dlp runs through PYTHON_BIN, the same interpreter Node uses for its own
    // metadata calls. The zipapp in bin/ is only a fallback: its shebang picks
    // the system python3, which is a different install with a different yt-dlp
    // version and its own dependencies. Missing curl_cffi there makes
    // --impersonate fail on every playback while search keeps working, which is
    // exactly the kind of split-brain failure this avoids.
    let mut yt_dlp_cmd = match env_opt("PYTHON_BIN") {
        Some(python) => {
            let mut cmd = ProcessCommand::new(python);
            cmd.arg("-m").arg("yt_dlp");
            cmd
        }
        None => ProcessCommand::new(format!("{}/bin/yt-dlp", get_base_path())),
    };
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

    // Proxy: none by default, the bot goes out on a residential connection.
    // Set YTDLP_PROXY_URL only to route the download through a tunnel/VPN.
    let proxy_url = env_opt("YTDLP_PROXY_URL");
    if let Some(ref proxy) = proxy_url {
        send_log("info", &format!("yt-dlp proxy active: {}", proxy));
        yt_dlp_cmd.arg("--proxy").arg(proxy);
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

    // JS engine for YouTube's `n` challenge. yt-dlp enables only deno on its
    // own, so without this it downloads whatever formats survive the failed
    // challenge instead of the best audio. Node is the safe default: it is the
    // process that spawned this one. YTDLP_JS_RUNTIME=none hands the choice
    // back to yt-dlp.
    let js_runtime = env_opt("YTDLP_JS_RUNTIME").or_else(|| {
        if env::var("YTDLP_JS_RUNTIME").is_ok() {
            None
        } else {
            Some("node".to_string())
        }
    });
    if let Some(ref runtime) = js_runtime {
        yt_dlp_cmd.arg("--js-runtimes").arg(runtime);
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
            url_preview(url, 60)
        ),
    );

    // ── Download watchdog ─────────────────────────────
    // Watches the WHOLE download, not just its first byte: a stream that dies
    // half way through leaves read_i16 blocked forever, and with it this thread,
    // yt-dlp and ffmpeg. Killing the two processes unblocks the read (EOF).
    // It also reacts to cancellation, which a blocked read cannot observe.
    let yt_dlp_pid = yt_dlp_child.id();
    let ffmpeg_pid = ffmpeg_child.id();
    let cancel_wd = cancel.clone();
    let stream_start = std::time::Instant::now();
    // Milliseconds since stream_start at which the reader last received data.
    let last_progress_ms = Arc::new(AtomicU64::new(0));
    let last_progress_wd = last_progress_ms.clone();
    // Set once the reader loop is over, so the watchdog stops before the child
    // processes are reaped and their PIDs could be reused by the system.
    let reader_done = Arc::new(AtomicBool::new(false));
    let reader_done_wd = reader_done.clone();
    let deck_name_wd = deck_name.to_string();
    thread::spawn(move || {
        let watchdog_secs = get_download_watchdog_secs();
        let timeout_ms = watchdog_secs.saturating_mul(1000);
        send_log(
            "info",
            &format!("Download watchdog active: {}s", watchdog_secs),
        );

        let reason = loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if reader_done_wd.load(Ordering::Relaxed) {
                return; // Download finished on its own: nothing to kill
            }
            if cancel_wd.load(Ordering::Relaxed) {
                break "download cancelled".to_string();
            }
            let idle_ms = (stream_start.elapsed().as_millis() as u64)
                .saturating_sub(last_progress_wd.load(Ordering::Relaxed));
            if idle_ms >= timeout_ms {
                break format!("{}s without data", watchdog_secs);
            }
        };

        // Re-check: the reader may have finished while we were deciding, and
        // signalling a PID that has already been reaped could hit another process.
        if reader_done_wd.load(Ordering::Relaxed) {
            return;
        }

        send_log("error", &format!("⏰ [Deck {}] Download watchdog: {}, killing yt-dlp (PID {}) + ffmpeg (PID {})",
            deck_name_wd, reason, yt_dlp_pid, ffmpeg_pid));
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
    let mut total_samples = 0;
    let mut first_data_logged = false;
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
                total_samples += 1;

                if !first_data_logged {
                    first_data_logged = true;
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
                    // Tells the watchdog the stream is still alive
                    last_progress_ms
                        .store(stream_start.elapsed().as_millis() as u64, Ordering::Relaxed);
                    if tx.send(std::mem::take(&mut buffer)).is_err() {
                        send_log(
                            "info",
                            &format!("🛑 [Deck {}] Receiver closed, stopping download", deck_name),
                        );
                        cancelled = true;
                        break;
                    }
                    buffer.reserve(1920);
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
                            "❌ CRITICAL: 0 samples downloaded - yt-dlp or ffmpeg failed!",
                        );
                        send_log("error", "Check: (1) yt-dlp is installed correctly");
                        send_log(
                            "error",
                            "Check: (2) the YouTube URL is valid and reachable",
                        );
                        send_log(
                            "error",
                            &format!(
                                "Check: (3) outbound network reachable (proxy: {})",
                                proxy_url.as_deref().unwrap_or("direct")
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
                        send_log("error", "This likely indicates that yt-dlp or ffmpeg failed mid-stream (possible Opus codec issue)");
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
                        "This means the yt-dlp/ffmpeg pipe is broken or crashed",
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

    // The watchdog must stop before the children are killed and reaped below,
    // otherwise it could signal a PID the system has already handed to somebody
    // else.
    reader_done.store(true, Ordering::Relaxed);

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
