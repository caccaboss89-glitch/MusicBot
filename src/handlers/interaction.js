import { Events, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { interactionCooldowns } from '../state/globals.js';
import { audioOperationBarrier } from './AudioOperationBarrier.js';
import * as audio from '../audio/index.js';
import { getCurrentSong, clearFinishedQueue, clearDeckBindings, bindDeckSong } from '../queue/QueueManager.js';
import { createDashboardComponents } from '../ui/index.js';
import { sanitizeTitle, areSameSong, safeParseInt, getYoutubeId } from '../utils/sanitize.js';
import { getVideoInfo } from '../utils/youtube.js';
import { loadDatabase } from '../database/playlists.js';
import { saveQueueState } from '../queue/persistence.js';
import { safeReply } from '../utils/discord.js';
import { MAX_QUEUE_SIZE } from '../../config/index.js';
import * as SkipManager from '../audio/SkipManager.js';
import { handlePlaylist } from './playlistHandlers.js';
import handleModal from './modalHandlers.js';

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
  try { await audio.updatePreloadAfterQueueChange(guildId); } catch { }
  if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(() => { });
}

async function handlePause(interaction, serverQueue, guildId, deps) {
  const result = await audio.togglePauseResume(guildId, serverQueue, { connectToVoice: deps.connectToVoice });
  if (!result.success) {
    console.error(`❌ [PAUSE-BUTTON] ${result.error}`);
    await safeReply(interaction, { content: `❌ Error during ${result.action === 'pause' ? 'pause' : 'resume'}.`, flags: MessageFlags.Ephemeral }).catch(() => { });
    return;
  }
  saveQueueState(guildId, serverQueue);
  try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); }
  catch { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(() => { }); }
}

async function handleYtMix(interaction, serverQueue, guildId, deps) {
  serverQueue.isTaskRunning = true;
  let statusMsg = null;
  try { statusMsg = await interaction.followUp({ content: '✨ **YouTube Mix generation in progress...**', flags: MessageFlags.Ephemeral }); } catch { }
  try {
    const db = loadDatabase();
    const currentSong = getCurrentSong(serverQueue);
    const seedSource = db.server.length > 0 ? db.server : (currentSong ? [currentSong] : serverQueue.history);
    if (!seedSource || seedSource.length === 0) { if (statusMsg) await statusMsg.edit({ content: '❌ At least one saved or playing song is needed to generate a Mix!' }).catch(() => { }); return; }
    const randomSong = seedSource[Math.floor(Math.random() * seedSource.length)];
    const videoId = getYoutubeId(randomSong.url);
    if (!videoId) throw new Error('Invalid video ID');
    const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    const songsFound = await getVideoInfo(mixUrl);
    if (songsFound && songsFound.length > 0) {
      const currentMixSong = getCurrentSong(serverQueue);
      if (currentMixSong && areSameSong(songsFound[0].url, currentMixSong.url)) songsFound.shift();
      if (serverQueue.songs.length + (serverQueue.history || []).length + songsFound.length > MAX_QUEUE_SIZE) { if (statusMsg) await statusMsg.edit({ content: '❌ **Limite Coda Raggiunto!**' }).catch(() => { }); return; }
      clearFinishedQueue(serverQueue);
      songsFound.forEach(s => serverQueue.songs.push({ ...s, requester: interaction.user.id }));
      saveQueueState(guildId, serverQueue);
      if (!serverQueue.currentDeckLoaded) {
        const connected = await deps.connectToVoice(serverQueue, interaction);
        if (connected) audio.playSong(interaction.guild.id);
      } else {
        if (serverQueue.nextDeckLoaded === null && serverQueue.songs.length >= 2) { await audio.updatePreloadAfterQueueChange(guildId); }
        if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(() => { });
      }
      if (statusMsg) await statusMsg.edit({ content: `✨ Generated YouTube Mix from: **${sanitizeTitle(randomSong.title)}**` }).catch(() => { });
    } else { if (statusMsg) await statusMsg.edit({ content: '❌ No songs found in Mix.' }).catch(() => { }); }
  } catch (e) {
    console.error('Mix error:', e);
    if (statusMsg) await statusMsg.edit({ content: '❌ Error during Mix generation.' }).catch(() => { });
  } finally { serverQueue.isTaskRunning = false; }
}

