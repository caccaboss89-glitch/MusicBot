import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client, GatewayIntentBits } from 'discord.js';

import { ROOT_DIR, DATA_DIR, LOCAL_TEMP_DIR } from './config/index.js';
import { queue, disconnectTimers, clearGuildCooldowns } from './src/state/globals.js';
import { stateVersionManager } from './src/state/StateVersion.js';
import { commandQueue, audioOperationBarrier } from './src/audio/SerialQueue.js';
import { stopGuildAudio, clearGuildAudioState } from './src/audio/teardown.js';
import { playSong, updatePreloadAfterQueueChange } from './src/audio/index.js';
import { flushPendingSaves, saveQueueStateImmediate, cleanupGuild } from './src/queue/persistence.js';
import { flushAllGuildsAndSave } from './src/database/stats.js';
import { flushDatabaseSync } from './src/database/playlists.js';
import { ensureBotConnection, connectToVoice } from './src/bootstrap/connection.js';
import registerInteractionHandlers from './src/handlers/interaction.js';
import registerVoiceStateHandler from './src/handlers/voiceState.js';
import { pushStats } from './scripts/push-stats.js';
import { appendCapped, cleanupOldFiles } from './src/utils/logfiles.js';

// All paths resolve from the project root so the bot behaves the same no matter
// which working directory it was launched from.
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const PUSH_STATE_FILE = path.join(DATA_DIR, 'pushState.json');

const STATS_PUSH_CHECK_INTERVAL_MS = 60 * 1000;
const STATS_PUSH_HOUR = 10; // Rome time, on the 1st of the month

// temp/ collects one log per guild mixer plus whatever yt-dlp leaves behind,
// and nothing ever removed any of it. Swept at startup and once a day after.
const TEMP_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(LOGS_DIR, { recursive: true });

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────

/**
 * Appends a fatal event to its log file. Never throws.
 * @param {string} fileName
 * @param {string} label
 * @param {unknown} error
 */
function logFatal(fileName, label, error) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : 'N/A';
  console.error(`🚨 [${label}] ${message}`);
  console.error('Stack:', stack);
  // Capped: these files are append-only and were never rotated, so a crash
  // loop used to be able to fill the disk on its own.
  appendCapped(path.join(LOGS_DIR, fileName), `[${new Date().toISOString()}] ${label}: ${message}\n${stack}\n\n`);
}

/**
 * Writes everything still held in memory to disk.
 * Shared by the shutdown signals and the uncaught-exception handler.
 */
function persistEverything() {
  try {
    flushPendingSaves();
    queue.forEach((sq, guildId) => {
      try { saveQueueStateImmediate(guildId, sq); } catch { /* keep saving the other guilds */ }
    });
  } catch (e) { console.error('❌ [SHUTDOWN] Queue save failed:', e.message); }
  try { flushAllGuildsAndSave(); } catch (e) { console.error('❌ [SHUTDOWN] Stats flush failed:', e.message); }
  try { flushDatabaseSync(); } catch (e) { console.error('❌ [SHUTDOWN] Playlist flush failed:', e.message); }
}

process.on('unhandledRejection', (reason) => {
  logFatal('unhandled-rejections.log', 'UNHANDLED-REJECTION', reason);
});

process.on('uncaughtException', (error) => {
  logFatal('uncaught-exceptions.log', 'UNCAUGHT-EXCEPTION', error);
  persistEverything();
  process.exit(1);
});

// ─── CLIENT ───────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages]
});

registerInteractionHandlers(client, {
  ensureBotConnection,
  connectToVoice,
  playSong,
  updatePreloadAfterQueueChange,
  client
});

// Voice state handler: manages disconnection timers and listening statistics
registerVoiceStateHandler(client);

// ─── CLEANUP WHEN THE BOT LEAVES A GUILD ──────────────────────

client.on('guildDelete', (guild) => {
  const guildId = guild.id;
  console.log(`🚀 [CLEANUP] Bot left guild ${guildId} - cleaning up state`);

  // Stop everything that could still touch this guild
  const sq = queue.get(guildId);
  if (sq) stopGuildAudio(sq, { reason: 'Bot removed from guild', destroyConnection: true });

  if (disconnectTimers.has(guildId)) {
    clearTimeout(disconnectTimers.get(guildId));
    disconnectTimers.delete(guildId);
  }

  // Forget every per-guild registry: the bot will not see this guild again
  clearGuildAudioState(guildId);
  stateVersionManager.cleanup(guildId);
  commandQueue.cleanup(guildId);
  audioOperationBarrier.cleanup(guildId);
  cleanupGuild(guildId);
  clearGuildCooldowns(guildId);
  queue.delete(guildId);

  console.log(`✅ [CLEANUP] Guild ${guildId} cleaned up`);
});

// ─── AUTO-PUSH STATS ──────────────────────────────────────────
// Checks every minute whether the monthly stats push is due (1st of the month,
// from 10:00 Rome time onwards), so a bot started late still performs it.

function loadPushState() {
  try {
    return JSON.parse(fs.readFileSync(PUSH_STATE_FILE, 'utf-8'));
  } catch {
    return { lastPushDate: null };
  }
}

function savePushState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PUSH_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('❌ [STATS-PUSH] Unable to save the push state:', e.message);
  }
}

/**
 * Current date in Rome, independent of the host timezone.
 * @returns {{year: number, month: number, day: number, hour: number}}
 */
function getRomeNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false
  }).formatToParts(new Date());

  return Object.fromEntries(
    parts.filter(p => p.type !== 'literal').map(p => [p.type, parseInt(p.value, 10)])
  );
}

async function tryPushStats() {
  try {
    const { year, month, day, hour } = getRomeNow();
    if (day !== 1 || hour < STATS_PUSH_HOUR) return;

    // Guards against pushing twice on the same day
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const pushState = loadPushState();
    if (pushState.lastPushDate === dateKey) return;

    // Flush in-memory data first, otherwise the push misses active listeners
    try {
      flushAllGuildsAndSave();
      flushDatabaseSync();
    } catch (e) {
      console.warn('⚠️ [STATS-PUSH] Flush before push failed:', e.message);
    }

    console.log(`📤 [STATS-PUSH] Pushing monthly stats at ${String(hour).padStart(2, '0')}:00`);
    if (await pushStats(true)) {
      pushState.lastPushDate = dateKey;
      savePushState(pushState);
      console.log('✅ [STATS-PUSH] Stats pushed successfully to GitHub');
    } else {
      console.warn('⚠️ [STATS-PUSH] Stats push failed, will retry next check');
    }
  } catch (e) {
    console.error('❌ [STATS-PUSH] Error during interval check:', e.message);
  }
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user?.tag}`);
  tryPushStats();
  setInterval(tryPushStats, STATS_PUSH_CHECK_INTERVAL_MS);

  cleanupOldFiles(LOCAL_TEMP_DIR);
  setInterval(() => cleanupOldFiles(LOCAL_TEMP_DIR), TEMP_CLEANUP_INTERVAL_MS);
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────

function gracefulShutdown(signal) {
  console.log(`\n🚫 [SHUTDOWN] Received ${signal}, saving in progress...`);
  persistEverything();
  console.log('✅ [SHUTDOWN] Saving completed.');
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN || process.env.BOT_TOKEN)
  .catch(e => console.error('Login error:', e));
