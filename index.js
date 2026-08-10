import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import fs from 'fs';
import path from 'path';

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────
const logsDir = './logs';
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

process.on('unhandledRejection', (reason) => {
  console.error('🚨 [UNHANDLED-REJECTION] Promise rejected without handler:');
  console.error('Reason:', reason instanceof Error ? reason.message : String(reason));
  console.error('Stack:', reason instanceof Error ? reason.stack : 'N/A');
  try {
    const logEntry = `[${new Date().toISOString()}] UNHANDLED-REJECTION: ${reason instanceof Error ? reason.message : String(reason)}\n${reason instanceof Error ? reason.stack : 'N/A'}\n\n`;
    fs.appendFileSync(path.join(logsDir, 'unhandled-rejections.log'), logEntry);
  } catch { /* ignore */ }
});

process.on('uncaughtException', async (error) => {
  console.error('🚨 [UNCAUGHT-EXCEPTION] Uncaught exception:');
  console.error('Error:', error.message || String(error));
  console.error('Stack:', error.stack || 'N/A');

  // Save state before terminating
  try {
    const globalsModule = await import('./src/state/globals.js');
    const persistenceModule = await import('./src/queue/persistence.js');
    persistenceModule.flushPendingSaves();
    globalsModule.queue.forEach((sq, guildId) => {
      try { persistenceModule.saveQueueStateImmediate(guildId, sq); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }

  // Flush important data
  try {
    const statsModule = await import('./src/database/stats.js');
    statsModule.flushAllGuildsAndSave();
  } catch { /* ignore */ }
  try {
    const playlistsModule = await import('./src/database/playlists.js');
    playlistsModule.flushDatabaseSync();
  } catch { /* ignore */ }

  try {
    const logEntry = `[${new Date().toISOString()}] UNCAUGHT-EXCEPTION: ${error.message}\n${error.stack}\n\n`;
    fs.appendFileSync(path.join(logsDir, 'uncaught-exceptions.log'), logEntry);
  } catch { /* ignore */ }

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

// Initialize client, handlers and login
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });

const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;

const connectionHelpers = await import('./src/bootstrap/connection.js');
const audio = await import('./src/audio/index.js');

const interactionHandler = await import('./src/handlers/interaction.js');
interactionHandler.default(client, {
  ensureBotConnection: connectionHelpers.ensureBotConnection,
  connectToVoice: connectionHelpers.connectToVoice,
  playSong: audio.playSong,
  updatePreloadAfterQueueChange: audio.updatePreloadAfterQueueChange,
  preloadNextSongs: audio.preloadNextSongs,
  client
});

// Voice state handler: manages disconnection timers and reactions
const voiceStateHandler = await import('./src/handlers/voiceState.js');
voiceStateHandler.default(client);

// ─── CLEANUP HANDLER ───────────────────────────────────────
// Cleans versioning state, command queue, audio barrier, and timers when bot leaves a guild
const StateVersionModule = await import('./src/state/StateVersion.js');
const CommandQueueModule = await import('./src/audio/CommandQueue.js');
const AudioOperationBarrierModule = await import('./src/handlers/AudioOperationBarrier.js');
const PlaybackEngineModule = await import('./src/audio/PlaybackEngine.js');
const SkipManagerModule = await import('./src/audio/SkipManager.js');

const { stateVersionManager } = StateVersionModule;
const { commandQueue } = CommandQueueModule;
const { audioOperationBarrier } = AudioOperationBarrierModule;
const PlaybackEngine = PlaybackEngineModule.default;
const SkipManager = SkipManagerModule.default;

client.on('guildDelete', async (guild) => {
  const guildId = guild.id;
  try {
    console.log(`🚀 [CLEANUP] Bot left guild ${guildId} - cleaning up state`);

    // Clean PlaybackEngine timers (preload, etc)
    PlaybackEngine.clearAllTimers(guildId);

    // Clean state versioning
    stateVersionManager.cleanup(guildId);

    // Clean command queue
    commandQueue.cleanup(guildId);

    // Clean audio operation barrier
    audioOperationBarrier.cleanup(guildId);

    // Clean persistence timers
    const persistenceModule = await import('./src/queue/persistence.js');
    persistenceModule.cleanupGuild(guildId);

    // Clean playback state (lastMixerCrashTime)
    const playbackModule = await import('./src/audio/playback.js');
    playbackModule.cleanupPlaybackState(guildId);

    // Clean stream error tracking
    const audioIndexModule = await import('./src/audio/index.js');
    audioIndexModule.clearStreamErrors(guildId);

    // Clean skip throttle state
    SkipManager.cleanupSkipState(guildId);

    // Clean cleanup debounce (play.js)
    const playCommandModule = await import('./src/commands/play.js');
    playCommandModule.cleanupLastCleanupTime(guildId);

    // Clean dashboard timer, disconnect timer, cooldowns and remove from queue
    const globalsModule = await import('./src/state/globals.js');
    const globals = globalsModule;
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

    // Stop player, mixer, voice connection and low-latency stream
    if (sq) {
      try { if (sq.player) sq.player.stop(true); } catch { }
      sq.intentionalKill = true;
      try { if (sq.mixer) { sq.mixer.kill(); sq.mixer = null; } } catch { }
      try { if (sq.connection) sq.connection.destroy(); } catch { }
      try { if (sq._llStream) { sq._llStream.unpipe(); sq._llStream.destroy(); sq._llStream = null; } } catch { }
    }

    globals.queue.delete(guildId);

    console.log(`✅ [CLEANUP] Guild ${guildId} cleaned up`);
  } catch (e) {
    console.error(`❌ [CLEANUP] Error cleaning up guild ${guildId}:`, e);
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  // ── AUTO-PUSH STATS (Daily check to ensure push on the 1st of the month) ────────────────────────────────────────────
  // Check every minute if it should push stats (1st of the month from 10:00 onwards)
  const { pushStats } = await import('./scripts/push-stats.js');
  const { flushAllGuildsAndSave } = await import('./src/database/stats.js');

  const tryPushStats = async () => {
    try {
      const now = new Date();
      // Rome time: extract components via Intl.DateTimeFormat (robust, doesn't depend on local format)
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
      const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; // To avoid multiple pushes on the same day

      const pushState = loadPushState();

      // Check if it's the 1st of the month and hour is >= 10:00 and hasn't already pushed today
      if (day === 1 && hour >= 10 && pushState.lastPushDate !== dateKey) {
        // Flush any in-memory data to disk before push (otherwise it won't include active listeners)
        try {
          flushAllGuildsAndSave();
          const playlistsModule = await import('./src/database/playlists.js');
          playlistsModule.flushDatabaseSync();
        } catch (e) {
          console.warn('⚠️ [STATS-PUSH] Flush before push failed:', e.message);
        }

        console.log('📤 [STATS-PUSH] Pushing monthly stats at', `${String(romaParts.hour).padStart(2, '0')}:00`);
        const success = await pushStats(true);
        if (success) {
          pushState.lastPushDate = dateKey; // Mark that push was done
          savePushState(pushState); // Save to disk
          console.log('✅ [STATS-PUSH] Stats pushed successfully to GitHub');
        } else {
          console.warn('⚠️ [STATS-PUSH] Stats push failed, will retry next check');
        }
      }
    } catch (e) {
      console.error('❌ [STATS-PUSH] Error during interval check:', e.message);
    }
  };

  // Run first check immediately (useful if bot started mid-morning)
  tryPushStats();
  setInterval(tryPushStats, 60 * 1000); // Check every minute
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────
// Flush statistics and save queue state at program shutdown
async function gracefulShutdown(signal) {
  console.log(`\n🚫 [SHUTDOWN] Received ${signal}, saving in progress...`);
  try {
    const globalsModule = await import('./src/state/globals.js');
    const persistenceModule = await import('./src/queue/persistence.js');
    const q = globalsModule.queue;
    persistenceModule.flushPendingSaves();
    q.forEach((sq, gId) => {
      try { persistenceModule.saveQueueStateImmediate(gId, sq); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  try {
    const statsModule = await import('./src/database/stats.js');
    statsModule.flushAllGuildsAndSave();
  } catch { /* ignore */ }
  try {
    const playlistsModule = await import('./src/database/playlists.js');
    playlistsModule.flushDatabaseSync();
  } catch { /* ignore */ }
  console.log('✅ [SHUTDOWN] Saving completed.');
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

client.login(token).catch(e => console.error('Login error:', e));
