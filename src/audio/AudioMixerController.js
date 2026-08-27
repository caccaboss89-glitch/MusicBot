/**
 * Controller for the Rust audio mixer (sidecar integration).
 *
 * Owns one mixer process per guild: spawns it, turns its stderr into events for
 * the caller, and exposes the command surface the audio layer drives it with.
 */

import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import { rotateIfNeeded, MAX_MIXER_LOG_BYTES } from '../utils/logfiles.js';
import {
  ROOT_DIR,
  RUST_ENGINE_PATH,
  PYTHON_BIN,
  CROSSFADE_DURATION_MS,
  resolveYtDlpProxyUrl,
  resolveYtDlpCookieBrowser,
  resolveYtDlpExtractorArgs,
  resolveYtDlpJsRuntime
} from '../../config/index.js';
import { getNextMixerGeneration } from '../state/globals.js';

// Events printed to the console. Everything else still reaches the event
// handler and the per-guild log file: console noise is a display concern and
// must never decide whether an event is delivered.
const CONSOLE_ERROR_EVENTS = new Set(['error', 'stream_error']);
const CONSOLE_INFO_EVENTS = new Set(['info']);

class AudioMixerController {
  /**
   * @param {string} guildId
   * @param {(log: {event: string, data?: string, _mixerGeneration: number}) => void} onLog - Receives every event
   * @param {(reason: string) => void} [onCrash] - Called once when the process dies unexpectedly
   */
  constructor(guildId, onLog, onCrash = null) {
    this.guildId = guildId;
    this.process = null;
    this.onLog = onLog;
    this.onCrash = onCrash; // Callback for automatic recovery after crash
    this.isAlive = false;
    this.stdoutClosed = false;
    this.stderrReadline = null;
    this.hasCrashed = false;
    this.generation = getNextMixerGeneration(); // Unique ID for this mixer
    this.logStream = null;
    this.logPath = null;
    // Bytes written to the current log file. The stream stays open for the
    // whole life of the process, so its size is tracked here rather than
    // stat()ed on every line.
    this.logBytes = 0;
  }

