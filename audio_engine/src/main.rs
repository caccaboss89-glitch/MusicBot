use anyhow::{anyhow, Result};
use byteorder::{ReadBytesExt, WriteBytesExt, LE}; // Fondamentale per leggere l'audio
use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{self, Write, BufRead, BufReader};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::env;
#[cfg(unix)]
use libc;

// --- CONFIGURAZIONE PERCORSI ---
#[allow(dead_code)]
fn get_base_path() -> String {
    env::var("DISCORD_BOT_PATH").unwrap_or_else(|_| {
        if cfg!(windows) {
            "F:\\Programmi\\Bots\\DiscordMusicBot".to_string()
        } else {
            "/home/ubuntu/DiscordBots/DiscordMusicBot".to_string()
        }
    })
}

// --- FUNZIONE PER TROVARE PYTHON ---
/**
 * Trova il percorso di python.exe
 * Prova prima i percorsi comuni su Windows, poi il comando dal PATH
 */
fn find_python_executable() -> Result<String> {
    use std::path::Path;
    
    if cfg!(windows) {
        // Prova i percorsi comuni su Windows
        let common_paths = [
            "C:\\Users\\Amministratore\\AppData\\Local\\Programs\\Python\\Python313\\python.exe",
            "C:\\Users\\Amministratore\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
            "C:\\Program Files\\Python313\\python.exe",
            "C:\\Program Files\\Python312\\python.exe",
            "C:\\Program Files (x86)\\Python313\\python.exe",
            "C:\\Program Files (x86)\\Python312\\python.exe",
        ];
        
        for path_str in &common_paths {
            if Path::new(path_str).exists() {
                return Ok(path_str.to_string());
            }
        }
        
        // Ripiego: usa il comando 'python' dal PATH
        // Su Windows moderno, 'python' dovrebbe risolvere dal PATH di sistema
        Ok("python".to_string())
    } else {
        // Su Unix/Linux, usa semplicemente 'python3' o 'python'
        Ok("python".to_string())
    }
}

const SAMPLE_RATE: usize = 48000;
const CHANNELS: usize = 2;
const CHUNK_SIZE: usize = 960; // 20ms

// Default per retrocompat: LOAD senza autoplay specifico va in autoplay
fn default_autoplay() -> bool { true }