async function handleReplay(interaction, serverQueue, guildId, deps) {
  const result = await audioOperationBarrier.request(guildId, 'replay', async () => {
    if (serverQueue.sessionRestored && !serverQueue.currentDeckLoaded && serverQueue.songs && serverQueue.songs.length > 0) {
      serverQueue.sessionRestored = false; serverQueue.isPaused = false;
      const connected = await deps.connectToVoice(serverQueue, interaction);
      if (connected) await audio.playSong(interaction.guild.id, interaction);
      return;
    }
    if (serverQueue.currentDeckLoaded) {
      await audio.restartCurrentSong(interaction.guild.id);
    } else if (serverQueue.songs.length > 0) {
      serverQueue.playIndex = 0;
      serverQueue.currentDeckLoaded = null;
      const connected = await deps.connectToVoice(serverQueue, interaction);
      if (connected) await audio.playSong(interaction.guild.id, interaction);
    }
  }, { timeout: 10000, minThrottle: 2000 });

  if (!result.throttled && !result.success) {
    console.error('❌ [REPLAY] Error:', result.error?.message);
  }
}

async function handleSkip(interaction, serverQueue, guildId, deps) {
  const result = await audioOperationBarrier.request(guildId, 'skip', async () => {
    if (serverQueue.sessionRestored && !serverQueue.currentDeckLoaded && serverQueue.songs.length > 1) {
      serverQueue.sessionRestored = false; serverQueue.isPaused = false;
      await audio.playSong(interaction.guildId);
      return;
    }
    if (!serverQueue.currentDeckLoaded && (!serverQueue.mixer || !serverQueue.mixer.isProcessAlive())) {
      if (serverQueue.songs && serverQueue.songs.length > 0) {
        const connected = await deps.connectToVoice(serverQueue, interaction);
        if (connected) await audio.playSong(interaction.guildId, interaction);
        return;
      }
    }
    await SkipManager.skipNext(guildId);
  }, { timeout: 10000, minThrottle: 2000 });

  if (!result.throttled && !result.success) {
    console.error('❌ [SKIP] Error:', result.error?.message);
    await safeReply(interaction, { content: '❌ Unable to skip. Try again in a moment.', flags: MessageFlags.Ephemeral }).catch(() => { });
  }
}

async function handlePrev(interaction, serverQueue, guildId, deps) {
  const result = await audioOperationBarrier.request(guildId, 'prev', async () => {
    if (!serverQueue.currentDeckLoaded && (!serverQueue.mixer || !serverQueue.mixer.isProcessAlive())) {
      if (serverQueue.sessionRestored) {
        const newIndex = (serverQueue.playIndex || 0) - 1;
        if (newIndex >= 0) serverQueue.playIndex = newIndex;
      }
      if (serverQueue.songs && serverQueue.songs.length > 0) {
        const connected = await deps.connectToVoice(serverQueue, interaction);
        if (connected) await audio.playSong(interaction.guildId, interaction);
        return;
      }
    }
    await SkipManager.skipPrev(guildId);
  }, { timeout: 10000, minThrottle: 2000 });

  if (!result.throttled && !result.success) {
    console.error('❌ [PREV] Error:', result.error?.message);
  }
}

async function handleSelectQueue(interaction, serverQueue, guildId) {
  const result = await audioOperationBarrier.request(guildId, 'skipToIndex', async () => {
    const targetIdx = safeParseInt(interaction.values[0], -1);
    if (targetIdx < 0 || targetIdx >= serverQueue.songs.length) return;
    if (targetIdx === (serverQueue.playIndex || 0)) return;
    await SkipManager.skipToIndex(guildId, targetIdx);
  }, { timeout: 10000, minThrottle: 2000 });

  if (!result.throttled && !result.success) {
    console.error('❌ [SELECT-QUEUE] Error:', result.error?.message);
  }
}

async function handleLoop(interaction, serverQueue, guildId) {
  serverQueue.loopEnabled = !serverQueue.loopEnabled;
  if (serverQueue.mixer && serverQueue.mixer.isProcessAlive()) {
    try { serverQueue.mixer.setLoop(serverQueue.loopEnabled); } catch { }
  }
  saveQueueState(guildId, serverQueue);
  try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); }
  catch { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(() => { }); }
}

