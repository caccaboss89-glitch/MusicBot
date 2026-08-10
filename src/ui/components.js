/**
 * src/ui/components.js
 * Functions for creating Discord components (buttons, menus)
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  EmbedBuilder
} from 'discord.js';
import { sanitizeTitle } from '../utils/sanitize.js';
import { areSameSong } from '../utils/sanitize.js';
import { getCurrentSong, getPlayingIndex, isValidSong } from '../queue/QueueManager.js';
import { loadDatabase, getUserData, getUserPlaylistNames } from '../database/playlists.js';
import { PLAYLIST_PAGE_SIZE, DEFAULT_PLAYLIST_NAME } from '../../config/index.js';

/**
 * Generates playlist view with pagination
 * @param {string} type - 'server' or 'likes'
 * @param {string} userId - User ID (for personal playlist)
 * @param {number} page - Page number
 * @param {string|null} playlistName - Personal playlist name (only for type !== 'server')
 * @returns {Object} Object with embeds, components and flags
 */
function generatePlaylistView(type, userId, page, playlistName = null) {
  const db = loadDatabase();

  let items;
  let currentPlName = DEFAULT_PLAYLIST_NAME;

  if (type === 'server') {
    items = db.server || [];
  } else {
    // Personal playlist — get user data (with auto migration)
    const userData = getUserData(db, userId);
    currentPlName = playlistName || userData.activePlaylist || DEFAULT_PLAYLIST_NAME;
    items = userData.playlists[currentPlName] || [];
  }

  const totalItems = items.length;
  const itemsPerPage = PLAYLIST_PAGE_SIZE;
  const maxPage = Math.max(0, Math.ceil(totalItems / itemsPerPage) - 1);

  if (page < 0) page = maxPage;
  else if (page > maxPage) page = 0;
  page = Math.min(Math.max(0, page), maxPage);

  const start = page * itemsPerPage;
  const currentItems = items.slice(start, start + itemsPerPage);

  const description = currentItems.length > 0
    ? currentItems.map((s, i) => `**${start + i + 1}.** [${sanitizeTitle(s.title).substring(0, 60)}](${s.url})`).join('\n')
    : '📭 Nessuna canzone salvata.';

  const embed = new EmbedBuilder()
    .setColor(type === 'server' ? 0xFFAA00 : 0xFF00FF)
    .setTitle(type === 'server' ? `📂 Playlist Server (${totalItems})` : `👤 Playlist: ${currentPlName} (${totalItems})`)
    .setDescription(description)
    .setFooter({ text: `Pagina ${page + 1} di ${maxPage + 1}` });

  const components = [];

  // For personal playlists: add playlist selection row and management row
  if (type !== 'server') {
    const plNames = getUserPlaylistNames(db, userId);
    const navId = currentPlName; // playlist name in customId

    // Row 1: Song selection
    const rowSelect = new ActionRowBuilder();
    if (currentItems.length > 0) {
      rowSelect.addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('plist_select_song')
          .setPlaceholder('⚡ Seleziona una canzone per Azioni...')
          .addOptions(currentItems.map((s, i) => ({
            label: `${start + i + 1}. ${sanitizeTitle(s.title).substring(0, 50)}`,
            value: `likes_${currentPlName}_${start + i}_${page}`
          })))
      );
    } else {
      rowSelect.addComponents(new StringSelectMenuBuilder().setCustomId('dummy').setPlaceholder('Vuoto').addOptions([{ label: 'vuoto', value: 'vuoto' }]).setDisabled(true));
    }
    components.push(rowSelect);

    // Row 2: Navigation and Play All
    const rowButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`plist_prev_likes_${navId}_${page}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`plist_playall_likes_${navId}`).setEmoji('🚀').setLabel('Play').setStyle(ButtonStyle.Success).setDisabled(totalItems === 0),
      new ButtonBuilder().setCustomId(`plist_next_likes_${navId}_${page}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary)
    );
    components.push(rowButtons);

    // Row 3: Playlist selection dropdown (disabled if only 1 playlist)
    const playlistSelectRow = new ActionRowBuilder();
    const plOptions = plNames.map(name => ({
      label: `${name} (${(getUserData(db, userId).playlists[name] || []).length})`,
      value: name,
      default: name === currentPlName,
      emoji: name === DEFAULT_PLAYLIST_NAME ? '📋' : '📁'
    }));
    playlistSelectRow.addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('plist_switch_likes')
        .setPlaceholder('📂 Select playlist...')
        .addOptions(plOptions.length > 0 ? plOptions : [{ label: 'Empty', value: 'empty' }])
        .setDisabled(plNames.length <= 1)
    );
    components.push(playlistSelectRow);

    // Row 4: Playlist management buttons + Search
    const rowManage = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('plist_create').setEmoji('➕').setLabel('Create').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`plist_delete_likes_${currentPlName}`).setEmoji('🗑️').setLabel('Delete').setStyle(ButtonStyle.Danger).setDisabled(currentPlName === DEFAULT_PLAYLIST_NAME),
      new ButtonBuilder().setCustomId(`plist_rename_likes_${currentPlName}`).setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(currentPlName === DEFAULT_PLAYLIST_NAME),
      new ButtonBuilder().setCustomId(`plist_search_likes_${navId}`).setEmoji('🔍').setStyle(ButtonStyle.Primary).setDisabled(totalItems === 0)
    );
    components.push(rowManage);
  } else {
    // Server playlist — Row 1: Song select menu
    const rowSelect = new ActionRowBuilder();
    if (currentItems.length > 0) {
      rowSelect.addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('plist_select_song')
          .setPlaceholder('⚡ Seleziona una canzone per Azioni...')
          .addOptions(currentItems.map((s, i) => ({
            label: `${start + i + 1}. ${sanitizeTitle(s.title).substring(0, 50)}`,
            value: `server_${start + i}_${page}`
          })))
      );
    } else {
      rowSelect.addComponents(new StringSelectMenuBuilder().setCustomId('dummy').setPlaceholder('Vuoto').addOptions([{ label: 'vuoto', value: 'vuoto' }]).setDisabled(true));
    }
    components.push(rowSelect);

    // Row 2: Navigation, Play All, and Search
    const rowButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`plist_prev_${type}_${page}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`plist_playall_${type}`).setEmoji('🚀').setLabel('Play').setStyle(ButtonStyle.Success).setDisabled(totalItems === 0),
      new ButtonBuilder().setCustomId(`plist_next_${type}_${page}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('plist_search_server').setEmoji('🔍').setStyle(ButtonStyle.Primary).setDisabled(totalItems === 0)
    );
    components.push(rowButtons);
  }

  return { embeds: [embed], components, flags: MessageFlags.Ephemeral };
}

