/**
 * Handler for playlist-related interactions (buttons, select menu, search).
 * Extracted from interaction.js for modularity and crash-independence.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { loadDatabase, saveDatabase, getUserData, getUserPlaylist, getActivePlaylistName, setActivePlaylist } from '../database/playlists.js';
import { generatePlaylistView, generateSearchResultsView, createDashboardComponents } from '../ui/index.js';
import { sanitizeTitle, areSameSong, safeParseInt } from '../utils/sanitize.js';
import { clearFinishedQueue, insertSongAtIndex, getCurrentSong, filterPlayableSongs, songRejectionReason } from '../queue/QueueManager.js';
import { saveQueueState } from '../queue/persistence.js';
import { safeReply } from '../utils/discord.js';
import { DEFAULT_PLAYLIST_NAME, MAX_PLAYLIST_NAME_LENGTH, MAX_SONG_DURATION_SECONDS } from '../../config/index.js';
import * as audio from '../audio/index.js';
import { recordPlaylistAdd } from '../database/stats.js';
import {
  SONG_NOT_FOUND,
  PLAYLIST_EMPTY,
  PLAYLIST_NOT_FOUND,
  defaultPlaylistNotDeletable,
  defaultPlaylistNotRenamable,
  ACTION_TITLE,
  PLAY_BUTTON,
  REMOVE_BUTTON,
  BACK_MODAL_BUTTON,
  playlistSongsAdded,
  allSongsRejected,
  rejectedSongsNotice,
  songTooLong,
  SONG_IS_LIVE,
  SEARCH_MODAL_TITLE_SERVER,
  SEARCH_MODAL_TITLE_USER,
  SEARCH_SONG_LABEL,
  SEARCH_SONG_PLACEHOLDER,
  CREATE_PLAYLIST_TITLE,
  createPlaylistLabel,
  PLAYLIST_NAME_PLACEHOLDER,
  RENAME_PLAYLIST_TITLE,
  renamePlaylistLabel,
  DELETE_CONFIRMATION_TITLE,
  deleteConfirmationMessage,
  CONFIRM_BUTTON,
  CANCEL_BUTTON,
  playlistDeleted,
  songRemovedFromPlaylist,
  songAddedToPlaylist,
  songStartedPlaying,
  songAddedAsNext
} from '../ui/messages.js';

// In-memory map for active search queries (for result pagination)
const activeSearches = new Map();

// Periodic cleanup to prevent memory leak (every 30 minutes)
setInterval(() => {
  activeSearches.clear();
}, 30 * 60 * 1000);

/**
 * Handles all playlist interactions (plist_*, act_*, srch_*, open_plist_*, btn_toggle_*).
 * Deletion of a personal playlist requires confirmation (plist_delete_confirm / cancel).
 * @returns {boolean} true if the interaction was handled
 */
