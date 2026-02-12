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
        const { saveQueueState } = require('./src/queue/persistence');
        queue.forEach((sq, guildId) => {
            try { saveQueueState(guildId, sq); } catch (e) { /* ignore */ }
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
        
        console.log(`✅ [CLEANUP] Guild ${guildId} cleaned up`);
    } catch (e) {
        console.error(`❌ [CLEANUP] Error cleaning up guild ${guildId}:`, e);
    }
});

client.once('clientReady', () => {
    console.log(`Logged in as ${client.user?.tag}`);
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────
// Flush statistiche e salva stato coda alla chiusura del programma
function gracefulShutdown(signal) {
    console.log(`\n🚫 [SHUTDOWN] Ricevuto ${signal}, salvataggio in corso...`);
    try {
        const { queue: q } = require('./src/state/globals');
        const { saveQueueState: sqSave } = require('./src/queue/persistence');
        q.forEach((sq, gId) => {
            try { sqSave(gId, sq); } catch (e) { /* ignore */ }
        });
    } catch (e) { /* ignore */ }
    try { require('./src/database/stats').flushAllGuildsAndSave(); } catch (e) { /* ignore */ }
    console.log(`✅ [SHUTDOWN] Salvataggio completato.`);
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

client.login(token).catch(e => console.error('Login error:', e));