  start() {
    if (this.process) return;

    console.info(`🦀 [RUST] Starting audio engine for ${this.guildId}`);

    // Pass DISCORD_BOT_PATH, the interpreter and the yt-dlp config to the Rust
    // process, resolved here so both languages agree on them. The proxy has no
    // default: 'none' is sent unless YTDLP_PROXY_URL explicitly configures one.
    // PYTHON_BIN is resolved rather than merely inherited, so the engine runs
    // yt-dlp through the same interpreter as the metadata calls even when the
    // variable is unset.
    const proxyUrl = resolveYtDlpProxyUrl();
    const cookieBrowser = resolveYtDlpCookieBrowser();
    const env = {
      ...process.env,
      PATH: `${process.env.PATH}${path.delimiter}${ROOT_DIR}`,
      DISCORD_BOT_PATH: ROOT_DIR,
      PYTHON_BIN,
      YTDLP_PROXY_URL: proxyUrl || 'none',
      YTDLP_COOKIE_BROWSER: cookieBrowser || 'none',
      YTDLP_JS_RUNTIME: resolveYtDlpJsRuntime() || 'none',
      YTDLP_EXTRACTOR_ARGS: resolveYtDlpExtractorArgs()
    };

    try {
      this.process = spawn(RUST_ENGINE_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      console.error(`❌ [RUST] Unable to start process: ${e.message}`);
      this.isAlive = false;
      return;
    }

    this.isAlive = true;
    this.stdoutClosed = false;

    this._openLogStream();

    const rl = readline.createInterface({ input: this.process.stderr });
    this.stderrReadline = rl;
    rl.on('line', (line) => this._handleStderrLine(line));

    // Handle stdout errors - CRITICAL: mark mixer as dead
    this.process.stdout.on('error', (e) => {
      console.error(`❌ [RUST] Stdout error (mixer dead): ${e?.message || String(e)}`);
      this.stdoutClosed = true;
      this._killProcess();
      this._reportCrash('stdout_error');
    });

    this.process.stdout.on('close', () => {
      console.warn('⚠️ [RUST] Stdout closed');
      this.stdoutClosed = true;
      this._killProcess();
      this._closeLogStream('STDOUT_CLOSED');
    });

    this.process.stdin.on('error', (e) => {
      console.error(`❌ [RUST] Stdin error: ${e?.message || String(e)}`);
      this._killProcess();
    });

    this.process.on('close', (code) => {
      console.log(`🛑 [RUST] Terminated (Exit: ${code})`);
      this.process = null;
      this.isAlive = false;
      this._closeReadline();
      this._closeLogStream(`PROCESS_CLOSED code=${code}`);
      this._reportCrash(`process_close_${code}`);
    });

    this.process.on('error', (e) => {
      console.error(`❌ [RUST] Process error: ${e.message}`);
      this.process = null;
      this.isAlive = false;
      this._reportCrash(`process_error_${e.message}`);
    });
  }

  /**
   * Parses one stderr line and forwards it. Console verbosity is decided by
   * event type alone: the payload never affects whether the event is routed.
   * @param {string} line
   */
  _handleStderrLine(line) {
    if (!this.isAlive || this.stdoutClosed) return;

    let log = null;
    try { log = JSON.parse(line); } catch { /* not a JSON line: Rust also writes plain text to stderr */ }
    if (!log || !log.event) return;

    log._mixerGeneration = this.generation;

    const data = log.data || '';
    this._writeLog(`${log.event} ${data}\n`);

    if (CONSOLE_ERROR_EVENTS.has(log.event)) {
      console.error(`⚠️ [RUST-${log.event.toUpperCase()}] ${data}`);
    } else if (CONSOLE_INFO_EVENTS.has(log.event)) {
      console.log(`ℹ️ [RUST] ${data}`);
    }

    try {
      if (this.onLog) this.onLog(log);
    } catch (e) {
      console.error('Error in onLog handler', e);
    }
  }

  /**
   * Writes one line to the per-guild mixer log, rotating the file once it has
   * grown past its limit. Without this the log grew for as long as the mixer
   * lived, which on the bot's NVMe is both a space and a wear problem.
   * @param {string} line
   */
  _writeLog(line) {
    if (!this.logStream) return;
    try {
      this.logStream.write(line);
      this.logBytes += Buffer.byteLength(line);
      if (this.logBytes >= MAX_MIXER_LOG_BYTES) this._rotateLogStream();
    } catch { /* diagnostics only */ }
  }

  /** Closes the current log file, rotates it and starts a fresh one. */
  _rotateLogStream() {
    const target = this.logPath;
    this._closeLogStream('ROTATED');
    if (target) rotateIfNeeded(target, MAX_MIXER_LOG_BYTES);
    this._openLogStream();
  }

  _openLogStream() {
    this._closeLogStream();
    try {
      const logsDir = path.join(ROOT_DIR, 'temp');
      fs.mkdirSync(logsDir, { recursive: true });
      this.logPath = path.join(logsDir, `mixer-${this.guildId}.log`);
      // A log left over from a previous run counts towards the limit too
      rotateIfNeeded(this.logPath, MAX_MIXER_LOG_BYTES);
      this.logBytes = fs.statSync(this.logPath, { throwIfNoEntry: false })?.size || 0;
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
      this._writeLog(`\n===== Mixer start ${new Date().toISOString()} generation=${this.generation} =====\n`);
    } catch (e) {
      console.error('Unable to open mixer log stream', e);
    }
  }

  _closeLogStream(marker = null) {
    if (!this.logStream) return;
    try {
      if (marker) this.logStream.write(`${new Date().toISOString()} ${marker}\n`);
      this.logStream.end();
    } catch { /* stream already closed */ }
    this.logStream = null;
    this.logBytes = 0;
  }

  _closeReadline() {
    if (!this.stderrReadline) return;
    this.stderrReadline.close();
    this.stderrReadline = null;
  }

  _killProcess() {
    this.isAlive = false;
    if (!this.process) return;
    try { this.process.kill(); } catch { /* process already exited */ }
    this.process = null;
  }

  /**
   * Reports an unexpected death exactly once per process.
   * @param {string} reason
   */
  _reportCrash(reason) {
    if (!this.onCrash || this.hasCrashed) return;
    this.hasCrashed = true;
    console.log(`🚨 [RUST] Starting crash recovery (${reason})...`);
    try { this.onCrash(reason); } catch (e) { console.error('Error in onCrash handler', e); }
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

  load(url, deck, autoplay = true) { this.send({ op: 'load', url, deck, autoplay }); }
  /** Starts `deck` from the top. To come back from a pause use resume(). */
  play(deck) { this.send({ op: 'play', deck }); }
  stopDeck(deck) { this.send({ op: 'stop_deck', deck }); }
  crossfade(toDeck, durationMs = CROSSFADE_DURATION_MS) {
    this.send({ op: 'crossfade', to_deck: toDeck, duration_ms: durationMs });
  }
  skipTo(targetDeck) { this.send({ op: 'skip_to', target_deck: targetDeck }); }
  restartDeck(deck) { this.send({ op: 'restart_deck', deck }); }
  pause() { this.send({ op: 'pause_all' }); }
  /** Resumes exactly where pause() stopped, without restarting any deck. */
  resume() { this.send({ op: 'resume_all' }); }
  setLoop(enabled) { this.send({ op: 'set_loop', enabled }); }

  getStdout() {
    if (!this.process || !this.isAlive) return null;
    return this.process.stdout;
  }

  kill() {
    // Prevent the close handler from invoking onCrash: kill() is always intentional
    this.hasCrashed = true;
    // Close readline BEFORE killing the process
    this._closeReadline();
    this._closeLogStream('KILLED');
    this._killProcess();
    this.stdoutClosed = true;
  }

  isProcessAlive() { return this.isAlive && this.process !== null && !this.stdoutClosed; }
  needsRestart() { return !this.isAlive || this.stdoutClosed || this.process === null; }
}

export default AudioMixerController;
