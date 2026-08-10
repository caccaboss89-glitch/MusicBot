/**
 * Controller for Rust audio mixer (sidecar integration)
 */

import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import { ROOT_DIR, RUST_ENGINE_PATH, resolveYtDlpProxyUrl, resolveYtDlpCookieBrowser, resolveYtDlpExtractorArgs } from '../../config/index.js';
import { CROSSFADE_DURATION_MS, RESTART_COOLDOWN_MS } from '../../config/index.js';
import { getNextMixerGeneration } from '../state/globals.js';

/**
 * Controller for Rust audio mixer process
 * Manages bidirectional communication via stdin/stdout
 */
class AudioMixerController {
  constructor(guildId, onLog, onBufferReady, onCrash = null) {
    this.guildId = guildId;
    this.process = null;
    this.onLog = onLog;
    this.onBufferReady = onBufferReady;
    this.onCrash = onCrash; // Callback for automatic recovery after crash
    this.isAlive = false;
    this.lastRestartTime = 0;
    this.stdoutClosed = false;
    this.stderrReadline = null;
    this.hasCrashed = false;
    this.generation = getNextMixerGeneration(); // Unique ID for this mixer
    this.logStream = null;
  }

  start() {
    // If process exists but is dead, clean it before restart
    if (this.process && !this.isAlive) {
      console.log('🧹 [RUST] Cleaning dead process before restart');
      try { this.process.kill(); } catch { /* process already exited */ }
      this.process = null;
    }

    if (this.process) return;

    // Prevent restart spam (minimum 5 seconds between starts)
    const now = Date.now();
    if (now - this.lastRestartTime < RESTART_COOLDOWN_MS) {
      const waitTime = RESTART_COOLDOWN_MS - (now - this.lastRestartTime);
      console.warn(`⚠️ [RUST] Cooldown active, wait ${(waitTime / 1000).toFixed(1)}s before next restart`);
      return;
    }
    this.lastRestartTime = now;

    // Minimal startup logging
    console.info(`🦀 [RUST] Starting audio engine for ${this.guildId}`);

    // Pass DISCORD_BOT_PATH and yt-dlp config to Rust process (same defaults as config/paths.js)
    const proxyUrl = resolveYtDlpProxyUrl();
    const cookieBrowser = resolveYtDlpCookieBrowser();
    const extractorArgs = resolveYtDlpExtractorArgs();
    const env = {
      ...process.env,
      PATH: `${process.env.PATH}${path.delimiter}${ROOT_DIR}`,
      DISCORD_BOT_PATH: ROOT_DIR,
      YTDLP_PROXY_URL: proxyUrl || 'none',
      YTDLP_COOKIE_BROWSER: cookieBrowser || 'none',
      YTDLP_EXTRACTOR_ARGS: extractorArgs
    };

    try {
      this.process = spawn(RUST_ENGINE_PATH, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env
      });
    } catch (e) {
      console.error(`❌ [RUST] Unable to start process: ${e.message}`);
      this.isAlive = false;
      return;
    }

    this.isAlive = true;
    this.stdoutClosed = false;
    this.hasCrashed = false; // Reset to allow recovery on future crashes

    // Close previous resources before restarting
    if (this.logStream) {
      try { this.logStream.destroy(); } catch { /* stream already closed */ }
      this.logStream = null;
    }
    if (this.stderrReadline) {
      this.stderrReadline.close();
      this.stderrReadline = null;
    }

    const rl = readline.createInterface({ input: this.process.stderr });
    this.stderrReadline = rl;

    // Open mixer stderr log for guild once for diagnostics
    try {
      const logsDir = path.join(ROOT_DIR, 'temp');
      try { fs.mkdirSync(logsDir, { recursive: true }); } catch { /* directory may already exist */ }
      const logPath = path.join(logsDir, `mixer-${this.guildId}.log`);
      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
      this.logStream.write(`\n===== Mixer start ${new Date().toISOString()} generation=${this.generation} =====\n`);
    } catch (e) { console.error('Unable to open mixer log stream', e); }

    rl.on('line', (line) => {
      // CRITICAL: Ignore events if mixer is dead
      if (!this.isAlive || this.stdoutClosed) {
        return;
      }

      try {
        let log = null;
        try { log = JSON.parse(line); } catch { /* not a JSON line: Rust also writes plain text to stderr */ }
        if (!log) return;
        log._mixerGeneration = this.generation;

        // --- SPAM FILTER ---
        const dataStr = log.data || '';
        const isSpam = dataStr.includes('[FFMPEG]') ||
                    dataStr.includes('Broken pipe') ||
                    dataStr.includes('TextIOWrapper') ||
                    dataStr.includes('Buffering:') ||
                    dataStr.startsWith('Buffer ') ||
                    dataStr.startsWith('Mixer Status');

        if (!isSpam) {
          // Show in console only warnings and errors to avoid too noisy logs
          if (log.event === 'error' || log.event === 'stream_error') {
            console.error(`⚠️ [RUST-${log.event.toUpperCase()}] ${log.data}`);
          }
          // 🔥 SHOW LATENCY LOGS
          else if (log.event === 'latency' || log.event === 'info') {
            console.log(`ℹ️ [RUST] ${log.data}`);
          } else if (log.event === 'debug' && log.data.includes('Trimmed')) {
            console.log(`✂️ [RUST] ${log.data}`);
          }

          // Forward all non-spam events to `onLog` for processing (NO DUPLICATE CALLS!)
          if (this.onLog) this.onLog(log);
        }

        // Intercept buffer_ready event (edge detection already in Rust)
        if (log.event === 'buffer_ready') {
          const deck = log.data;
          console.log(`✅ [RUST] Buffer ready on Deck ${deck}`);
          try { if (this.onBufferReady) this.onBufferReady(deck); } catch (e) { console.error('Error in onBufferReady handler', e); }
        }

      } catch { /* one malformed line must not stop the reader */ }
    });

