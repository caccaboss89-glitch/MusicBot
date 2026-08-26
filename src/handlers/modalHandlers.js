/**
 * Handler for modal submissions (search, create playlist, add song).
 * Extracted from interaction.js for modularity and crash-independence.
 */

import { MessageFlags } from 'discord.js';
import { loadDatabase, saveDatabase, getUserData, validatePlaylistName } from '../database/playlists.js';
import { generateSearchResultsView, createDashboardComponents } from '../ui/index.js';
import { getVideoInfo } from '../utils/youtube.js';
import { clearFinishedQueue, filterPlayableSongs } from '../queue/QueueManager.js';
import { saveQueueState } from '../queue/persistence.js';
import { DEFAULT_PLAYLIST_NAME, MAX_PLAYLISTS_PER_USER, MAX_SONG_DURATION_SECONDS } from '../../config/index.js';
import { activeSearches } from './playlistHandlers.js';
import * as audio from '../audio/index.js';
import {
  SEARCH_TERM_REQUIRED,
  SEARCH_ERROR,
  NO_RESULTS,
  songsAdded,
  allSongsRejected,
  rejectedSongsNotice,
  playlistLimitReached,
  playlistAlreadyExists,
  playlistCreated,
  PLAYLIST_CREATION_ERROR,
  defaultPlaylistNotRenamable,
  PLAYLIST_NOT_FOUND_ORIGINAL,
  playlistRenamed,
  PLAYLIST_RENAME_ERROR
} from '../ui/messages.js';

/**
 * Handles all modal submissions.
 */
