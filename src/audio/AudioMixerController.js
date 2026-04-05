/**
 * src/audio/AudioMixerController.js
 * Controller per il mixer audio Rust (integrazione sidecar)
 */

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { ROOT_DIR, RUST_ENGINE_PATH } = require('../../config');
const { CROSSFADE_DURATION_MS, MIN_CROSSFADE_MS, RESTART_COOLDOWN_MS } = require('../../config');
const { getNextMixerGeneration } = require('../state/globals');

/**
 * Controller per il processo Rust del mixer audio
 * Gestisce comunicazione bidirezionale via stdin/stdout
 */
class AudioMixerController {
    constructor(guildId, onLog, onBufferReady, onCrash = null) {
        this.guildId = guildId;
        this.process = null;
        this.onLog = onLog;
        this.onBufferReady = onBufferReady;
        this.onCrash = onCrash; // Callback per recovery automatico dopo crash
        this.isAlive = false;
        this.lastRestartTime = 0;
        this.stdoutClosed = false;
        this.stderrReadline = null;
        this.hasCrashed = false;
        this.generation = getNextMixerGeneration(); // ID univoco per questo mixer
        this.logStream = null;
    }

    start() {
        // Se il processo esiste ma è morto, puliscilo prima
        if (this.process && !this.isAlive) {
            console.log(`🧹 [RUST] Pulizia processo morto prima di restart`);
            try { this.process.kill(); } catch (e) { }
            this.process = null;
        }

        if (this.process) return;

        // Prevent restart spam (minimum 5 seconds between starts)
        const now = Date.now();
        if (now - this.lastRestartTime < RESTART_COOLDOWN_MS) {
            const waitTime = RESTART_COOLDOWN_MS - (now - this.lastRestartTime);
            console.warn(`⚠️ [RUST] Cooldown attivo, attendi ${(waitTime / 1000).toFixed(1)}s prima del prossimo restart`);
            return;
        }
        this.lastRestartTime = now;

        // Log minimale di avvio
        console.info(`🦀 [RUST] Avvio motore audio per ${this.guildId}`);

        // Passa DISCORD_BOT_PATH al processo Rust per configurazione dinamica percorsi
        const env = {
            ...process.env,
            PATH: `${process.env.PATH}${path.delimiter}${ROOT_DIR}`,
            DISCORD_BOT_PATH: ROOT_DIR
        };

        try {
            this.process = spawn(RUST_ENGINE_PATH, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: env
            });
        } catch (e) {
            console.error(`❌ [RUST] Impossibile avviare processo: ${e.message}`);
            this.isAlive = false;
            return;
        }

        this.isAlive = true;
        this.stdoutClosed = false;
        this.hasCrashed = false; // Reset per permettere recovery su futuri crash

        // Chiudi risorse precedenti prima di riavviare
        if (this.logStream) {
            try { this.logStream.destroy(); } catch (e) { }
            this.logStream = null;
        }
        if (this.stderrReadline) {
            this.stderrReadline.close();
            this.stderrReadline = null;
        }

        const rl = readline.createInterface({ input: this.process.stderr });
        this.stderrReadline = rl;

        // Apri il log stderr del mixer per guild una sola volta per diagnostica
        try {
            const logsDir = path.join(ROOT_DIR, 'temp');
            try { fs.mkdirSync(logsDir, { recursive: true }); } catch (e) { }
            const logPath = path.join(logsDir, `mixer-${this.guildId}.log`);
            this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
            this.logStream.write(`\n===== Mixer start ${new Date().toISOString()} generation=${this.generation} =====\n`);
        } catch (e) { console.error('Impossibile aprire stream log mixer', e); }

        rl.on('line', (line) => {
            // CRITICO: Ignora eventi se il mixer è morto
            if (!this.isAlive || this.stdoutClosed) {
                return;
            }

            try {
                let log = null;
                try { log = JSON.parse(line); } catch (parseErr) {
                    // ignora le righe non JSON ma conserva un minimo di debug
                }
                if (!log) return;
                log._mixerGeneration = this.generation;

                // --- FILTRO SILENZIATORE ---
                const dataStr = log.data || "";
                const isSpam = dataStr.includes('[FFMPEG]') ||
                    dataStr.includes('Broken pipe') ||
                    dataStr.includes('TextIOWrapper') ||
                    dataStr.includes('Buffering:') ||
                    dataStr.startsWith('Buffer ') ||
                    dataStr.startsWith('Mixer Status');

                if (!isSpam) {
                    // Mostra in console solo warning ed errori per evitare log troppo rumorosi
                    if (log.event === 'error' || log.event === 'stream_error' || log.event === 'yt_error') {
                        console.error(`⚠️ [RUST-${log.event.toUpperCase()}] ${log.data}`);
                    }
                    // 🔥 SHOW LATENCY LOGS
                    else if (log.event === 'latency' || log.event === 'info') {
                        console.log(`ℹ️ [RUST] ${log.data}`);
                    } else if (log.event === 'debug' && log.data.includes('Trimmed')) {
                        console.log(`✂️ [RUST] ${log.data}`);
                    }

                    // Inoltra tutti gli eventi non-spam a `onLog` per l'elaborazione (NO DUPLICATE CALLS!)
                    if (this.onLog) this.onLog(log);
                }

                // Intercetta buffer_ready event (edge detection già nel Rust)
                if (log.event === 'buffer_ready') {
                    const deck = log.data;
                    console.log(`✅ [RUST] Buffer pronto su Deck ${deck}`);
                    try { if (this.onBufferReady) this.onBufferReady(deck); } catch (e) { console.error('Errore handler onBufferReady', e); }
                }

            } catch (e) { }
        });

