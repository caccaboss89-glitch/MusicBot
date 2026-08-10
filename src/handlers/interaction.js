import { Events, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { interactionCooldowns } from '../state/globals.js';
import { audioOperationBarrier } from '../audio/SerialQueue.js';
import * as audio from '../audio/index.js';
import { getCurrentSong, clearFinishedQueue, clearDeckBindings, bindDeckSong } from '../queue/QueueManager.js';
import { createDashboardComponents } from '../ui/index.js';
import { sanitizeTitle, areSameSong, safeParseInt, getYoutubeId } from '../utils/sanitize.js';
import { getVideoInfo } from '../utils/youtube.js';
import { getLyrics, chunkLyrics } from '../utils/lyrics.js';
import { loadDatabase } from '../database/playlists.js';
import { saveQueueState } from '../queue/persistence.js';
import { safeReply } from '../utils/discord.js';
import { MAX_QUEUE_SIZE } from '../../config/index.js';
import { handlePlaylist } from './playlistHandlers.js';
import handleModal from './modalHandlers.js';
import * as msg from '../ui/messages.js';

// Discord rejects messages longer than this
const MESSAGE_MAX_LENGTH = 2000;
// Minimum gap between two component interactions from the same user
const INTERACTION_COOLDOWN_MS = 200;
// Shared settings for every operation routed through the audio barrier
const AUDIO_OP_OPTIONS = { timeout: 10000, minThrottle: 2000 };

/**
 * Refreshes the buttons of the dashboard message, preferring an interaction
 * update (instant, no extra API call) and falling back to editing the message.
 * @param {import('discord.js').Interaction} interaction
 * @param {object} serverQueue
 */
async function refreshComponents(interaction, serverQueue) {
  const components = createDashboardComponents(serverQueue);
  try {
    await interaction.update({ components });
  } catch {
    if (serverQueue.dashboardMessage) {
      await serverQueue.dashboardMessage.edit({ components }).catch(() => { });
    }
  }
}

// ─── Button Handlers ────────────────────────────────────────

async function handleClearQueue(interaction, serverQueue, guildId) {
  // Cancel pending deferred transition before clearing queue
  if (serverQueue.pendingTransition) {
    if (serverQueue.pendingTransition._cleanupTimer) clearTimeout(serverQueue.pendingTransition._cleanupTimer);
    serverQueue.pendingTransition = null;
  }
  const currentSong = getCurrentSong(serverQueue);
  serverQueue.songs = currentSong ? [currentSong] : [];
  serverQueue.playIndex = 0;
  serverQueue.history = [];
  serverQueue.nextDeckLoaded = null;
  serverQueue.nextDeckTarget = null;
  // Re-align bindings: only current song remains in queue (index 0 on active deck).
  clearDeckBindings(serverQueue);
  if (currentSong && serverQueue.currentDeck) {
    bindDeckSong(serverQueue, serverQueue.currentDeck, 0, currentSong.url);
  }
  saveQueueState(guildId, serverQueue);
  await audio.updatePreloadAfterQueueChange(guildId);
  if (serverQueue.dashboardMessage) {
    await serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue) }).catch(() => { });
  }
}

async function handlePause(interaction, serverQueue, guildId, deps) {
  const result = await audio.togglePauseResume(guildId, serverQueue, { connectToVoice: deps.connectToVoice });
  if (!result.success) {
    console.error(`❌ [PAUSE-BUTTON] ${result.error}`);
    await safeReply(interaction, { content: msg.PAUSE_TOGGLE_FAILED, flags: MessageFlags.Ephemeral });
    return;
  }
  saveQueueState(guildId, serverQueue);
  await refreshComponents(interaction, serverQueue);
}