    // Handle stdout errors - CRITICAL: mark mixer as dead
    this.process.stdout.on('error', (e) => {
      console.error(`❌ [RUST] Stdout error (mixer dead): ${e && e.message ? e.message : String(e)}`);
      this.isAlive = false;
      this.stdoutClosed = true;
      if (this.process) {
        try { this.process.kill(); } catch { /* process already exited */ }
        this.process = null;
      }
      // Trigger crash callback for automatic recovery
      if (this.onCrash && !this.hasCrashed) {
        this.hasCrashed = true;
        console.log('🚨 [RUST] Starting crash recovery...');
        try { this.onCrash('stdout_error'); } catch (e) { console.error('Error in onCrash handler', e); }
      }
    });

    this.process.stdout.on('close', () => {
      console.warn('⚠️ [RUST] Stdout closed');
      this.stdoutClosed = true;
      this.isAlive = false;
      if (this.process) {
        try { this.process.kill(); } catch { /* process already exited */ }
        this.process = null;
      }
      try { if (this.logStream) { this.logStream.write(`${new Date().toISOString()} STDOUT_CLOSED\n`); this.logStream.end(); this.logStream = null; } } catch { /* diagnostics only */ }
    });

    this.process.stdin.on('error', (e) => {
      console.error(`❌ [RUST] Stdin error: ${e && e.message ? e.message : e}`);
      this.isAlive = false;
      if (this.process) {
        try { this.process.kill(); } catch { /* process already exited */ }
        this.process = null;
      }
    });

    this.process.on('close', (code) => {
      console.log(`🛑 [RUST] Terminated (Exit: ${code})`);
      this.process = null;
      this.isAlive = false;
      if (this.stderrReadline) {
        this.stderrReadline.close();
        this.stderrReadline = null;
      }
      try { if (this.logStream) { this.logStream.write(`${new Date().toISOString()} PROCESS_CLOSED code=${code}\n`); this.logStream.end(); this.logStream = null; } } catch { /* diagnostics only */ }
      if (this.onCrash && !this.hasCrashed) {
        this.hasCrashed = true;
        console.log(`🚨 [RUST] Triggering crash recovery from close (code=${code})...`);
        try { this.onCrash(`process_close_${code}`); } catch (e) { console.error('onCrash handler error', e); }
      }
    });

    this.process.on('error', (e) => {
      console.error(`❌ [RUST] Process error: ${e.message}`);
      this.process = null;
      this.isAlive = false;
      if (this.onCrash && !this.hasCrashed) {
        this.hasCrashed = true;
        console.log('🚨 [RUST] Triggering crash recovery from process error...');
        try { this.onCrash(`process_error_${e.message}`); } catch (e2) { console.error('onCrash handler error', e2); }
      }
    });
  }


  send(cmd) {
    if (!this.process || !this.isAlive) {
      console.warn('⚠️ [MIXER] Process not active, command ignored');
      return false;
    }
    try {
      this.process.stdin.write(JSON.stringify(cmd) + '\n');
      return true;
    } catch (e) {
      console.error('❌ [MIXER] Error sending command:', e.message);
      this.isAlive = false;
      return false;
    }
  }


  load(url, deck, autoplay = true) {
    this.send({ op: 'load', url, deck, autoplay });
  }
  play(deck) {
    this.send({ op: 'play', deck });
  }
  stopDeck(deck) {
    this.send({ op: 'stop_deck', deck });
  }
  crossfade(toDeck, durationMs = CROSSFADE_DURATION_MS) {
    this.send({ op: 'crossfade', to_deck: toDeck, duration_ms: durationMs });
  }

  skipTo(targetDeck) {
    this.send({ op: 'skip_to', target_deck: targetDeck });
  }

  restartDeck(deck) {
    this.send({ op: 'restart_deck', deck });
  }
  pause() { this.send({ op: 'pause_all' }); }
  setProactiveCrossfade(enabled) { this.send({ op: 'set_proactive_crossfade', enabled }); }
  setLoop(enabled) { this.send({ op: 'set_loop', enabled }); }

  getStdout() {
    if (!this.process || !this.isAlive) return null;
    return this.process.stdout;
  }

  kill() {
    // Prevent close handler from invoking onCrash: kill() is always intentional
    this.hasCrashed = true;
    // Close readline BEFORE killing the process
    if (this.stderrReadline) {
      this.stderrReadline.close();
      this.stderrReadline = null;
    }
    // Close logStream to avoid file descriptor leak
    if (this.logStream) {
      try { this.logStream.end(); } catch { /* stream already closed */ }
      this.logStream = null;
    }
    if (this.process) {
      try { this.process.kill(); } catch { /* process already exited */ }
      this.process = null;
    }
    this.isAlive = false;
    this.stdoutClosed = true;
  }

  isProcessAlive() { return this.isAlive && this.process !== null && !this.stdoutClosed; }
  needsRestart() { return !this.isAlive || this.stdoutClosed || this.process === null; }
}

export default AudioMixerController;