        // Gestisci errori su stdout - CRITICO: marca il mixer come morto
        this.process.stdout.on('error', (err) => {
            console.error(`❌ [RUST] Errore stdout (mixer morto): ${err && err.message ? err.message : String(err)}`);
            this.isAlive = false;
            this.stdoutClosed = true;
            if (this.process) {
                try { this.process.kill(); } catch (e) { }
                this.process = null;
            }
            // Trigger crash callback per recovery automatico
            if (this.onCrash && !this.hasCrashed) {
                this.hasCrashed = true;
                console.log(`🚨 [RUST] Avvio recovery crash...`);
                try { this.onCrash('stdout_error'); } catch (e) { console.error('Errore handler onCrash', e); }
            }
        });

        this.process.stdout.on('close', () => {
            console.warn(`⚠️ [RUST] Stdout chiuso`);
            this.stdoutClosed = true;
            this.isAlive = false;
            if (this.process) {
                try { this.process.kill(); } catch (e) { }
                this.process = null;
            }
            try { if (this.logStream) { this.logStream.write(`${new Date().toISOString()} STDOUT_CLOSED\n`); this.logStream.end(); this.logStream = null; } } catch (e) { }
        });

        this.process.stdin.on('error', (err) => {
            console.error(`❌ [RUST] Errore stdin: ${err && err.message ? err.message : err}`);
            this.isAlive = false;
            if (this.process) {
                try { this.process.kill(); } catch (e) { }
                this.process = null;
            }
        });

        this.process.on('close', (code) => {
            console.log(`🛑 [RUST] Terminato (Exit: ${code})`);
            this.process = null;
            this.isAlive = false;
            if (this.stderrReadline) {
                this.stderrReadline.close();
                this.stderrReadline = null;
            }
            try { if (this.logStream) { this.logStream.write(`${new Date().toISOString()} PROCESS_CLOSED code=${code}\n`); this.logStream.end(); this.logStream = null; } } catch (e) { }
            if (this.onCrash && !this.hasCrashed) {
                this.hasCrashed = true;
                console.log(`🚨 [RUST] Triggering crash recovery from close (code=${code})...`);
                try { this.onCrash(`process_close_${code}`); } catch (e) { console.error('onCrash handler error', e); }
            }
        });

        this.process.on('error', (err) => {
            console.error(`❌ [RUST] Errore processo: ${err.message}`);
            this.process = null;
            this.isAlive = false;
            if (this.onCrash && !this.hasCrashed) {
                this.hasCrashed = true;
                console.log(`🚨 [RUST] Triggering crash recovery da process error...`);
                try { this.onCrash(`process_error_${err.message}`); } catch (e) { console.error('onCrash handler error', e); }
            }
        });
    }


    send(cmd) {
        if (!this.process || !this.isAlive) {
            console.warn(`⚠️ [MIXER] Processo non attivo, comando ignorato`);
            return false;
        }
        try {
            this.process.stdin.write(JSON.stringify(cmd) + '\n');
            return true;
        } catch (e) {
            console.error(`❌ [MIXER] Errore invio comando:`, e.message);
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
        const safeDurationMs = Math.max(durationMs, MIN_CROSSFADE_MS);
        this.send({ op: 'crossfade', to_deck: toDeck, duration_ms: safeDurationMs });
    }

    skipTo(targetDeck) {
        this.send({ op: 'skip_to', target_deck: targetDeck });
    }

    approveProposal(newDeck) {
        this.send({ op: 'approve_proposal', new_deck: newDeck });
    }

    restartDeck(deck) {
        this.send({ op: 'restart_deck', deck });
    }
    pause() { this.send({ op: 'pause_all' }); }
    resume() { this.send({ op: 'resume_all' }); }
    setProactiveCrossfade(enabled) { this.send({ op: 'set_proactive_crossfade', enabled }); }
    setLoop(enabled) { this.send({ op: 'set_loop', enabled }); }

    getStdout() {
        if (!this.process || !this.isAlive) return null;
        return this.process.stdout;
    }

    kill() {
        // Previeni che il close handler invochi onCrash: kill() è sempre intenzionale
        this.hasCrashed = true;
        // Chiudi readline PRIMA di uccidere il processo
        if (this.stderrReadline) {
            this.stderrReadline.close();
            this.stderrReadline = null;
        }
        // Chiudi logStream per evitare file descriptor leak
        if (this.logStream) {
            try { this.logStream.end(); } catch (e) { }
            this.logStream = null;
        }
        if (this.process) {
            try { this.process.kill(); } catch (e) { }
            this.process = null;
        }
        this.isAlive = false;
        this.stdoutClosed = true;
    }

    isProcessAlive() { return this.isAlive && this.process !== null && !this.stdoutClosed; }
    needsRestart() { return !this.isAlive || this.stdoutClosed || this.process === null; }
}

module.exports = AudioMixerController;