async function handleYtMix(interaction, serverQueue, guildId, deps) {
  serverQueue.isTaskRunning = true;
  let statusMsg = null;
  try {
    statusMsg = await interaction.followUp({ content: msg.MIX_GENERATING, flags: MessageFlags.Ephemeral });
  } catch { /* the interaction may already be gone */ }

  const setStatus = (content) => statusMsg ? statusMsg.edit({ content }).catch(() => { }) : Promise.resolve();

  try {
    const db = loadDatabase();
    const currentSong = getCurrentSong(serverQueue);
    const seedSource = db.server.length > 0 ? db.server : (currentSong ? [currentSong] : serverQueue.history);
    if (!seedSource || seedSource.length === 0) return await setStatus(msg.MIX_NEEDS_SEED);

    const randomSong = seedSource[Math.floor(Math.random() * seedSource.length)];
    const videoId = getYoutubeId(randomSong.url);
    if (!videoId) throw new Error('Invalid video ID');

    const songsFound = await getVideoInfo(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`);
    if (!songsFound || songsFound.length === 0) return await setStatus(msg.MIX_NO_RESULTS);

    // The mix starts with the seed song itself: skip it if it is already playing
    const currentMixSong = getCurrentSong(serverQueue);
    if (currentMixSong && areSameSong(songsFound[0].url, currentMixSong.url)) songsFound.shift();

    if (serverQueue.songs.length + (serverQueue.history || []).length + songsFound.length > MAX_QUEUE_SIZE) {
      return await setStatus(msg.QUEUE_LIMIT_REACHED);
    }

    clearFinishedQueue(serverQueue);
    songsFound.forEach(s => serverQueue.songs.push({ ...s, requester: interaction.user.id }));
    saveQueueState(guildId, serverQueue);

    if (!serverQueue.currentDeckLoaded) {
      const connected = await deps.connectToVoice(serverQueue, interaction);
      if (connected) await audio.playSong(guildId);
    } else {
      await audio.updatePreloadAfterQueueChange(guildId);
      if (serverQueue.dashboardMessage) {
        await serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue) }).catch(() => { });
      }
    }
    await setStatus(msg.mixGeneratedFrom(sanitizeTitle(randomSong.title)));
  } catch (e) {
    console.error('Mix error:', e);
    await setStatus(msg.MIX_ERROR);
  } finally {
    serverQueue.isTaskRunning = false;
  }
}

async function handleReplay(interaction, serverQueue, guildId, deps) {
  const result = await audioOperationBarrier.run(guildId, 'replay', async () => {
    if (serverQueue.sessionRestored && !serverQueue.currentDeckLoaded && serverQueue.songs.length > 0) {
      serverQueue.sessionRestored = false;
      serverQueue.isPaused = false;
      const connected = await deps.connectToVoice(serverQueue, interaction);
      if (connected) await audio.playSong(guildId, interaction);
      return;
    }
    if (serverQueue.currentDeckLoaded) {
      await audio.restartCurrentSong(guildId);
      return;
    }
    if (serverQueue.songs.length > 0) {
      serverQueue.playIndex = 0;
      const connected = await deps.connectToVoice(serverQueue, interaction);
      if (connected) await audio.playSong(guildId, interaction);
    }
  }, AUDIO_OP_OPTIONS);

  if (!result.success && !result.throttled) {
    console.error('❌ [REPLAY] Error:', result.error?.message);
  }
}

async function handleSkip(interaction, serverQueue, guildId, deps) {
  const result = await audioOperationBarrier.run(guildId, 'skip', async () => {
    if (serverQueue.sessionRestored && !serverQueue.currentDeckLoaded && serverQueue.songs.length > 1) {
      serverQueue.sessionRestored = false;
      serverQueue.isPaused = false;
      await audio.playSong(guildId);
      return;
    }
    // Nothing is playing and there is no mixer: start from the current song
    if (!serverQueue.currentDeckLoaded && !serverQueue.mixer?.isProcessAlive?.() && serverQueue.songs.length > 0) {
      const connected = await deps.connectToVoice(serverQueue, interaction);
      if (connected) await audio.playSong(guildId, interaction);
      return;
    }
    await audio.skipNext(guildId);
  }, AUDIO_OP_OPTIONS);

  if (!result.success && !result.throttled) {
    console.error('❌ [SKIP] Error:', result.error?.message);
    await safeReply(interaction, { content: msg.SKIP_FAILED, flags: MessageFlags.Ephemeral });
  }
}

async function handlePrev(interaction, serverQueue, guildId, deps) {
  const result = await audioOperationBarrier.run(guildId, 'prev', async () => {
    if (!serverQueue.currentDeckLoaded && !serverQueue.mixer?.isProcessAlive?.() && serverQueue.songs.length > 0) {
      if (serverQueue.sessionRestored && (serverQueue.playIndex || 0) > 0) {
        serverQueue.playIndex -= 1;
      }
      const connected = await deps.connectToVoice(serverQueue, interaction);
      if (connected) await audio.playSong(guildId, interaction);
      return;
    }
    await audio.skipPrev(guildId);
  }, AUDIO_OP_OPTIONS);

  if (!result.success && !result.throttled) {
    console.error('❌ [PREV] Error:', result.error?.message);
  }
}

async function handleSelectQueue(interaction, serverQueue, guildId) {
  const result = await audioOperationBarrier.run(guildId, 'skipToIndex', async () => {
    const targetIdx = safeParseInt(interaction.values[0], -1);
    if (targetIdx < 0) return;
    await audio.skipToIndex(guildId, targetIdx);
  }, AUDIO_OP_OPTIONS);

  if (!result.success && !result.throttled) {
    console.error('❌ [SELECT-QUEUE] Error:', result.error?.message);
  }
}

async function handleLoop(interaction, serverQueue, guildId) {
  serverQueue.loopEnabled = !serverQueue.loopEnabled;
  if (serverQueue.mixer?.isProcessAlive?.()) {
    try { serverQueue.mixer.setLoop(serverQueue.loopEnabled); } catch { /* mixer just died: state resyncs on restart */ }
  }
  saveQueueState(guildId, serverQueue);
  await refreshComponents(interaction, serverQueue);
}

async function handleShuffle(interaction, serverQueue, guildId) {
  if (serverQueue.songs.length < 2) {
    await interaction.deferUpdate().catch(() => { });
    return;
  }

  // Cancel pending deferred transition before shuffle
  if (serverQueue.pendingTransition) {
    if (serverQueue.pendingTransition._cleanupTimer) clearTimeout(serverQueue.pendingTransition._cleanupTimer);
    serverQueue.pendingTransition = null;
  }

  // Only the part of the queue after the current song is shuffled
  const currentIdx = serverQueue.playIndex || 0;
  const played = serverQueue.songs.slice(0, currentIdx + 1);
  const upcoming = serverQueue.songs.slice(currentIdx + 1);
  for (let i = upcoming.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
  }
  serverQueue.songs = [...played, ...upcoming];
  serverQueue.nextDeckLoaded = null;
  serverQueue.nextDeckTarget = null;

  saveQueueState(guildId, serverQueue);
  await refreshComponents(interaction, serverQueue);
  await audio.updatePreloadAfterQueueChange(guildId);
}

async function handleFade(interaction, serverQueue, guildId) {
  serverQueue.fadeEnabled = !serverQueue.fadeEnabled;
  saveQueueState(guildId, serverQueue);
  await refreshComponents(interaction, serverQueue);
}

async function handleLyrics(interaction, serverQueue) {
  // Editable ephemeral reply: deferReply + editReply (ephemeral followUps cannot be modified).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });

  const song = getCurrentSong(serverQueue);
  if (!song || !song.title) {
    await interaction.editReply({ content: msg.NO_SONG_PLAYING }).catch(() => { });
    return;
  }

  const title = sanitizeTitle(song.title);
  await interaction.editReply({ content: msg.lyricsSearching(title) }).catch(() => { });

  let lyrics = null;
  try {
    lyrics = await getLyrics(song);
  } catch (e) {
    console.error('❌ [LYRICS] Error fetching lyrics:', e.message);
  }

  if (!lyrics) {
    await interaction.editReply({ content: msg.lyricsNotFound(title) }).catch(() => { });
    return;
  }

  const header = msg.lyricsHeader(title);
  // First chunk carries the header: leave margin to stay under the length limit.
  const chunks = chunkLyrics(lyrics, MESSAGE_MAX_LENGTH - header.length - 10);

  await interaction.editReply({ content: header + chunks[0] }).catch(() => { });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral }).catch(() => { });
  }
}

// ─── Button dispatch table ──────────────────────────────────

const BUTTON_HANDLERS = {
  btn_clear_queue: handleClearQueue,
  btn_pause: handlePause,
  btn_yt_mix: handleYtMix,
  btn_replay: handleReplay,
  btn_skip: handleSkip,
  btn_prev: handlePrev,
  select_queue: handleSelectQueue,
  btn_loop: handleLoop,
  btn_shuffle: handleShuffle,
  btn_fade: handleFade,
  btn_lyrics: handleLyrics
};

// Buttons that answer with their own interaction response, so the dispatcher
// must NOT consume it with a deferUpdate() first.
const SELF_RESPONDING_BUTTONS = new Set([
  'btn_loop', 'btn_shuffle', 'btn_fade',   // reply via interaction.update()
  'btn_lyrics',                            // replies via deferReply()
  'plist_create', 'plist_search_server'    // open a modal
]);

/**
 * True when the customId belongs to a button that opens a modal or replies on
 * its own; those must reach their handler with the interaction untouched.
 * @param {string} customId
 * @returns {boolean}
 */
function isSelfResponding(customId) {
  return SELF_RESPONDING_BUTTONS.has(customId)
    || customId.startsWith('plist_rename_likes_')
    || customId.startsWith('plist_search_likes_');
}

// ─── Main Dispatcher ────────────────────────────────────────

export default function registerInteractionHandlers(client, deps) {
  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isChatInputCommand()) {
        const commands = await import('../commands/index.js');
        const cmd = commands[interaction.commandName];
        if (cmd && typeof cmd.execute === 'function') {
          try { await cmd.execute(interaction, deps); } catch (e) { console.error('Command execute error:', e); }
        }
        return;
      }

      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const guildId = interaction.guildId;
        const customId = interaction.customId;

        // Quick path for the "add song" modal
        if (customId === 'btn_add_modal') {
          const modal = new ModalBuilder().setCustomId('modal_add_song').setTitle('Aggiungi canzone');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('song_input').setLabel('Link o nome').setStyle(TextInputStyle.Short)
          ));
          await interaction.showModal(modal);
          return;
        }

        if (!isSelfResponding(customId)) {
          await interaction.deferUpdate().catch(() => { });
        }

        const cooldownKey = `${guildId}_${interaction.user.id}`;
        const now = Date.now();
        if (now - (interactionCooldowns.get(cooldownKey) || 0) < INTERACTION_COOLDOWN_MS) return;
        interactionCooldowns.set(cooldownKey, now);

        const serverQueue = await deps.ensureBotConnection(interaction);
        if (!serverQueue) return;
        if (!serverQueue.dashboardMessage && interaction.message) serverQueue.dashboardMessage = interaction.message;

        // Try playlist handlers first
        try {
          if (await handlePlaylist(interaction, serverQueue, guildId, customId, deps)) return;
        } catch (e) {
          console.error(`❌ [PLAYLIST-HANDLER] Error (${customId}):`, e);
          return;
        }

        const handler = BUTTON_HANDLERS[customId];
        if (handler) {
          try { await handler(interaction, serverQueue, guildId, deps); }
          catch (e) { console.error(`❌ [BUTTON-HANDLER] Error (${customId}):`, e); }
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        try { await handleModal(interaction, interaction.guildId, deps); }
        catch (e) { console.error(`❌ [MODAL-HANDLER] Error (${interaction.customId}):`, e); }
      }
    } catch (e) {
      console.error('Handler error:', e);
    }
  });
}