/**
 * Creates main dashboard components
 * @param {Object} serverQueue - The server queue
 * @returns {ActionRowBuilder[]} Array of component rows
 */
function createDashboardComponents(serverQueue) {
  const song = serverQueue ? getCurrentSong(serverQueue) : null;
  const isSongValid = isValidSong(song);
  const queueList = serverQueue ? (serverQueue.songs || []) : [];
  const canGoPrev = serverQueue && getPlayingIndex(serverQueue) > 0;
  // Detects terminated state: no current deck but music still exists (for replay)
  const isTerminated = serverQueue && !serverQueue.currentDeckLoaded;

  const db = loadDatabase();
  const isDuplicateServer = isSongValid ? (db.server || []).some(s => areSameSong(s.url, song.url)) : false;

  let rowControls;
  if (isTerminated) {
    // Only 'replay' enabled in terminated state
    rowControls = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_replay').setEmoji('🔁').setStyle(ButtonStyle.Secondary).setDisabled(false),
      new ButtonBuilder().setCustomId('btn_prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('btn_pause').setEmoji('⏯️').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('btn_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(true)
    );
  } else {
    rowControls = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_replay').setEmoji('🔁').setStyle(ButtonStyle.Secondary).setDisabled(!isSongValid && !isTerminated),
      new ButtonBuilder().setCustomId('btn_prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(!canGoPrev || !isSongValid),
      new ButtonBuilder().setCustomId('btn_pause').setEmoji('⏯️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('btn_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(!isSongValid)
    );
  }

  const loopState = serverQueue ? serverQueue.loopEnabled : false;
  const fadeState = serverQueue ? serverQueue.fadeEnabled : false;
  const queueHasMultiple = queueList.length >= 2;

  const rowSecondary = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_loop').setEmoji('🔄').setStyle(loopState ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(isTerminated || !isSongValid),
    new ButtonBuilder().setCustomId('btn_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary).setDisabled(isTerminated || !queueHasMultiple),
    new ButtonBuilder().setCustomId('btn_fade').setEmoji('🔗').setStyle(fadeState ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(isTerminated),
    // 📜 Current song text (ephemeral message). Next to cross-fade.
    new ButtonBuilder().setCustomId('btn_lyrics').setEmoji('📜').setStyle(ButtonStyle.Secondary).setDisabled(isTerminated || !isSongValid)
  );

  const rowPlaylists = new ActionRowBuilder().addComponents(
    // Buttons to open playlists must remain clickable even when terminated
    new ButtonBuilder().setCustomId('open_plist_server').setEmoji('📂').setStyle(ButtonStyle.Primary).setDisabled(false),
    new ButtonBuilder().setCustomId('btn_toggle_server').setEmoji(isDuplicateServer ? '🗑️' : '💾').setStyle(isDuplicateServer ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(isTerminated || !isSongValid),
    new ButtonBuilder().setCustomId('open_plist_likes').setEmoji('👤').setStyle(ButtonStyle.Primary).setDisabled(false),
    new ButtonBuilder().setCustomId('btn_toggle_like').setEmoji('❤️').setStyle(ButtonStyle.Secondary).setDisabled(isTerminated || !isSongValid)
  );


  const rowSelect = new ActionRowBuilder();
  // Uses the index of the song ACTUALLY playing on active deck
  // (consistent with embed) rather than just playIndex.
  const currentIndex = serverQueue ? getPlayingIndex(serverQueue) : 0;

  const songsInQueue = queueList ? Math.max(0, queueList.length - (currentIndex + 1)) : 0;
  const nextSongs = queueList ? queueList.slice(currentIndex + 1, currentIndex + 26) : [];
  const menu = new StringSelectMenuBuilder().setCustomId('select_queue');
  if (nextSongs.length > 0) {
    menu.setPlaceholder(songsInQueue > 25 ? `📜 Next (${songsInQueue})...` : `📜 Next in queue (${songsInQueue})...`).addOptions(
      // Shows only songs after current. Labels are relative position in list,
      // values are absolute indices in `queueList` so handlers can use them directly.
      nextSongs.map((s, index) => {
        const absIndex = currentIndex + 1 + index;
        return { label: `${index + 1}. ${(s.title ? s.title.substring(0, 50) : 'Unknown')}`, value: absIndex.toString() };
      })
    );
  } else {
    menu.setPlaceholder('🚫 No songs in queue').addOptions([{ label: 'Empty', value: 'empty' }]).setDisabled(true);
  }
  rowSelect.addComponents(menu);

  const rowActions = new ActionRowBuilder().addComponents(
    // 'Add' button must be clickable in terminated state
    new ButtonBuilder().setCustomId('btn_add_modal').setEmoji('➕').setLabel('Add').setStyle(ButtonStyle.Secondary).setDisabled(false),
    // 'Mix' must only be pressable when queue is ended
    new ButtonBuilder().setCustomId('btn_yt_mix').setEmoji('✨').setLabel('Mix').setStyle(ButtonStyle.Primary).setDisabled(!isTerminated),
    new ButtonBuilder().setCustomId('btn_clear_queue').setEmoji('🧹').setLabel('Clear Queue').setStyle(ButtonStyle.Danger).setDisabled(isTerminated || !isSongValid)
  );
  return [rowControls, rowSecondary, rowPlaylists, rowSelect, rowActions];
}

/**
 * Generates search results view in playlist
 * @param {string} type - 'server' or 'likes'
 * @param {string} userId - User ID
 * @param {string} query - Search string
 * @param {number} page - Page number of results
 * @param {string|null} playlistName - Personal playlist name (only for type !== 'server')
 * @returns {Object} Object with embeds, components and flags
 */
function generateSearchResultsView(type, userId, query, page, playlistName = null) {
  const db = loadDatabase();

  let items;
  let currentPlName = DEFAULT_PLAYLIST_NAME;

  if (type === 'server') {
    items = db.server || [];
  } else {
    const userData = getUserData(db, userId);
    currentPlName = playlistName || userData.activePlaylist || DEFAULT_PLAYLIST_NAME;
    items = userData.playlists[currentPlName] || [];
  }

  // Filter by query (case-insensitive)
  const lowerQuery = query.toLowerCase();
  const matchedItems = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].title && items[i].title.toLowerCase().includes(lowerQuery)) {
      matchedItems.push({ song: items[i], originalIndex: i });
    }
  }

  const totalResults = matchedItems.length;
  const itemsPerPage = PLAYLIST_PAGE_SIZE;
  const maxPage = Math.max(0, Math.ceil(totalResults / itemsPerPage) - 1);

  if (page < 0) page = maxPage;
  else if (page > maxPage) page = 0;
  page = Math.min(Math.max(0, page), maxPage);

  const start = page * itemsPerPage;
  const currentResults = matchedItems.slice(start, start + itemsPerPage);

  const description = currentResults.length > 0
    ? currentResults.map(r => `**${r.originalIndex + 1}.** [${sanitizeTitle(r.song.title).substring(0, 60)}](${r.song.url})`).join('\n')
    : '🔍 Nessun risultato trovato.';

  const truncatedQuery = query.length > 30 ? query.substring(0, 30) + '…' : query;
  const embed = new EmbedBuilder()
    .setColor(type === 'server' ? 0xFFAA00 : 0xFF00FF)
    .setTitle(type === 'server'
      ? `🔍 Cerca: "${truncatedQuery}" (${totalResults} risultati)`
      : `🔍 Cerca in ${currentPlName}: "${truncatedQuery}" (${totalResults})`)
    .setDescription(description)
    .setFooter({ text: totalResults > 0 ? `Pagina ${page + 1} di ${maxPage + 1}` : 'Nessun risultato' });

  const components = [];

  // Row 1: Select menu for found songs
  const rowSelect = new ActionRowBuilder();
  if (currentResults.length > 0) {
    const selectOptions = currentResults.map((r) => {
      const origPage = Math.floor(r.originalIndex / PLAYLIST_PAGE_SIZE);
      return {
        label: `${r.originalIndex + 1}. ${sanitizeTitle(r.song.title).substring(0, 50)}`,
        value: type === 'server'
          ? `server_${r.originalIndex}_${origPage}`
          : `likes_${currentPlName}_${r.originalIndex}_${origPage}`
      };
    });
    rowSelect.addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('plist_select_song')
        .setPlaceholder('⚡ Select a song for Actions...')
        .addOptions(selectOptions)
    );
  } else {
    rowSelect.addComponents(
      new StringSelectMenuBuilder().setCustomId('dummy_search').setPlaceholder('No results').addOptions([{ label: 'empty', value: 'empty' }]).setDisabled(true)
    );
  }
  components.push(rowSelect);

  // Row 2: Navigation results + back to playlist
  if (type === 'server') {
    const rowNav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`srch_prev_server_${page}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(totalResults <= itemsPerPage),
      new ButtonBuilder().setCustomId('srch_back_server').setEmoji('🔙').setLabel('Playlist').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`srch_next_server_${page}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(totalResults <= itemsPerPage)
    );
    components.push(rowNav);
  } else {
    const rowNav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`srch_prev_likes_${currentPlName}_${page}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(totalResults <= itemsPerPage),
      new ButtonBuilder().setCustomId(`srch_back_likes_${currentPlName}`).setEmoji('🔙').setLabel('Playlist').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`srch_next_likes_${currentPlName}_${page}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(totalResults <= itemsPerPage)
    );
    components.push(rowNav);
  }

  return { embeds: [embed], components, flags: MessageFlags.Ephemeral };
}

export {
  generatePlaylistView,
  generateSearchResultsView,
  createDashboardComponents
};