async function handlePlaylist(interaction, serverQueue, guildId, customId, deps) {
  // --- Playlist: song selection ---
  if (customId === 'plist_select_song') {
    const rawValue = interaction.values[0];
    const parts = rawValue.split('_');
    let items, songType, songIndex, songPage, plName;

    if (parts[0] === 'server') {
      songType = 'server';
      songIndex = safeParseInt(parts[1], -1);
      songPage = parts[2];
      plName = null;
      items = loadDatabase().server;
    } else {
      songType = 'likes';
      plName = parts[1];
      songIndex = safeParseInt(parts[2], -1);
      songPage = parts[3];
      items = getUserPlaylist(loadDatabase(), interaction.user.id, plName);
    }

    if (songIndex < 0 || songIndex >= items.length) return await safeReply(interaction, { content: SONG_NOT_FOUND, flags: MessageFlags.Ephemeral }), true;

    const song = items[songIndex];
    const embed = new EmbedBuilder().setColor(0xFFAA00).setTitle(ACTION_TITLE).setDescription(`**${sanitizeTitle(song.title)}**`);

    let playId, removeId, backId;
    if (songType === 'server') {
      playId = `act_play_server_${songIndex}`;
      removeId = `act_remove_server_${songIndex}_${songPage}`;
      backId = `act_back_server_${songPage}`;
    } else {
      playId = `act_play_likes_${plName}_${songIndex}`;
      removeId = `act_remove_likes_${plName}_${songIndex}_${songPage}`;
      backId = `act_back_likes_${plName}_${songPage}`;
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(playId).setLabel(PLAY_BUTTON).setEmoji('▶️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(removeId).setLabel(REMOVE_BUTTON).setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(backId).setLabel(BACK_MODAL_BUTTON).setEmoji('🔙').setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return true;
  }

  // --- Playlist: change active playlist ---
  if (customId === 'plist_switch_likes') {
    const selectedName = interaction.values[0];
    const db = loadDatabase();
    setActivePlaylist(db, interaction.user.id, selectedName);
    saveDatabase(db);
    await interaction.editReply(generatePlaylistView('likes', interaction.user.id, 0, selectedName));
    return true;
  }

  // --- Playlist: play all ---
  if (customId && customId.startsWith('plist_playall_')) {
    const parts = customId.split('_');
    const type = parts[2];
    const db = loadDatabase();
    let items;
    if (type === 'server') {
      items = db.server;
    } else {
      const plName = parts.slice(3).join('_');
      items = getUserPlaylist(db, interaction.user.id, plName);
    }
    if (!items || items.length === 0) return await safeReply(interaction, { content: PLAYLIST_EMPTY, flags: MessageFlags.Ephemeral }), true;

    // A playlist can hold entries saved before the length limit existed
    const maxMinutes = MAX_SONG_DURATION_SECONDS / 60;
    const { accepted, tooLong, live } = filterPlayableSongs(items);
    if (accepted.length === 0) return await safeReply(interaction, { content: allSongsRejected(maxMinutes), flags: MessageFlags.Ephemeral }), true;

    const toAdd = accepted.map(s => ({ ...s, requester: interaction.user.id }));
    for (let i = toAdd.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [toAdd[i], toAdd[j]] = [toAdd[j], toAdd[i]];
    }
    clearFinishedQueue(serverQueue);
    toAdd.forEach(s => serverQueue.songs.push(s));
    saveQueueState(guildId, serverQueue);
    if (!serverQueue.currentDeckLoaded) {
      const connected = await deps.connectToVoice(serverQueue, interaction);
      if (connected) await audio.playSong(interaction.guild.id, interaction);
    } else {
      await audio.updatePreloadAfterQueueChange(guildId);
      if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue) }).catch(() => { });
    }
    const notice = rejectedSongsNotice(tooLong, live, maxMinutes);
    await safeReply(interaction, { content: playlistSongsAdded(toAdd.length) + notice, flags: MessageFlags.Ephemeral });
    return true;
  }

  // --- Playlist: page navigation ---
  if (customId && (customId.startsWith('plist_prev_') || customId.startsWith('plist_next_'))) {
    const parts = customId.split('_');
    const dir = parts[1];
    const type = parts[2];
    let newPage, plName = null;
    if (type === 'server') {
      newPage = (dir === 'prev' ? -1 : 1) + safeParseInt(parts[3], 0);
    } else {
      plName = parts[3];
      newPage = (dir === 'prev' ? -1 : 1) + safeParseInt(parts[4], 0);
    }
    await interaction.editReply(generatePlaylistView(type, interaction.user.id, newPage, plName));
    return true;
  }

  // --- Playlist actions (play/remove/back) ---
  if (customId && customId.startsWith('act_')) {
    const parts = customId.split('_');

    if (parts[1] === 'back') {
      if (parts[2] === 'server') {
        await interaction.editReply(generatePlaylistView('server', interaction.user.id, safeParseInt(parts[3], 0)));
      } else {
        await interaction.editReply(generatePlaylistView('likes', interaction.user.id, safeParseInt(parts[4], 0), parts[3]));
      }
      return true;
    }

    if (parts[1] === 'remove') {
      const db = loadDatabase();
      if (parts[2] === 'server') {
        const index = safeParseInt(parts[3], -1);
        const page = safeParseInt(parts[4], 0);
        if (index < 0) return true;
        if (index < db.server.length) db.server.splice(index, 1);
        saveDatabase(db);
        await interaction.editReply(generatePlaylistView('server', interaction.user.id, page));
      } else {
        const plName = parts[3];
        const index = safeParseInt(parts[4], -1);
        const page = safeParseInt(parts[5], 0);
        if (index < 0) return true;
        const userData = getUserData(db, interaction.user.id);
        if (userData.playlists[plName] && index < userData.playlists[plName].length) {
          userData.playlists[plName].splice(index, 1);
        }
        saveDatabase(db);
        await interaction.editReply(generatePlaylistView('likes', interaction.user.id, page, plName));
      }
      return true;
    }

    if (parts[1] === 'play') {
      let items, songIndex;
      if (parts[2] === 'server') {
        items = loadDatabase().server;
        songIndex = safeParseInt(parts[3], -1);
      } else {
        const plName = parts[3];
        items = getUserPlaylist(loadDatabase(), interaction.user.id, plName);
        songIndex = safeParseInt(parts[4], -1);
      }
      if (songIndex < 0 || songIndex >= items.length) return true;
      const song = items[songIndex];

      const reason = songRejectionReason(song);
      if (reason) {
        const content = reason === 'live' ? SONG_IS_LIVE : songTooLong(MAX_SONG_DURATION_SECONDS / 60);
        await safeReply(interaction, { content, flags: MessageFlags.Ephemeral });
        return true;
      }

      const playObj = { ...song, requester: interaction.user.id };

      clearFinishedQueue(serverQueue);
      if (serverQueue.songs.length === 0) {
        serverQueue.songs.push(playObj);
        if (!serverQueue.currentDeckLoaded) {
          const connected = await deps.connectToVoice(serverQueue, interaction);
          if (connected) await audio.playSong(interaction.guild.id, interaction);
        }
        await safeReply(interaction, { content: songStartedPlaying(sanitizeTitle(song.title)), flags: MessageFlags.Ephemeral });
      } else {
        const insertAt = (serverQueue.playIndex || 0) + 1;
        const inserted = insertSongAtIndex(serverQueue, playObj, insertAt);
        if (!inserted.success) {
          await safeReply(interaction, { content: SONG_NOT_FOUND, flags: MessageFlags.Ephemeral });
          return true;
        }
        await audio.updatePreloadAfterQueueChange(guildId);
        if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue) }).catch(() => { });
        await safeReply(interaction, { content: songAddedAsNext(sanitizeTitle(song.title)), flags: MessageFlags.Ephemeral });
      }
      return true;
    }

    return true;
  }

  // --- Search in playlist (opens modal) ---
  if (customId === 'plist_search_server') {
    const modal = new ModalBuilder().setCustomId('modal_search_server').setTitle(SEARCH_MODAL_TITLE_SERVER);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('search_query_input').setLabel(SEARCH_SONG_LABEL)
        .setStyle(TextInputStyle.Short).setMaxLength(50).setPlaceholder(SEARCH_SONG_PLACEHOLDER).setRequired(true)
    ));
    await interaction.showModal(modal);
    return true;
  }

  if (customId && customId.startsWith('plist_search_likes_')) {
    const plName = customId.replace('plist_search_likes_', '');
    const modal = new ModalBuilder().setCustomId(`modal_search_likes_${plName}`).setTitle(SEARCH_MODAL_TITLE_USER);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('search_query_input').setLabel(SEARCH_SONG_LABEL)
        .setStyle(TextInputStyle.Short).setMaxLength(50).setPlaceholder(SEARCH_SONG_PLACEHOLDER).setRequired(true)
    ));
    await interaction.showModal(modal);
    return true;
  }

  // --- Search results navigation ---
  if (customId && (customId.startsWith('srch_prev_') || customId.startsWith('srch_next_'))) {
    const parts = customId.split('_');
    const dir = parts[1];
    const type = parts[2];
    let newPage, plName = null;
    if (type === 'server') {
      newPage = (dir === 'prev' ? -1 : 1) + safeParseInt(parts[3], 0);
    } else {
      plName = parts[3];
      newPage = (dir === 'prev' ? -1 : 1) + safeParseInt(parts[4], 0);
    }
    const searchKey = `${interaction.user.id}_${type}_${plName || ''}`;
    const query = activeSearches.get(searchKey);
    if (!query) {
      await interaction.editReply(generatePlaylistView(type, interaction.user.id, 0, plName));
      return true;
    }
    await interaction.editReply(generateSearchResultsView(type, interaction.user.id, query, newPage, plName));
    return true;
  }

  if (customId && customId.startsWith('srch_back_')) {
    const parts = customId.split('_');
    const type = parts[2];
    let plName = null;
    if (type === 'likes') plName = parts.slice(3).join('_');
    activeSearches.delete(`${interaction.user.id}_${type}_${plName || ''}`);
    await interaction.editReply(generatePlaylistView(type, interaction.user.id, 0, plName));
    return true;
  }

  // --- Create new playlist ---
  if (customId === 'plist_create') {
    const modal = new ModalBuilder().setCustomId('modal_create_playlist').setTitle(CREATE_PLAYLIST_TITLE);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('playlist_name_input')
        .setLabel(createPlaylistLabel(MAX_PLAYLIST_NAME_LENGTH))
        .setStyle(TextInputStyle.Short).setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
        .setPlaceholder(PLAYLIST_NAME_PLACEHOLDER).setRequired(true)
    ));
    await interaction.showModal(modal);
    return true;
  }

  // --- Delete playlist: confirmation request ---
  if (customId && customId.startsWith('plist_delete_likes_')) {
    const plName = customId.replace('plist_delete_likes_', '');
    if (plName === DEFAULT_PLAYLIST_NAME) {
      await safeReply(interaction, { content: defaultPlaylistNotDeletable(DEFAULT_PLAYLIST_NAME), flags: MessageFlags.Ephemeral });
      return true;
    }
    const db = loadDatabase();
    const userData = getUserData(db, interaction.user.id);
    if (!userData.playlists[plName]) {
      await safeReply(interaction, { content: PLAYLIST_NOT_FOUND, flags: MessageFlags.Ephemeral });
      return true;
    }
    const songCount = userData.playlists[plName].length;
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle(DELETE_CONFIRMATION_TITLE)
      .setDescription(deleteConfirmationMessage(plName, songCount));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`plist_delete_confirm_likes_${plName}`).setLabel(CONFIRM_BUTTON).setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`plist_delete_cancel_likes_${plName}`).setLabel(CANCEL_BUTTON).setEmoji('🔙').setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return true;
  }

  // --- Delete playlist: confirm ---
  if (customId && customId.startsWith('plist_delete_confirm_likes_')) {
    const plName = customId.replace('plist_delete_confirm_likes_', '');
    if (plName === DEFAULT_PLAYLIST_NAME) {
      await safeReply(interaction, { content: defaultPlaylistNotDeletable(DEFAULT_PLAYLIST_NAME), flags: MessageFlags.Ephemeral });
      return true;
    }
    const db = loadDatabase();
    const userData = getUserData(db, interaction.user.id);
    if (!userData.playlists[plName]) {
      await safeReply(interaction, { content: PLAYLIST_NOT_FOUND, flags: MessageFlags.Ephemeral });
      await interaction.editReply(generatePlaylistView('likes', interaction.user.id, 0, DEFAULT_PLAYLIST_NAME));
      return true;
    }
    const deletedCount = userData.playlists[plName].length;
    delete userData.playlists[plName];
    if (userData.activePlaylist === plName) userData.activePlaylist = DEFAULT_PLAYLIST_NAME;
    // Clean active searches related to this playlist
    activeSearches.delete(`${interaction.user.id}_likes_${plName}`);
    saveDatabase(db);
    await interaction.editReply(generatePlaylistView('likes', interaction.user.id, 0, DEFAULT_PLAYLIST_NAME));
    await safeReply(interaction, { content: playlistDeleted(plName, deletedCount), flags: MessageFlags.Ephemeral });
    return true;
  }

  // --- Delete playlist: cancel ---
  if (customId && customId.startsWith('plist_delete_cancel_likes_')) {
    const plName = customId.replace('plist_delete_cancel_likes_', '');
    const db = loadDatabase();
    const userData = getUserData(db, interaction.user.id);
    const targetPl = userData.playlists[plName] ? plName : DEFAULT_PLAYLIST_NAME;
    await interaction.editReply(generatePlaylistView('likes', interaction.user.id, 0, targetPl));
    return true;
  }

  // --- Rename playlist (opens modal) ---
  if (customId && customId.startsWith('plist_rename_likes_')) {
    const plName = customId.replace('plist_rename_likes_', '');
    if (plName === DEFAULT_PLAYLIST_NAME) {
      await safeReply(interaction, { content: defaultPlaylistNotRenamable(DEFAULT_PLAYLIST_NAME), flags: MessageFlags.Ephemeral });
      return true;
    }
    const modal = new ModalBuilder().setCustomId(`modal_rename_playlist_${plName}`).setTitle(RENAME_PLAYLIST_TITLE);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('playlist_name_input')
        .setLabel(renamePlaylistLabel(MAX_PLAYLIST_NAME_LENGTH))
        .setStyle(TextInputStyle.Short).setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
        .setValue(plName).setRequired(true)
    ));
    await interaction.showModal(modal);
    return true;
  }

  // --- Open server/personal playlist ---
  if (customId === 'open_plist_server') {
    await safeReply(interaction, generatePlaylistView('server', interaction.user.id, 0));
    return true;
  }
  if (customId === 'open_plist_likes') {
    const dbLikes = loadDatabase();
    const activePl = getActivePlaylistName(dbLikes, interaction.user.id);
    await safeReply(interaction, generatePlaylistView('likes', interaction.user.id, 0, activePl));
    return true;
  }

  // --- Toggle song in server playlist ---
  if (customId === 'btn_toggle_server') {
    const song = getCurrentSong(serverQueue);
    if (!song) return true;
    const db = loadDatabase();
    const idx = (db.server || []).findIndex(x => areSameSong(x.url, song.url));
    if (idx !== -1) {
      db.server.splice(idx, 1);
    } else {
      if (!db.server) db.server = [];
      db.server.push({ ...song, addedBy: interaction.user.id });
      recordPlaylistAdd(interaction.user.id, 'server');
    }
    saveDatabase(db);
    if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue) }).catch(() => { });
    return true;
  }

  // --- Toggle song in personal playlist ---
  if (customId === 'btn_toggle_like') {
    const song = getCurrentSong(serverQueue);
    if (!song) return true;
    const db = loadDatabase();
    const userData = getUserData(db, interaction.user.id);
    const activePlName = userData.activePlaylist || DEFAULT_PLAYLIST_NAME;
    if (!userData.playlists[activePlName]) userData.playlists[activePlName] = [];
    const playlist = userData.playlists[activePlName];
    const idx = playlist.findIndex(x => areSameSong(x.url, song.url));
    if (idx !== -1) {
      playlist.splice(idx, 1);
      await safeReply(interaction, { content: songRemovedFromPlaylist(activePlName), flags: MessageFlags.Ephemeral });
    } else {
      playlist.push({ ...song });
      await safeReply(interaction, { content: songAddedToPlaylist(activePlName), flags: MessageFlags.Ephemeral });
      recordPlaylistAdd(interaction.user.id, 'personal');
    }
    saveDatabase(db);
    return true;
  }

  return false;
}

export { handlePlaylist, activeSearches };