async function handleModal(interaction, guildId, deps) {
  const modalCustomId = interaction.customId;

  // --- Search server playlist ---
  if (modalCustomId === 'modal_search_server') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const query = (interaction.fields.getTextInputValue('search_query_input') || '').trim();
      if (!query) return await interaction.editReply(SEARCH_TERM_REQUIRED);
      activeSearches.set(`${interaction.user.id}_server_`, query);
      return await interaction.editReply(generateSearchResultsView('server', interaction.user.id, query, 0));
    } catch (e) {
      console.error('❌ [MODAL_SEARCH_SERVER] Error:', e);
      return await interaction.editReply(SEARCH_ERROR);
    }
  }

  // --- Search personal playlist ---
  if (modalCustomId.startsWith('modal_search_likes_')) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const plName = modalCustomId.replace('modal_search_likes_', '');
      const query = (interaction.fields.getTextInputValue('search_query_input') || '').trim();
      if (!query) return await interaction.editReply(SEARCH_TERM_REQUIRED);
      activeSearches.set(`${interaction.user.id}_likes_${plName}`, query);
      return await interaction.editReply(generateSearchResultsView('likes', interaction.user.id, query, 0, plName));
    } catch (e) {
      console.error('❌ [MODAL_SEARCH_LIKES] Error:', e);
      return await interaction.editReply(SEARCH_ERROR);
    }
  }

  // --- Create playlist ---
  if (modalCustomId === 'modal_create_playlist') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const trimmedName = (interaction.fields.getTextInputValue('playlist_name_input') || '').trim();
      const validation = validatePlaylistName(trimmedName);
      if (!validation.valid) return await interaction.editReply(`❌ ${validation.error}`);
      const db = loadDatabase();
      const userData = getUserData(db, interaction.user.id);
      const playlistCount = Object.keys(userData.playlists).length;
      if (playlistCount >= MAX_PLAYLISTS_PER_USER) {
        return await interaction.editReply(playlistLimitReached(MAX_PLAYLISTS_PER_USER));
      }
      const existingNames = Object.keys(userData.playlists).map(n => n.toLowerCase());
      if (existingNames.includes(trimmedName.toLowerCase())) {
        return await interaction.editReply(playlistAlreadyExists(trimmedName));
      }
      userData.playlists[trimmedName] = [];
      userData.activePlaylist = trimmedName;
      saveDatabase(db);
      return await interaction.editReply(playlistCreated(trimmedName));
    } catch (e) {
      console.error('❌ [MODAL_CREATE_PLAYLIST] Error:', e);
      return await interaction.editReply(PLAYLIST_CREATION_ERROR);
    }
  }

  // --- Rename playlist ---
  if (modalCustomId.startsWith('modal_rename_playlist_')) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const oldName = modalCustomId.replace('modal_rename_playlist_', '');
      if (oldName === DEFAULT_PLAYLIST_NAME) {
        return await interaction.editReply(defaultPlaylistNotRenamable(DEFAULT_PLAYLIST_NAME));
      }
      const trimmedName = (interaction.fields.getTextInputValue('playlist_name_input') || '').trim();
      const validation = validatePlaylistName(trimmedName);
      if (!validation.valid) return await interaction.editReply(`❌ ${validation.error}`);
      const db = loadDatabase();
      const userData = getUserData(db, interaction.user.id);
      if (!userData.playlists[oldName]) return await interaction.editReply(PLAYLIST_NOT_FOUND_ORIGINAL);
      const existingNames = Object.keys(userData.playlists).filter(n => n !== oldName).map(n => n.toLowerCase());
      if (existingNames.includes(trimmedName.toLowerCase())) {
        return await interaction.editReply(playlistAlreadyExists(trimmedName));
      }
      userData.playlists[trimmedName] = userData.playlists[oldName];
      delete userData.playlists[oldName];
      if (userData.activePlaylist === oldName) userData.activePlaylist = trimmedName;
      saveDatabase(db);
      return await interaction.editReply(playlistRenamed(oldName, trimmedName));
    } catch (e) {
      console.error('❌ [MODAL_RENAME_PLAYLIST] Error:', e);
      return await interaction.editReply(PLAYLIST_RENAME_ERROR);
    }
  }

  // --- Add song (modal_add_song) ---
  const serverQueue = await deps.ensureBotConnection(interaction);
  if (!serverQueue) return;

  // The flag is raised inside the try: deferReply rejects on an expired
  // interaction, and leaving it set would block /play for the whole session.
  serverQueue.isTaskRunning = true;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let found = [];
    try {
      found = await getVideoInfo(interaction.fields.getTextInputValue('song_input'));
    } catch (e) {
      console.error('❌ [MODAL_ADD_SONG] Search error:', e.message);
      return interaction.editReply(SEARCH_ERROR);
    }

    if (found.length === 0) return interaction.editReply(NO_RESULTS);

    // Same acceptance rules as /play: no live streams, nothing over the limit
    const maxMinutes = MAX_SONG_DURATION_SECONDS / 60;
    const { accepted, tooLong, live } = filterPlayableSongs(found);
    if (accepted.length === 0) return interaction.editReply(allSongsRejected(maxMinutes));
    const rejectedNotice = rejectedSongsNotice(tooLong, live, maxMinutes);

    clearFinishedQueue(serverQueue);
    accepted.forEach(s => serverQueue.songs.push({ ...s, requester: interaction.user.id }));
    saveQueueState(guildId, serverQueue);

    // A deck marked as loaded without a live audio chain is stale state left by
    // a crash or a disconnect: drop it so playback restarts from scratch.
    const audioChainBroken = !!serverQueue.currentDeckLoaded &&
      (!serverQueue.connection || !serverQueue.mixer || !serverQueue.player);
    const memberInVoice = !!interaction.member?.voice?.channel;
    let started = false;

    if ((!serverQueue.currentDeckLoaded || audioChainBroken) && memberInVoice) {
      if (audioChainBroken) {
        serverQueue.currentDeckLoaded = null;
        serverQueue.nextDeckLoaded = null;
        if (serverQueue.mixer) {
          try { serverQueue.mixer.kill(); } catch { /* already dead */ }
          serverQueue.mixer = null;
        }
      }
      if (!serverQueue.connection) await deps.connectToVoice(serverQueue, interaction);
      try {
        await audio.playSong(guildId, interaction);
        started = true;
      } catch (e) {
        console.error('playSong error after modal add', e);
      }
    }

    // playSong() already schedules the preload cycle: only refresh it when we
    // appended to a queue that was already playing.
    if (!started) await audio.updatePreloadAfterQueueChange(guildId);

    if (serverQueue.dashboardMessage) {
      await serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue) }).catch(() => { });
    }
    if (accepted.length > 1 || rejectedNotice) {
      return interaction.editReply(songsAdded(accepted.length) + rejectedNotice);
    }
    return interaction.deleteReply().catch(() => { });
  } finally { serverQueue.isTaskRunning = false; }
}

export default handleModal;