#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "snake_case")]
enum InputCommand {
    Load { url: String, deck: String, #[serde(default = "default_autoplay")] autoplay: bool },
    Crossfade { duration_ms: u64, to_deck: String },
    Play { deck: String },
    StopDeck { deck: String },
    SetProactiveCrossfade { enabled: bool },  // 🔥 Controlla crossfade proattivo
    SetLoop { enabled: bool },  // 🔁 Loop mode: quando il deck finisce, riavvia da full_samples
    SkipTo { target_deck: String },  // 🎵 NUOVO: Skip diretto al Rust (commuta al target_deck)
    ApproveProposal { new_deck: String },  // 🤝 NUOVO: Approva una proposta di cambio deck (e fa crossfade)
    RestartDeck { deck: String },  // 🔄 Replay: riavvia deck dall'inizio senza ri-scaricare
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
    let msg = LogMessage { event: event.to_string(), data: data.to_string() };
    if let Ok(json) = serde_json::to_string(&msg) { eprintln!("{}", json); }
}



struct Deck {
    name: String,
    samples: VecDeque<f32>,
    full_samples: Vec<f32>,  // Tutti i sample ricevuti (per replay senza ri-download)
    is_loading: bool,
    has_ended: bool,
    receiver: Option<Receiver<Vec<f32>>>,
    buffer_level: usize,
    total_samples_read: usize,
    real_samples_received: usize,
    samples_played: usize, // Campioni effettivamente RIPRODOTTI (non solo ricevuti)
    approaching_end_sent: bool,  // Flag: approaching_end event inviato?
    cancel_token: Option<Arc<AtomicBool>>,  // Segnala al thread di download di fermarsi
    load_started_at: Option<std::time::Instant>,  // Quando load() è stato chiamato
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
            approaching_end_sent: false,
            cancel_token: None,
            load_started_at: None,
        }
    }

    fn load(&mut self, url: String) {
        // Cancella il download precedente (se in corso)
        // Questo segnala al thread di uccidere yt-dlp/ffmpeg e uscire
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
        self.approaching_end_sent = false;
        self.is_loading = true;
        self.load_started_at = Some(std::time::Instant::now());
        let (tx, rx) = bounded::<Vec<f32>>(100);
        self.receiver = Some(rx);

        let cancel = Arc::new(AtomicBool::new(false));
        self.cancel_token = Some(cancel.clone());
        let deck_name = self.name.clone();
        
        // Avvia thread di download
        thread::spawn(move || {
            if let Err(e) = download_and_decode_advanced(&url, tx, cancel, &deck_name) {
                send_log("error", &format!("[Deck {}] Download error: {}", deck_name, e));
            }
        });
    }

    fn get_next_sample(&mut self) -> Option<f32> {
        // Prima prova a ricevere nuovi chunk dal decoder
        self.poll_receiver();
        
        if let Some(sample) = self.samples.pop_front() {
            self.buffer_level = self.buffer_level.saturating_sub(1);
            self.total_samples_read += 1;
            self.samples_played += 1; // Conta i sample effettivamente riprodotti
            Some(sample)
        } else {
            // Se non ci sono sample ma non è finito, manteniamo silenzio attivo
            if !self.has_ended {
                // Caso speciale: dopo restart(), receiver è None e full_samples non vuoto,
                // quindi quando i sample finiscono non c'è più nulla da ricevere.
                // Segnala fine per permettere auto-loop o auto-switch.
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
    
    // NUOVO: Aggiorna il buffer senza consumare sample (per deck inattivi)
    fn poll_receiver(&mut self) {
        if let Some(rx) = &self.receiver {
            // Leggi TUTTI i chunk disponibili, non solo uno
            let mut chunks_received = 0;
            let _samples_before = self.samples.len();
            loop {
                match rx.try_recv() {
                    Ok(chunk) => {
                        chunks_received += 1;
                        self.real_samples_received += chunk.len();
                        // Prima data arrivata → clear load timestamp
                        if self.load_started_at.is_some() {
                            self.load_started_at = None;
                        }
                        self.full_samples.extend(&chunk);  // Salva copia per replay
                        self.samples.extend(chunk);
                        self.buffer_level = self.samples.len(); // Aggiorna in base alla coda reale
                    },
                    Err(TryRecvError::Disconnected) => { 
                        let samples_after = self.samples.len();
                        send_log("info", &format!("✅ [RX-DONE] Deck {} → {} chunks ricevuti, buffer finale: {} samples", self.name, chunks_received, samples_after));
                        if !self.has_ended { 
                            self.has_ended = true; 
                        }
                        self.receiver = None;
                        break;
                    },
                    Err(TryRecvError::Empty) => {
                        break;
                    },
                }
            }
        }
    }

    #[allow(dead_code)]
    fn get_buffer_status(&self) -> (usize, bool) {
        // Usa samples.len() per un conteggio accurato
        (self.samples.len(), self.has_ended)
    }

    fn is_ready_for_crossfade(&self) -> bool {
        // 0.5 secondi stereo = SAMPLE_RATE * CHANNELS / 2
        // Soglia bassa per massimizzare la reattività del buffer_ready
        // Il deck viene precaricato immediatamente, quindi ha tempo per accumulare
        self.samples.len() >= SAMPLE_RATE * CHANNELS / 2
    }

    /// Riavvia il deck dall'inizio senza ri-scaricare.
    /// Copia tutti i sample ricevuti (full_samples) nel buffer di riproduzione.
    fn restart(&mut self) {
        self.samples = VecDeque::from(self.full_samples.clone());
        self.samples_played = 0;
        self.total_samples_read = 0;
        self.buffer_level = self.samples.len();
    }
}

impl Drop for Deck {
    fn drop(&mut self) {
        // Quando il Deck viene distrutto (es. deck_a = Deck::new()),
        // segnala al thread di download di fermarsi e killare yt-dlp/ffmpeg
        if let Some(ref token) = self.cancel_token {
            token.store(true, Ordering::Relaxed);
        }
    }
}

fn download_and_decode_advanced(url: &str, tx: Sender<Vec<f32>>, cancel: Arc<AtomicBool>, deck_name: &str) -> Result<()> {
    // LANCIO DIRETTO:
    // 1. Lancia yt-dlp tramite Python (python -m yt_dlp)
    // 2. Collega stdout di yt-dlp a stdin di ffmpeg via pipe
    // 3. ffmpeg processa e restituisce PCM
    
    send_log("info", &format!("Streaming: {}", &url[..url.len().min(60)]));

    // Trova il percorso di Python dinamicamente
    let python_path = find_python_executable()?;

    // Lancia yt-dlp tramite Python
    // 🔥 CRITICO FIX: Forza esplicitamente formato 140 (m4a/AAC) che ha SEMPRE container headers
    // Evita completamente il problema Opus packet header
    let mut yt_dlp_child = ProcessCommand::new(&python_path)
        .arg("-m")
        .arg("yt_dlp")
        .arg("-f").arg("140")                   // 🔥 FORCE: m4a/AAC 128kbps (format code 140)
        .arg("--force-ipv4")
        .arg("-q")
        .arg("--no-warnings")
        .arg("-o").arg("-")
        .arg(url)
        .stdin(Stdio::null())                   // 🔥 CRITICO: Evita che yt-dlp si blocchi aspettando stdin
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow!("Failed to spawn yt-dlp: {}", e))?;

    let yt_dlp_stdout = yt_dlp_child.stdout.take().ok_or(anyhow!("Failed to open yt-dlp stdout"))?;
    let yt_dlp_stderr = yt_dlp_child.stderr.take().ok_or(anyhow!("Failed to open yt-dlp stderr"))?;

    // Log errori di yt-dlp in un thread separato
    thread::spawn(move || {
        let reader = BufReader::new(yt_dlp_stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                let trimmed = l.trim();
                if !trimmed.is_empty() && trimmed.to_lowercase().contains("error") {
                    send_log("error", &format!("[yt-dlp] {}", trimmed));
                }
            }
        }
    });

    // Usa ffmpeg dal PATH di sistema
    let ffmpeg_path = "ffmpeg";

    // Lancia ffmpeg e collega stdin a stdout di yt-dlp
    // 🔧 IMPORTANTE: Aggiunti flag per resilienza verso Opus e corrupted streams
    let mut ffmpeg_child = ProcessCommand::new(ffmpeg_path)
        .arg("-loglevel").arg("error")
        .arg("-hide_banner")
        .arg("-fflags").arg("+discardcorrupt")  // 🔥 Salta frame corrotti
        .arg("-i").arg("pipe:0")
        .arg("-vn")                              // Disabilita video (solo audio)
        .arg("-ac").arg("2")                     // 2 canali stereo
        .arg("-ar").arg("48000")                 // 48kHz sample rate
        .arg("-af").arg("aformat=s16:48000")     // 🔥 Forza output audio format
        .arg("-f").arg("s16le")                  // Formato output: 16-bit little endian PCM
        .arg("-acodec").arg("pcm_s16le")         // Codec output
        .arg("-")
        .stdin(yt_dlp_stdout)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow!("Failed to spawn ffmpeg: {}", e))?;

    let stdout = ffmpeg_child.stdout.take().ok_or(anyhow!("Failed to open ffmpeg stdout"))?;
    let stderr = ffmpeg_child.stderr.take().ok_or(anyhow!("Failed to open ffmpeg stderr"))?;

    // Thread gestione log errori - LOG TUTTI GLI ERRORI CRITICI
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line { 
                let trimmed = l.trim();
                if !trimmed.is_empty() {
                    send_log("stream_error", &format!("[ffmpeg] {}", trimmed));
                }
            }
        }
    });

    send_log("stream_opened", &format!("[Deck {}] Streaming: {}", deck_name, &url[..url.len().min(60)]));

    // ── Download watchdog ──────────────────────────────────────
    // Se yt-dlp/ffmpeg non producono dati entro 30 secondi, sono bloccati.
    // Il watchdog li uccide per PID, sbloccando il read_i16 (che otterrà EOF).
    let yt_dlp_pid = yt_dlp_child.id();
    let ffmpeg_pid = ffmpeg_child.id();
    let cancel_wd = cancel.clone();
    let first_data_arrived = Arc::new(AtomicBool::new(false));
    let first_data_wd = first_data_arrived.clone();
    let deck_name_wd = deck_name.to_string();
    thread::spawn(move || {
        // Controlla ogni 500ms per 30 secondi
        for _ in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if first_data_wd.load(Ordering::Relaxed) || cancel_wd.load(Ordering::Relaxed) {
                return; // Dati arrivati o download cancellato: watchdog non serve
            }
        }
        // 30 secondi senza dati → kill processi bloccati
        send_log("error", &format!("⏰ [Deck {}] Download watchdog: 30s senza dati, killing yt-dlp (PID {}) + ffmpeg (PID {})",
            deck_name_wd, yt_dlp_pid, ffmpeg_pid));
        #[cfg(windows)]
        {
            // /F = force, /T = tree (uccide anche sotto-processi)
            let _ = ProcessCommand::new("taskkill")
                .args(["/F", "/T", "/PID", &ffmpeg_pid.to_string()])
                .stdout(Stdio::null()).stderr(Stdio::null())
                .status();
            let _ = ProcessCommand::new("taskkill")
                .args(["/F", "/T", "/PID", &yt_dlp_pid.to_string()])
                .stdout(Stdio::null()).stderr(Stdio::null())
                .status();
        }
        #[cfg(not(windows))]
        unsafe {
            libc::kill(ffmpeg_pid as i32, libc::SIGKILL);
            libc::kill(yt_dlp_pid as i32, libc::SIGKILL);
        }
    });

    // LETTORE DATI GREZZI (RAW) - VERSIONE AVANZATA
    let mut reader = BufReader::new(stdout);
    let mut buffer: Vec<f32> = Vec::with_capacity(8192);
    let mut _samples_read = 0;
    let mut total_samples = 0;
    let mut last_log_time = std::time::Instant::now();
    let stream_start = std::time::Instant::now();
    let mut cancelled = false;
    
    loop {
        // Controlla se il download è stato cancellato (deck rimpiazzato)
        if cancel.load(Ordering::Relaxed) {
            send_log("info", &format!("🛑 [Deck {}] Download cancellato, killing processi", deck_name));
            cancelled = true;
            break;
        }

        // Leggi 2 bytes (16 bit)
        match reader.read_i16::<LE>() {
            Ok(sample_i16) => {
                let sample_f32 = sample_i16 as f32 / 32768.0;
                buffer.push(sample_f32);
                _samples_read += 1;
                total_samples += 1;

                // Segnala al watchdog che i dati stanno arrivando
                if !first_data_arrived.load(Ordering::Relaxed) {
                    first_data_arrived.store(true, Ordering::Relaxed);
                    send_log("info", &format!("📦 [Deck {}] Primi dati audio ricevuti dopo {}ms",
                        deck_name, stream_start.elapsed().as_millis()));
                }

                // Invia a blocchi di ~20ms per reattività buffer_ready
                if buffer.len() >= 1920 { 
                    if tx.send(buffer.clone()).is_err() {
                        send_log("info", &format!("🛑 [Deck {}] Receiver chiuso, stopping download", deck_name));
                        cancelled = true;
                        break;
                    }
                    buffer.clear();
                    
                    if last_log_time.elapsed().as_secs() >= 1 {
                        _samples_read = 0;
                        last_log_time = std::time::Instant::now();
                    }
                }
            },
            Err(e) => {
                let stream_duration_ms = stream_start.elapsed().as_millis() as u64;
                let audio_seconds = total_samples / (SAMPLE_RATE * CHANNELS);
                
                if e.kind() == io::ErrorKind::UnexpectedEof {
                    // Fine canzone normale - invia buffer residuo
                    if !buffer.is_empty() {
                        let _ = tx.send(buffer.clone());
                    }
                    if total_samples == 0 {
                        send_log("error", &format!("❌ CRITICO: Scaricati 0 sample - yt-dlp o ffmpeg fallito!"));
                        send_log("error", &format!("Verifica: (1) yt-dlp è installato correttamente"));
                        send_log("error", &format!("Verifica: (2) L'URL YouTube è valido e accessibile"));
                    } else if audio_seconds < 10 {
                        // PREMATURA TERMINAZIONE - importante loggare
                        send_log("error", &format!("⚠️ FINE STREAM PREMATURA: solo {} secondi di audio dopo {}ms di streaming!", audio_seconds, stream_duration_ms));
                        send_log("error", &format!("Questo probabilmente indica che yt-dlp o ffmpeg sono falliti a metà stream (possibile problema codec Opus)"));
                    } else {
                        send_log("debug", &format!("Song finished ({} seconds, {} samples total)", audio_seconds, total_samples));
                    }
                } else {
                    // Vero errore di lettura (es. yt-dlp crashato o pipe rotta)
                    send_log("error", &format!("❌ ERRORE CRITICO Lettura: {} (letti {} campioni / {} sec totali)", e, total_samples, audio_seconds));
                    send_log("error", &format!("Ciò significa che la pipe di yt-dlp/ffmpeg è rotta o è crashata"));
                    // Se è un broken pipe error, potrebbe essere dovuto a problemi con i processi
                    if total_samples > 0 {
                        send_log("debug", "Attempted to continue playback with partial audio loaded");
                    }
                }
                break;
            }
        }
    }
    
    // Se cancellato, killa immediatamente i processi per liberare risorse e
    // evitare che download concorrenti dello stesso URL si blocchino a vicenda
    if cancelled {
        let _ = ffmpeg_child.kill();
        let _ = yt_dlp_child.kill();
    } else {
        // Invia ultimi dati rimasti solo se NON cancellato
        if !buffer.is_empty() {
            let _ = tx.send(buffer.clone());
        }
    }
    
    // Attendi che i processi terminino (dopo kill sono immediati)
    let _ = ffmpeg_child.wait();
    let _ = yt_dlp_child.wait();
    
    Ok(())
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
    let mut proactive_crossfade_enabled = true; // 🔥 Controlla se il crossfade proattivo è abilitato
    let mut loop_mode = false; // 🔁 Loop mode: fine canzone → riavvia stesso deck da full_samples
    let mut buffer_monitor_counter = 0;
    let mut is_playing = false; // NUOVO: traccia se stiamo effettivamente riproducendo
    
    // Flags per evitare spam di buffer_ready (edge detection)
    let mut buffer_prev_ready_a = false;
    let mut buffer_prev_ready_b = false;
    // Flag per evitare spam di end events
    let mut end_sent_a = false;
    let mut end_sent_b = false;
    // Flag per evitare spam di approaching_end events
    let mut approaching_end_sent_a = false;
    let mut approaching_end_sent_b = false;

    // Pending transition: quando il deck target non è ancora pronto,
    // continua a riprodurre il deck corrente e switcha quando i dati arrivano
    // (target_deck_name, since, is_crossfade, crossfade_duration_ms)
    let mut pending_transition: Option<(String, std::time::Instant, bool, u64)> = None;
    const PENDING_TIMEOUT_SECS: u64 = 8;

    // Auto-gapless stall: quando il deck attivo finisce e l'altro deck ha un download
    // in corso ma nessun sample ancora, stiamo in stallo (silenzio) finché non arrivano.
    // (target_deck_name, stall_start_instant)
    let mut auto_gapless_stall: Option<(String, std::time::Instant)> = None;
    const AUTO_GAPLESS_STALL_TIMEOUT_SECS: u64 = 10;

    // Mid-chunk auto-switch: traccia se uno switch auto-gapless è avvenuto DENTRO il chunk loop
    // Se Some(deck_name), significa che abbiamo switchato a quel deck dentro il chunk
    // Dopo il chunk, invieremo gli eventi appropriati
    #[allow(unused_assignments)]
    let mut mid_chunk_auto_switch: Option<String> = None;
    #[allow(unused_assignments)]
    let mut mid_chunk_loop_restart = false; // true se il loop restart è avvenuto mid-chunk

    let stdout = io::stdout();
    let mut handle = stdout.lock();

    send_log("info", "Rust Mixer Ready");

    let mut last_status_log = std::time::Instant::now();

    loop {
        // Gestione Comandi Node -> Rust
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                InputCommand::Load { url, deck, autoplay } => {
                    // Se stiamo caricando sul deck SORGENTE di un crossfade attivo,
                    // completa il crossfade istantaneamente prima di sovrascrivere
                    if crossfading && deck == active_deck {
                        send_log("info", &format!("Load su deck sorgente durante crossfade → snap to {}", target_deck));
                        crossfading = false;
                        proactive_crossfade_triggered = false;
                        crossfade_left = 0;
                        crossfade_total = 0;
                        active_deck = target_deck.clone();
                        if target_deck == "A" { deck_a.samples_played = 0; }
                        else if target_deck == "B" { deck_b.samples_played = 0; }
                        send_log("deck_changed", &format!("deck={}, triggered_by=crossfade_snap", active_deck));
                    }

                    if deck == "A" { 
                        deck_a.load(url);
                        buffer_prev_ready_a = false;
                        end_sent_a = false;
                        approaching_end_sent_a = false;
                        send_log("info", &format!("{} on deck A", if autoplay { "Load" } else { "Preload" }));
                    } else if deck == "B" { 
                        deck_b.load(url);
                        buffer_prev_ready_b = false;
                        end_sent_b = false;
                        approaching_end_sent_b = false;
                        send_log("info", &format!("{} on deck B", if autoplay { "Load" } else { "Preload" }));
                    }
                },
                InputCommand::Play { deck } => { 
                    active_deck = deck.clone(); 
                    crossfading = false; 
                    proactive_crossfade_triggered = false;
                    is_playing = true;
                    auto_gapless_stall = None;
                    if deck == "A" { deck_a.samples_played = 0; }
                    else if deck == "B" { deck_b.samples_played = 0; }
                    send_log("info", &format!("Play deck {}", deck));
                    send_log("deck_changed", &format!("deck={}, triggered_by=play_command", deck));
                },
                InputCommand::StopDeck { deck } => {
                    auto_gapless_stall = None;
                    send_log("debug", &format!("Stopping deck {}", deck));
                    
                    // Reset COMPLETO del deck come se fosse nuovo
                    if deck == "A" {
                        deck_a = Deck::new("A");
                        buffer_prev_ready_a = false;
                        end_sent_a = false;
                        approaching_end_sent_a = false;
                    } else if deck == "B" {
                        deck_b = Deck::new("B");
                        buffer_prev_ready_b = false;
                        end_sent_b = false;
                        approaching_end_sent_b = false;
                    }
                    
                    if deck == active_deck {
                        is_playing = false;
                        send_log("info", &format!("Playback stopped on deck {}", deck));
                    }
                },
                InputCommand::Crossfade { duration_ms, to_deck } => {
                    auto_gapless_stall = None;
                    if to_deck != active_deck && !crossfading {
                        // Aggiorna il buffer del deck target
                        if to_deck == "A" { deck_a.poll_receiver(); } 
                        else if to_deck == "B" { deck_b.poll_receiver(); }
                        
                        let target_ready = if to_deck == "A" { deck_a.is_ready_for_crossfade() }
                                          else { deck_b.is_ready_for_crossfade() };
                        let download_done = if to_deck == "A" { deck_a.receiver.is_none() && deck_a.samples.len() > 0 }
                                           else { deck_b.receiver.is_none() && deck_b.samples.len() > 0 };
                        
                        if target_ready || download_done {
                            // Target pronto → crossfade immediato
                            crossfading = true;
                            target_deck = to_deck;
                            crossfade_total = (duration_ms as usize * SAMPLE_RATE / 1000) * CHANNELS;
                            crossfade_left = crossfade_total;
                            pending_transition = None;
                            send_log("crossfade_started", &format!("from={}, to={}", active_deck, target_deck));
                        } else {
                            // Target non pronto → pending crossfade (continua a riprodurre deck corrente)
                            pending_transition = Some((to_deck, std::time::Instant::now(), true, duration_ms));
                            send_log("info", &format!("⏳ Crossfade pending: deck target non pronto"));
                        }
                    }
                },
                InputCommand::SetProactiveCrossfade { enabled } => {
                    proactive_crossfade_enabled = enabled;
                    send_log("info", &format!("Proactive crossfade: {}", if enabled { "enabled" } else { "disabled" }));
                },
                InputCommand::SetLoop { enabled } => {
                    loop_mode = enabled;
                    send_log("info", &format!("Loop mode: {}", if enabled { "enabled" } else { "disabled" }));
                },
                InputCommand::SkipTo { target_deck } => {
                    auto_gapless_stall = None;
                    if target_deck != active_deck && target_deck != "C" {
                        send_log("info", &format!("Skip: {} -> {}", active_deck, target_deck));
                        
                        // Aggiorna il buffer del deck target
                        let target_is_ready = if target_deck == "A" {
                            deck_a.poll_receiver();
                            deck_a.is_ready_for_crossfade()
                        } else if target_deck == "B" {
                            deck_b.poll_receiver();
                            deck_b.is_ready_for_crossfade()
                        } else { false };
                        
                        // Download completato (anche se pochi sample)?
                        let download_done = if target_deck == "A" { deck_a.receiver.is_none() && deck_a.samples.len() > 0 }
                                           else { deck_b.receiver.is_none() && deck_b.samples.len() > 0 };
                        
                        if target_is_ready || download_done {
                            // ✅ IMMEDIATE SWITCH: deck target pronto
                            send_log("buffer_ready", target_deck.as_str());
                            
                            if active_deck == "A" {
                                deck_a = Deck::new("A");
                                buffer_prev_ready_a = false;
                                end_sent_a = false;
                                approaching_end_sent_a = false;
                            } else if active_deck == "B" {
                                deck_b = Deck::new("B");
                                buffer_prev_ready_b = false;
                                end_sent_b = false;
                                approaching_end_sent_b = false;
                            }
                            
                            active_deck = target_deck.clone();
                            crossfading = false;
                            proactive_crossfade_triggered = false;
                            crossfade_left = 0;
                            crossfade_total = 0;
                            is_playing = true;
                            pending_transition = None;
                            
                            if target_deck == "A" { deck_a.samples_played = 0; }
                            else if target_deck == "B" { deck_b.samples_played = 0; }
                            
                            send_log("info", &format!("⚡ Skip immediato → deck {}", target_deck));
                            send_log("deck_changed", &format!("deck={}, triggered_by=skip_command", target_deck));
                        } else {
                            // ⏳ PENDING SKIP: deck target non pronto, continua a riprodurre deck corrente
                            pending_transition = Some((target_deck.clone(), std::time::Instant::now(), false, 0));
                            send_log("info", &format!("⏳ Skip pending: deck {} non pronto, continuo riproduzione corrente", target_deck));
                        }
                    }
                },
                InputCommand::ApproveProposal { new_deck } => {
                    // 🤝 NUOVO: Approva la proposta di cambio deck e fa il crossfade
                    if new_deck != active_deck && new_deck != "C" && proactive_crossfade_triggered {
                        send_log("info", &format!("Approved deck proposal: {} -> {}", active_deck, new_deck));
                        
                        // Inizia il crossfade verso il deck proposto
                        crossfading = true;
                        target_deck = new_deck.clone();
                        crossfade_total = SAMPLE_RATE * CHANNELS * 6; // 6 secondi di crossfade
                        crossfade_left = crossfade_total;
                        proactive_crossfade_triggered = false;
                        
                        send_log("info", "Starting crossfade from approved proposal");
                    }
                },
                InputCommand::PauseAll => {
                    is_playing = false;
                    send_log("info", "Paused all playback");
                },
                InputCommand::ResumeAll => {
                    is_playing = true;
                    send_log("info", "Resumed all playback");
                },
                InputCommand::RestartDeck { deck } => {
                    send_log("info", &format!("Restarting deck {} for replay ({} samples available)", deck,
                        if deck == "A" { deck_a.full_samples.len() }
                        else { deck_b.full_samples.len() }
                    ));
                    if deck == "A" {
                        deck_a.restart();
                        buffer_prev_ready_a = false;
                        end_sent_a = false;
                        approaching_end_sent_a = false;
                    } else if deck == "B" {
                        deck_b.restart();
                        buffer_prev_ready_b = false;
                        end_sent_b = false;
                        approaching_end_sent_b = false;
                    }
                    send_log("deck_restarted", &format!("deck={}", deck));
                },
                InputCommand::Stop => std::process::exit(0),
            }
        }

        // Aggiorna i buffer di TUTTI i deck, anche quelli inattivi
        deck_a.poll_receiver();
        deck_b.poll_receiver();

        // ── Auto-gapless stall check ─────────────────────────────
        // Se siamo in stallo aspettando che l'altro deck riceva i primi dati,
        // controlla se ora ha audio. Se sì, fai lo switch.
        if let Some((ref stall_target, stall_since)) = auto_gapless_stall.clone() {
            // Poll il deck target per ricevere dati freschi
            if stall_target == "A" { deck_a.poll_receiver(); }
            else { deck_b.poll_receiver(); }
            
            let target_has_audio = if stall_target == "A" { deck_a.samples.len() > 0 } else { deck_b.samples.len() > 0 };
            let timed_out = stall_since.elapsed() >= std::time::Duration::from_secs(AUTO_GAPLESS_STALL_TIMEOUT_SECS);
            
            if target_has_audio {
                // Dati arrivati! Auto-switch gapless
                send_log("info", &format!("⚡ Auto-gapless stall risolto dopo {}ms → deck {}",
                    stall_since.elapsed().as_millis(), stall_target));
                
                // Pulisci il deck vecchio
                if active_deck == "A" {
                    deck_a = Deck::new("A");
                    buffer_prev_ready_a = false;
                    approaching_end_sent_a = false;
                } else {
                    deck_b = Deck::new("B");
                    buffer_prev_ready_b = false;
                    approaching_end_sent_b = false;
                }
                
                let new_deck = stall_target.clone();
                active_deck = new_deck.clone();
                if new_deck == "A" { deck_a.samples_played = 0; }
                else { deck_b.samples_played = 0; }
                
                send_log("auto_end_switch", &new_deck);
                send_log("deck_changed", &format!("deck={}, triggered_by=auto_gapless_stall", new_deck));
                auto_gapless_stall = None;
            } else if timed_out {
                // Timeout: il deck target non ha mai ricevuto dati
                send_log("info", &format!("⏰ Auto-gapless stall timeout ({}s) → fallback end", AUTO_GAPLESS_STALL_TIMEOUT_SECS));
                send_log("end", &active_deck);
                auto_gapless_stall = None;
            }
            // Se né dati né timeout, continua in stallo (output silenzio)
        }

        // ── Pending transition check ──────────────────────────────
        // Se c'è una transizione in attesa (skip o crossfade), controlla se il deck
        // target è ora pronto. Se sì, esegui la transizione. Se timeout, esegui comunque.
        {
            let mut execute_target: Option<(String, bool, u64)> = None; // (deck, is_crossfade, duration_ms)
            if let Some((ref ptarget, since, is_cf, cf_dur)) = pending_transition {
                let ready = if ptarget == "A" { deck_a.is_ready_for_crossfade() }
                           else { deck_b.is_ready_for_crossfade() };
                let rx_done = if ptarget == "A" { deck_a.receiver.is_none() && deck_a.samples.len() > 0 }
                             else { deck_b.receiver.is_none() && deck_b.samples.len() > 0 };
                let timed_out = since.elapsed() >= std::time::Duration::from_secs(PENDING_TIMEOUT_SECS);
                
                if ready || rx_done || timed_out {
                    send_log("info", &format!("✅ Pending {} eseguito dopo {}ms (ready={}, done={}, timeout={})",
                        if is_cf { "crossfade" } else { "skip" },
                        since.elapsed().as_millis(), ready, rx_done, timed_out));
                    execute_target = Some((ptarget.clone(), is_cf, cf_dur));
                }
            }
            
            if let Some((ref etarget, is_cf, cf_dur_ms)) = execute_target {
                if is_cf {
                    // Crossfade: NON pulire il deck vecchio — serve per il mix!
                    // Il crossfade completion nel mixing loop pulirà il deck sorgente.
                    crossfading = true;
                    target_deck = etarget.clone();
                    crossfade_total = (cf_dur_ms as usize * SAMPLE_RATE / 1000) * CHANNELS;
                    crossfade_left = crossfade_total;
                    proactive_crossfade_triggered = false;
                    send_log("crossfade_started", &format!("from={}, to={}", active_deck, etarget));
                } else {
                    // Skip istantaneo: pulisci il deck vecchio
                    if active_deck == "A" {
                        deck_a = Deck::new("A");
                        buffer_prev_ready_a = false;
                        end_sent_a = false;
                        approaching_end_sent_a = false;
                    } else if active_deck == "B" {
                        deck_b = Deck::new("B");
                        buffer_prev_ready_b = false;
                        end_sent_b = false;
                        approaching_end_sent_b = false;
                    }
                    
                    active_deck = etarget.clone();
                    crossfading = false;
                    proactive_crossfade_triggered = false;
                    crossfade_left = 0;
                    crossfade_total = 0;
                    is_playing = true;
                    
                    if etarget == "A" { deck_a.samples_played = 0; }
                    else if etarget == "B" { deck_b.samples_played = 0; }
                    
                    send_log("info", &format!("⚡ Skip completato → deck {}", etarget));
                    send_log("deck_changed", &format!("deck={}, triggered_by=pending_skip", etarget));
                }
                
                pending_transition = None;
                send_log("buffer_ready", etarget.as_str());
            }
        }

        // Monitoraggio buffer (edge detection per buffer_ready)
        buffer_monitor_counter += 1;
        if buffer_monitor_counter >= 5 {
            buffer_monitor_counter = 0;
            
            let b_ready = deck_b.is_ready_for_crossfade();
            let a_ready = deck_a.is_ready_for_crossfade();

            if (active_deck == "A" || active_deck == "C") && b_ready && !buffer_prev_ready_b {
                send_log("buffer_ready", "B");
            }
            buffer_prev_ready_b = b_ready;

            if (active_deck == "B" || active_deck == "C") && a_ready && !buffer_prev_ready_a {
                send_log("buffer_ready", "A");
            }
            buffer_prev_ready_a = a_ready;
        }

        // MODIFICA CRITICA: Non generare output se non stiamo riproducendo
        if !is_playing {
            // Sleep per non consumare CPU inutilmente
            std::thread::sleep(std::time::Duration::from_millis(20));
            continue;
        }
        
        // Se siamo in stallo per auto-gapless, output silenzio senza consumare sample
        if auto_gapless_stall.is_some() {
            for _ in 0..CHUNK_SIZE {
                let _ = handle.write_i16::<LE>(0i16);
            }
            handle.flush().ok();
            continue;
        }
        
        // 🔥 CROSSFADE AUTOMATICO: 3 secondi prima della fine della canzone
        // Se il fade è attivo e il deck target è pronto, avvia il crossfade DIRETTAMENTE
        // Se il fade è disattivato, non fare nulla (il deck finirà e manderà end event)
        if !crossfading && !proactive_crossfade_triggered && is_playing && proactive_crossfade_enabled {
            let current_buffer_len = if active_deck == "A" { deck_a.samples.len() } else { deck_b.samples.len() };
            let target_deck_obj = if active_deck == "A" { &deck_b } else { &deck_a };
            let target_deck_name = if active_deck == "A" { "B" } else { "A" };
            let target_ready = target_deck_obj.is_ready_for_crossfade();
            // 3 secondi prima della fine = 288000 samples stereo a 48kHz
            let threshold = SAMPLE_RATE * CHANNELS * 3;

            if current_buffer_len < threshold && target_ready {
                // Avvia crossfade DIRETTAMENTE (nessun handshake con Node.js)
                send_log("info", &format!("Auto-crossfade: {} -> {} (buffer: {} samples, <3s remaining)",
                    active_deck, target_deck_name, current_buffer_len));
                
                crossfading = true;
                target_deck = target_deck_name.to_string();
                // Crossfade di 6 secondi (3s overlap fine canzone + 3s inizio prossima)
                crossfade_total = SAMPLE_RATE * CHANNELS * 6;
                crossfade_left = crossfade_total;
                proactive_crossfade_triggered = true;
                
                // Notifica Node.js che il crossfade è iniziato
                send_log("crossfade_started", &format!("from={}, to={}", active_deck, target_deck_name));
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // COSTANTI PER AUTO-GAPLESS E MID-CHUNK
        // ═══════════════════════════════════════════════════════════════════
        const MIN_SAMPLES_PLAYED_FOR_END: usize = SAMPLE_RATE * CHANNELS * 25; // 25 secondi

        // Mixing Loop
        let mut has_audio = false;
        mid_chunk_auto_switch = None; // Reset per questo chunk
        mid_chunk_loop_restart = false;
        
        for _ in 0..CHUNK_SIZE {
            let out = if crossfading {
                // PRIMA controlla se il deck target ha audio PRIMA di consumare sample
                let target_has_audio = if target_deck == "A" { deck_a.samples.len() > 0 } else { deck_b.samples.len() > 0 };
                
                if !target_has_audio {
                    // Il deck target non ha ancora audio: NON avanzare il crossfade.
                    // Riproduci solo il deck sorgente a volume pieno per evitare silenzi.
                    // Consuma SOLO dal deck sorgente (non dal target che è vuoto)
                    let source = if active_deck == "A" { 
                        deck_a.get_next_sample().unwrap_or(0.0) 
                    } else { 
                        deck_b.get_next_sample().unwrap_or(0.0) 
                    };
                    source
                } else {
                    // Entrambi i deck hanno audio → consuma da entrambi per il crossfade
                    let s_a = deck_a.get_next_sample().unwrap_or(0.0);
                    let s_b = deck_b.get_next_sample().unwrap_or(0.0);
                    
                    let ratio = (crossfade_total as f32 - crossfade_left as f32) / crossfade_total as f32;
                    crossfade_left = crossfade_left.saturating_sub(1);
                    
                    let final_ratio = if crossfade_left == 0 { 1.0 } else { ratio };
                    
                    if crossfade_left == 0 { 
                        crossfading = false; 
                        proactive_crossfade_triggered = false;
                        
                        // NON cancellare il deck sorgente: potrebbe avere dati precaricati
                        // per la prossima transizione. Il metodo load() pulirà quando necessario.
                        // Reset solo i flag di edge-detection.
                        if active_deck == "A" {
                            buffer_prev_ready_a = false;
                            end_sent_a = false;
                            approaching_end_sent_a = false;
                        } else if active_deck == "B" {
                            buffer_prev_ready_b = false;
                            end_sent_b = false;
                            approaching_end_sent_b = false;
                        }
                        
                        if target_deck == "A" {
                            deck_a.samples_played = 0;
                        } else if target_deck == "B" {
                            deck_b.samples_played = 0;
                        }
                        
                        active_deck = target_deck.clone(); 
                        send_log("info", &format!("Crossfade completed, switched to {}", active_deck));
                        send_log("deck_changed", &format!("deck={}, triggered_by=crossfade_completion", active_deck));
                    }

                    let source_sample = if active_deck == "A" { s_a } else { s_b };
                    let target_sample = if target_deck == "A" { s_a } else { s_b };
                    
                    source_sample * (1.0 - final_ratio) + target_sample * final_ratio
                }
            } else {
                // Nessun crossfade - output diretto dal deck attivo
                // 🔥 CRITICO: Implementa mid-chunk auto-gapless per eliminare silenzi
                // Se il deck attivo è esaurito (samples.len() == 0 e has_ended), 
                // prova a switchare all'altro deck o reiniziare il loop MID-CHUNK
                let sample = if active_deck == "A" { 
                    deck_a.get_next_sample() 
                } else { 
                    deck_b.get_next_sample() 
                };
                
                match sample {
                    Some(s) => s,
                    None => {
                        // Active deck è esaurito
                        let should_try_switch = !crossfading && pending_transition.is_none() && 
                                               auto_gapless_stall.is_none() && is_playing;
                        
                        let (is_exhausted, played_enough) = if active_deck == "A" {
                            (deck_a.has_ended && deck_a.receiver.is_none(), 
                             deck_a.samples_played >= MIN_SAMPLES_PLAYED_FOR_END)
                        } else {
                            (deck_b.has_ended && deck_b.receiver.is_none(), 
                             deck_b.samples_played >= MIN_SAMPLES_PLAYED_FOR_END)
                        };
                        
                        if should_try_switch && is_exhausted && played_enough && mid_chunk_auto_switch.is_none() {
                            // Deck attivo è finito e ha riprodotto abbastanza
                            if loop_mode {
                                // ── MID-CHUNK LOOP RESTART ──
                                // Riavvia lo stesso deck da full_samples
                                if active_deck == "A" {
                                    deck_a.restart();
                                    approaching_end_sent_a = false;
                                } else {
                                    deck_b.restart();
                                    approaching_end_sent_b = false;
                                }
                                mid_chunk_loop_restart = true;
                                
                                // Prendi il primo sample dal deck riavviato
                                if active_deck == "A" { deck_a.get_next_sample().unwrap_or(0.0) }
                                else { deck_b.get_next_sample().unwrap_or(0.0) }
                            } else {
                                // ── MID-CHUNK AUTO-SWITCH ──
                                // Prova a switchare all'altro deck che ha dati precaricati
                                let other = if active_deck == "A" { "B" } else { "A" };
                                let other_has_audio = if other == "A" { 
                                    deck_a.samples.len() > 0 
                                } else { 
                                    deck_b.samples.len() > 0 
                                };
                                
                                if other_has_audio {
                                    // L'altro deck ha audio → switchare MID-CHUNK
                                    // Pulisci il vecchio deck
                                    if active_deck == "A" {
                                        deck_a = Deck::new("A");
                                        buffer_prev_ready_a = false;
                                        approaching_end_sent_a = false;
                                    } else {
                                        deck_b = Deck::new("B");
                                        buffer_prev_ready_b = false;
                                        approaching_end_sent_b = false;
                                    }
                                    
                                    // Aggiorna active deck
                                    active_deck = other.to_string();
                                    if other == "A" { deck_a.samples_played = 0; }
                                    else { deck_b.samples_played = 0; }
                                    
                                    mid_chunk_auto_switch = Some(other.to_string());
                                    
                                    // Prendi il primo sample dal nuovo deck
                                    if active_deck == "A" { deck_a.get_next_sample().unwrap_or(0.0) }
                                    else { deck_b.get_next_sample().unwrap_or(0.0) }
                                } else {
                                    // Nessun audio disponibile
                                    0.0
                                }
                            }
                        } else {
                            // Non possiamo switchare - output silenzio
                            0.0
                        }
                    }
                }
            };

            // Traccia se c'è effettivamente audio
            if out.abs() > 0.0001 {
                has_audio = true;
            }

            // Clipping e Output PCM i16
            let _ = handle.write_i16::<LE>((out.max(-1.0).min(1.0) * 32767.0) as i16);
        }
        handle.flush().ok();
        
        // Evento approaching_end: 3 secondi prima della fine
        // Inviato quando il decoder ha finito (has_ended=true) e rimangono <3 sec di sample
        const APPROACHING_END_THRESHOLD: usize = SAMPLE_RATE * CHANNELS * 3; // 3 secondi
        
        if is_playing && !crossfading {
            // Deck A
            if active_deck == "A" && deck_a.has_ended && deck_a.receiver.is_none() {
                if !approaching_end_sent_a && deck_a.samples.len() < APPROACHING_END_THRESHOLD {
                    send_log("approaching_end", "A");
                    approaching_end_sent_a = true;
                }
            }
            // Deck B
            if active_deck == "B" && deck_b.has_ended && deck_b.receiver.is_none() {
                if !approaching_end_sent_b && deck_b.samples.len() < APPROACHING_END_THRESHOLD {
                    send_log("approaching_end", "B");
                    approaching_end_sent_b = true;
                }
            }
        }
        
        // ═══════════════════════════════════════════════════════════════
        // MID-CHUNK EVENTS: Se uno switch auto-gapless è avvenuto MID-CHUNK,
        // invia gli eventi appropriati e salta il post-chunk auto-gapless check
        // ═══════════════════════════════════════════════════════════════
        if mid_chunk_auto_switch.is_some() || mid_chunk_loop_restart {
            if mid_chunk_loop_restart {
                // Restart del loop mid-chunk
                send_log("auto_loop_restart", &active_deck);
                send_log("info", &format!("🔁 Mid-chunk auto-loop: deck {} riavviato da cache", active_deck));
            } else if let Some(ref new_deck) = mid_chunk_auto_switch {
                // Auto-switch mid-chunk
                send_log("auto_end_switch", new_deck);
                send_log("deck_changed", &format!("deck={}, triggered_by=mid_chunk_auto_gapless", new_deck));
                send_log("info", &format!("⚡ Mid-chunk auto-gapless: switch istantaneo → deck {}", new_deck));
            }
            // Reset per il prossimo chunk (assegnamenti consapevolmente morti per chiarezza)
            let _ = std::mem::take(&mut mid_chunk_auto_switch);
            let _ = std::mem::take(&mut mid_chunk_loop_restart);
            // ⚠️ SKIP post-chunk auto-gapless - la transizione è stata già gestita mid-chunk
        } else {
            // ═══════════════════════════════════════════════════════════════
            // AUTO-GAPLESS POST-CHUNK: Gestione fine canzone se non è stata
        // Tre casi:
        //  1. Loop ON  → riavvia deck corrente da full_samples (zero gap)
        //  2. Altro deck pronto → switch istantaneo (zero gap)
        //  3. Nessuno dei due → invia 'end' a Node.js (fallback)
        // ═══════════════════════════════════════════════════════════════
        
        if !has_audio && !crossfading && is_playing && pending_transition.is_none() && auto_gapless_stall.is_none() {
            let should_handle_end = if active_deck == "A" {
                deck_a.has_ended && deck_a.receiver.is_none() &&
                deck_a.samples_played >= MIN_SAMPLES_PLAYED_FOR_END && !end_sent_a
            } else {
                deck_b.has_ended && deck_b.receiver.is_none() &&
                deck_b.samples_played >= MIN_SAMPLES_PLAYED_FOR_END && !end_sent_b
            };
            
            if should_handle_end {
                // Segna come gestito per evitare ri-trigger
                if active_deck == "A" { end_sent_a = true; }
                else { end_sent_b = true; }
                
                if loop_mode {
                    // ── CASO 1: LOOP → riavvia deck corrente da cache ──
                    if active_deck == "A" {
                        deck_a.restart();
                        approaching_end_sent_a = false;
                        end_sent_a = false; // Permetti ri-rilevazione dopo restart
                    } else {
                        deck_b.restart();
                        approaching_end_sent_b = false;
                        end_sent_b = false;
                    }
                    send_log("auto_loop_restart", &active_deck);
                    send_log("info", &format!("🔁 Auto-loop: deck {} riavviato da cache", active_deck));
                } else {
                    // Controlla se l'altro deck ha audio pronto
                    let other = if active_deck == "A" { "B" } else { "A" };
                    let other_samples = if other == "A" { deck_a.samples.len() } else { deck_b.samples.len() };
                    let other_has_receiver = if other == "A" { deck_a.receiver.is_some() } else { deck_b.receiver.is_some() };
                    let other_has_ended = if other == "A" { deck_a.has_ended } else { deck_b.has_ended };
                    let other_full = if other == "A" { deck_a.full_samples.len() } else { deck_b.full_samples.len() };
                    
                    send_log("info", &format!("🔍 Auto-gapless check: other deck {} → samples={}, receiver={}, has_ended={}, full_samples={}",
                        other, other_samples, other_has_receiver, other_has_ended, other_full));
                    
                    let other_has_audio = other_samples > 0;
                    
                    if other_has_audio {
                        // ── CASO 2: AUTO-SWITCH → transizione gapless istantanea ──
                        // Pulisci il deck vecchio (i dati sono consumati)
                        if active_deck == "A" {
                            deck_a = Deck::new("A");
                            buffer_prev_ready_a = false;
                            approaching_end_sent_a = false;
                        } else {
                            deck_b = Deck::new("B");
                            buffer_prev_ready_b = false;
                            approaching_end_sent_b = false;
                        }
                        
                        // Switcha al nuovo deck
                        active_deck = other.to_string();
                        if other == "A" { deck_a.samples_played = 0; }
                        else { deck_b.samples_played = 0; }
                        
                        send_log("auto_end_switch", other);
                        send_log("deck_changed", &format!("deck={}, triggered_by=auto_gapless", other));
                        send_log("info", &format!("⚡ Auto-gapless: switch istantaneo → deck {}", other));
                    } else {
                        // L'altro deck non ha audio. Verifica se ha un download in corso.
                        let other_has_receiver = if other == "A" { deck_a.receiver.is_some() } else { deck_b.receiver.is_some() };
                        // Verifica se è stato caricato (ha full_samples o un receiver)
                        let other_was_loaded = other_has_receiver || 
                            (if other == "A" { deck_a.full_samples.len() > 0 } else { deck_b.full_samples.len() > 0 });
                        
                        if other_has_receiver {
                            // Verifica se il download è bloccato (>30s senza dati)
                            let load_age = if other == "A" { deck_a.load_started_at } else { deck_b.load_started_at };
                            let download_stuck = match load_age {
                                Some(t) => t.elapsed() >= std::time::Duration::from_secs(30),
                                None => false, // load_started_at è None solo se i dati sono già arrivati
                            };
                            
                            if download_stuck {
                                // ── CASO 3a-stuck: Download bloccato, non stallare ──
                                send_log("error", &format!("⏰ Auto-gapless: deck {} in download da >30s senza dati → fallback end", other));
                                send_log("end", &active_deck);
                            } else {
                                // ── CASO 3a: STALL → download in corso, aspetta dati ──
                                send_log("info", &format!("⏸️  Auto-gapless stall: deck {} in download ({}ms), aspetto primi dati...",
                                    other, load_age.map(|t| t.elapsed().as_millis()).unwrap_or(0)));
                                auto_gapless_stall = Some((other.to_string(), std::time::Instant::now()));
                            }
                        } else if other_was_loaded {
                            // ── CASO 3b: Deck caricato ma vuoto (ha full_samples ma samples esaurito?) ──
                            // Questo non dovrebbe succedere, ma gestiscilo come fallback
                            send_log("end", &active_deck);
                            send_log("debug", &format!("Deck {} ended (other deck {} loaded but empty, full_samples={})",
                                active_deck, other,
                                if other == "A" { deck_a.full_samples.len() } else { deck_b.full_samples.len() }));
                        } else {
                            // ── CASO 3c: FALLBACK → nessun deck caricato, fine coda ──
                            send_log("end", &active_deck);
                            send_log("debug", &format!("Deck {} ended (no next song preloaded)", active_deck));
                        }
                    }
                }
            }
        }
        } // Fine else block (post-chunk auto-gapless skip)
        
        // Log di stato ogni 30 secondi (ridotto per meno spam)
        if last_status_log.elapsed().as_secs() >= 30 {
            send_log("debug", &format!("Status - Active: {}, A: {}s played, B: {}s played, pending: {}", 
                active_deck, 
                deck_a.samples_played / (SAMPLE_RATE * CHANNELS),
                deck_b.samples_played / (SAMPLE_RATE * CHANNELS),
                pending_transition.is_some()));
            last_status_log = std::time::Instant::now();
        }
    }
}

#[tokio::main]
async fn main() {
    // Evita che il processo Rust termini su SIGPIPE quando Node chiude la pipe
    // (solo Unix - Windows non ha SIGPIPE)
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let (tx, rx) = bounded::<InputCommand>(10);
    
    // Thread audio (Priority)
    thread::spawn(move || mixer_loop(rx));

    // Thread input JSON (Node -> Rust)
    let stdin = io::stdin();
    let iterator = serde_json::Deserializer::from_reader(stdin).into_iter::<InputCommand>();
    for item in iterator {
        if let Ok(cmd) = item { let _ = tx.send(cmd); }
    }
}
