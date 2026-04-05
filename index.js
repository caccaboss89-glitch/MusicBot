require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────
// Previene crash silenzioso del bot su unhandled rejections
const logsDir = './logs';
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 [UNHANDLED-REJECTION] Promise rifiutata senza handler:');
    console.error('Reason:', reason instanceof Error ? reason.message : String(reason));
    console.error('Stack:', reason instanceof Error ? reason.stack : 'N/A');
    try {
        const logEntry = `[${new Date().toISOString()}] UNHANDLED-REJECTION: ${reason instanceof Error ? reason.message : String(reason)}\n${reason instanceof Error ? reason.stack : 'N/A'}\n\n`;
        fs.appendFileSync(path.join(logsDir, 'unhandled-rejections.log'), logEntry);
    } catch (e) { /* ignore */ }
});

process.on('uncaughtException', (error) => {
    console.error('🚨 [UNCAUGHT-EXCEPTION] Eccezione non catturata:');
    console.error('Error:', error.message || String(error));
    console.error('Stack:', error.stack || 'N/A');
    // Tenta di salvare lo stato prima di crashare
    try {
        const { queue } = require('./src/state/globals');
        const { saveQueueStateImmediate, flushPendingSaves } = require('./src/queue/persistence');
        flushPendingSaves();
        queue.forEach((sq, guildId) => {
            try { saveQueueStateImmediate(guildId, sq); } catch (e) { /* ignore */ }
        });
    } catch (e) { /* ignore */ }
    // Flush statistiche ascolto prima del crash
    try { require('./src/database/stats').flushAllGuildsAndSave(); } catch (e) { /* ignore */ }
    // Log su file
    try {
        const logEntry = `[${new Date().toISOString()}] UNCAUGHT-EXCEPTION: ${error.message}\n${error.stack}\n\n`;
        fs.appendFileSync(path.join(logsDir, 'uncaught-exceptions.log'), logEntry);
    } catch (e) { /* ignore */ }
    // Restart gracefully
    process.exit(1);
});

// ─── AUTO-PUSH STATS STATE MANAGEMENT ─────────────────────────────────────
const PUSH_STATE_FILE = path.join('./data', 'pushState.json');

function loadPushState() {
    if (!fs.existsSync(PUSH_STATE_FILE)) {
        return { lastPushDate: null };
    }
    try {
        return JSON.parse(fs.readFileSync(PUSH_STATE_FILE, 'utf-8'));
    } catch {
        return { lastPushDate: null };
    }
}

function savePushState(state) {
    const dir = path.dirname(PUSH_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PUSH_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// Punto di ingresso minimo: crea client, registra handler e fai login
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });

const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;

// Collega i helper reali agli handler di interazione
const connectionHelpers = require('./src/bootstrap/connection');
const audio = require('./src/audio');

require('./src/handlers/interaction')(client, {
    ensureBotConnection: connectionHelpers.ensureBotConnection,
    connectToVoice: connectionHelpers.connectToVoice,
    playSong: audio.playSong,
    updatePreloadAfterQueueChange: audio.updatePreloadAfterQueueChange,
    preloadNextSongs: audio.preloadNextSongs,
    client
});

// Gestore dello stato vocale: gestisce timer di disconnessione e reazioni
require('./src/handlers/voiceState')(client);

// ─── CLEANUP HANDLER ───────────────────────────────────────
// Pulisce lo stato di versioning, command queue, audio barrier, e timers quando bot lascia una guild
const { stateVersionManager } = require('./src/state/StateVersion');
const { commandQueue } = require('./src/audio/CommandQueue');
const { audioOperationBarrier } = require('./src/handlers/AudioOperationBarrier');
const PlaybackEngine = require('./src/audio/PlaybackEngine');