async function handleShuffle(interaction, serverQueue, guildId) {
  if (serverQueue.songs.length >= 2) {
    // Cancel pending deferred transition before shuffle
    if (serverQueue.pendingTransition) {
      if (serverQueue.pendingTransition._cleanupTimer) clearTimeout(serverQueue.pendingTransition._cleanupTimer);
      serverQueue.pendingTransition = null;
    }
    const currentIdx = serverQueue.playIndex || 0;
    const before = serverQueue.songs.slice(0, currentIdx + 1);
    const after = serverQueue.songs.slice(currentIdx + 1);
    for (let i = after.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[after[i], after[j]] = [after[j], after[i]]; }
    serverQueue.songs = [...before, ...after];
    serverQueue.nextDeckLoaded = null;
    serverQueue.nextDeckTarget = null;
    saveQueueState(guildId, serverQueue);
    try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); }
    catch { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(() => { }); }
    audio.updatePreloadAfterQueueChange(guildId).catch(() => { });
  } else { try { await interaction.deferUpdate(); } catch { } }
}

async function handleFade(interaction, serverQueue, guildId) {
  serverQueue.fadeEnabled = !serverQueue.fadeEnabled;
  saveQueueState(guildId, serverQueue);
  try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); }
  catch { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(() => { }); }
}

async function handleLyrics(interaction, serverQueue) {
  // Editable ephemeral reply: deferReply + editReply (ephemeral followUps cannot be modified).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });

  const song = getCurrentSong(serverQueue);
  if (!song || !song.title) {
    await interaction.editReply({ content: '❌ No song currently playing.' }).catch(() => { });
    return;
  }

  await interaction.editReply({ content: `🔎 Searching for lyrics of **${sanitizeTitle(song.title)}**...` }).catch(() => { });

  let lyrics = null;
  try {
    const { getLyrics } = await import('../utils/lyrics.js');
    lyrics = await getLyrics(song);
  } catch (e) {
    console.error('❌ [LYRICS] Error fetching lyrics:', e.message);
  }

  if (!lyrics) {
    await interaction.editReply({ content: `📜 Lyrics not found for **${sanitizeTitle(song.title)}**.` }).catch(() => { });
    return;
  }

  const { chunkLyrics } = await import('../utils/lyrics.js');
  const header = `📜 **${sanitizeTitle(song.title)}**\n\n`;
  // First chunk includes header: leave margin to not exceed 2000 characters.
  const chunks = chunkLyrics(lyrics, 2000 - header.length - 10);

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

// ─── Main Dispatcher ────────────────────────────────────────

export default function registerInteractionHandlers(client, deps) {
  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isChatInputCommand()) {
        let commands = {};
        try { const commandsModule = await import('../commands/index.js'); commands = commandsModule.default || commandsModule; } catch { }
        const cmd = commands[interaction.commandName];
        if (cmd && typeof cmd.execute === 'function') {
          try { await cmd.execute(interaction, deps); } catch (e) { console.error('Command execute error:', e); }
        }
        return;
      }

      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const guildId = interaction.guildId;
        const customId = interaction.customId;

        // Quick path for modal
        if (customId === 'btn_add_modal') {
          const modal = new ModalBuilder().setCustomId('modal_add_song').setTitle('Add Song');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('song_input').setLabel('Link or Name').setStyle(TextInputStyle.Short)));
          await interaction.showModal(modal);
          return;
        }

        // Defer update (except buttons with immediate update or modal-opening buttons)
        const immediateUpdateButtons = ['btn_loop', 'btn_shuffle', 'btn_fade'];
        const deferReplyButtons = ['btn_lyrics'];
        const modalButtons = ['plist_create', 'plist_search_server'];
        const isModalButton = modalButtons.includes(customId) || customId.startsWith('plist_rename_likes_') || customId.startsWith('plist_search_likes_');
        if (!immediateUpdateButtons.includes(customId) && !deferReplyButtons.includes(customId) && !isModalButton) {
          try { await interaction.deferUpdate(); } catch { }
        }

        const now = Date.now();
        const cooldownKey = `${guildId}_${interaction.user.id}`;
        if (interactionCooldowns.has(cooldownKey) && now < interactionCooldowns.get(cooldownKey) + 200) return;
        interactionCooldowns.set(cooldownKey, now);

        const serverQueue = await deps.ensureBotConnection(interaction);
        if (!serverQueue) return;
        if (!serverQueue.dashboardMessage && interaction.message) serverQueue.dashboardMessage = interaction.message;

        // Try playlist handlers first
        try {
          if (await handlePlaylist(interaction, serverQueue, guildId, customId, deps)) return;
        } catch (e) { console.error(`❌ [PLAYLIST-HANDLER] Error (${customId}):`, e); return; }

        // Then button handlers
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
        return;
      }
    } catch (e) { console.error('Handler error:', e); }
  });
}