client.on('guildDelete', (guild) => {
    const guildId = guild.id;
    try {
        console.log(`🚀 [CLEANUP] Bot left guild ${guildId} - cleaning up state`);
        
        // Pulisci PlaybackEngine timers (preload, etc)
        PlaybackEngine.clearAllTimers(guildId);
        
        // Pulisci state versioning
        stateVersionManager.cleanup(guildId);
        
        // Pulisci command queue
        commandQueue.cleanup(guildId);
        
        // Pulisci audio operation barrier
        audioOperationBarrier.cleanup(guildId);
        
        // Pulisci persistence timers
        require('./src/queue/persistence').cleanupGuild(guildId);
        
        // Pulisci playback state (lastMixerCrashTime)
        require('./src/audio/playback').cleanupPlaybackState(guildId);
        
        // Pulisci dashboard timer, disconnect timer, cooldowns e rimuovi dalla queue
        const globals = require('./src/state/globals');
        const sq = globals.queue.get(guildId);
        if (sq && sq.dashboardState && sq.dashboardState.timer) {
            clearTimeout(sq.dashboardState.timer);
            sq.dashboardState.timer = null;
        }
        if (globals.disconnectTimers.has(guildId)) {
            clearTimeout(globals.disconnectTimers.get(guildId));
            globals.disconnectTimers.delete(guildId);
        }
        globals.interactionCooldowns.delete(guildId);
        globals.queue.delete(guildId);
        
        console.log(`✅ [CLEANUP] Guild ${guildId} cleaned up`);
    } catch (e) {
        console.error(`❌ [CLEANUP] Error cleaning up guild ${guildId}:`, e);
    }
});

client.once('clientReady', () => {
    console.log(`Logged in as ${client.user?.tag}`);
    
    // ── AUTO-PUSH STATS (Daily check per garantire push il 1° del mese) ────────────────────────────────────────────
    // Controlla ogni minuto se deve pushare i stats (il 1° del mese dalle 10:00 in poi)
    const { pushStats } = require('./scripts/push-stats');
    const { flushAllGuildsAndSave } = require('./src/database/stats');

    const tryPushStats = () => {
        try {
            const now = new Date();
            // Roma time: estrai componenti via Intl.DateTimeFormat (robusto, non dipende dal formato locale)
            const romaFmt = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Europe/Rome',
                year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false
            });
            const romaParts = Object.fromEntries(
                romaFmt.formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, parseInt(p.value)])
            );
            const day = romaParts.day;
            const hour = romaParts.hour;
            const month = romaParts.month;
            const year = romaParts.year;
            const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; // Per evitare push multipli lo stesso giorno

            const pushState = loadPushState();

            // Controlla se è il 1° del mese e l'ora è >= 10:00 e non ha già fatto push oggi
            if (day === 1 && hour >= 10 && pushState.lastPushDate !== dateKey) {
                // Flush eventuali dati in memoria su disco prima del push (altrimenti non include i listener attivi)
                try {
                    flushAllGuildsAndSave();
                } catch (flushErr) {
                    console.warn('⚠️ [STATS-PUSH] Flush before push failed:', flushErr.message);
                }

                console.log('📤 [STATS-PUSH] Pushing stats del mese alle', `${String(romaParts.hour).padStart(2, '0')}:00`);
                const success = pushStats();
                if (success) {
                    pushState.lastPushDate = dateKey; // Segna che ha fatto push
                    savePushState(pushState); // Salva su disco
                    console.log('✅ [STATS-PUSH] Stats pushed successfully to GitHub');
                } else {
                    console.warn('⚠️ [STATS-PUSH] Stats push failed, will retry next check');
                }
            }
        } catch (e) {
            console.error('❌ [STATS-PUSH] Errore durante interval check:', e.message);
        }
    };

    // Esegui un primo controllo subito (utile se il bot è partito a metà mattinata)
    tryPushStats();
    setInterval(tryPushStats, 60 * 1000); // Controlla ogni minuto
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────
// Flush statistiche e salva stato coda alla chiusura del programma
function gracefulShutdown(signal) {
    console.log(`\n🚫 [SHUTDOWN] Ricevuto ${signal}, salvataggio in corso...`);
    try {
        const { queue: q } = require('./src/state/globals');
        const { saveQueueStateImmediate, flushPendingSaves } = require('./src/queue/persistence');
        flushPendingSaves();
        q.forEach((sq, gId) => {
            try { saveQueueStateImmediate(gId, sq); } catch (e) { /* ignore */ }
        });
    } catch (e) { /* ignore */ }
    try { require('./src/database/stats').flushAllGuildsAndSave(); } catch (e) { /* ignore */ }
    console.log(`✅ [SHUTDOWN] Salvataggio completato.`);
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

client.login(token).catch(e => console.error('Login error:', e));
