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
import { sanitizeTitle, areSameSong } from '../utils/sanitize.js';
import { getCurrentSong, getPlayingIndex, isValidSong } from '../queue/QueueManager.js';
import { loadDatabase, getUserData, getUserPlaylistNames } from '../database/playlists.js';
import { PLAYLIST_PAGE_SIZE, DEFAULT_PLAYLIST_NAME } from '../../config/index.js';
import {
  NO_SAVED_SONGS,
  NO_SEARCH_RESULTS,
  EMPTY_PLACEHOLDER,
  SELECT_SONG_PLACEHOLDER,
  serverPlaylistTitle,
  userPlaylistTitle,
  paginationFooter,
  PLAY_BUTTON,
  SELECT_PLAYLIST_PLACEHOLDER,
  CREATE_BUTTON,
  DELETE_BUTTON,
  serverSearchTitle,
  userSearchTitle,
  NO_SEARCH_RESULTS_FOOTER,
  BACK_TO_PLAYLIST_BUTTON,
  queuePlaceholder,
  NO_QUEUE_PLACEHOLDER,
  UNKNOWN_QUEUE_TITLE,
  ADD_BUTTON,
  MIX_BUTTON,
  CLEAR_QUEUE_BUTTON
} from './messages.js';

const SELECT_LABEL_MAX = 50;   // Discord truncates option labels beyond this
const LINK_TITLE_MAX = 60;     // Keeps list descriptions readable
const QUEUE_MENU_MAX = 25;     // Discord allows at most 25 options per select menu

/**
 * Wraps a page index so that going before the first page lands on the last one.
 * @param {number} page - Requested page (may be out of range)
 * @param {number} totalItems
 * @returns {{page: number, maxPage: number, start: number}}
 */
function resolvePage(page, totalItems) {
  const maxPage = Math.max(0, Math.ceil(totalItems / PLAYLIST_PAGE_SIZE) - 1);
  let resolved = page;
  if (resolved < 0) resolved = maxPage;
  else if (resolved > maxPage) resolved = 0;
  resolved = Math.min(Math.max(0, resolved), maxPage);
  return { page: resolved, maxPage, start: resolved * PLAYLIST_PAGE_SIZE };
}

/**
 * A disabled placeholder select menu, used wherever a row must exist but has
 * nothing to offer (Discord rejects a select menu with zero options).
 * @param {string} customId
 * @param {string} placeholder
 * @returns {StringSelectMenuBuilder}
 */
function emptySelectMenu(customId, placeholder) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions([{ label: EMPTY_PLACEHOLDER, value: 'empty' }])
    .setDisabled(true);
}

/**
 * Resolves the item list a playlist view should show.
 * @param {string} type - 'server' or 'likes'
 * @param {string} userId
 * @param {string|null} playlistName
 * @returns {{items: Array, currentPlName: string}}
 */
function resolvePlaylistItems(type, userId, playlistName) {
  const db = loadDatabase();
  if (type === 'server') {
    return { items: db.server || [], currentPlName: DEFAULT_PLAYLIST_NAME };
  }
  const userData = getUserData(db, userId);
  const currentPlName = playlistName || userData.activePlaylist || DEFAULT_PLAYLIST_NAME;
  return { items: userData.playlists[currentPlName] || [], currentPlName };
}

/**
 * Generates playlist view with pagination
 * @param {string} type - 'server' or 'likes'
 * @param {string} userId - User ID (for personal playlist)
 * @param {number} page - Page number
 * @param {string|null} playlistName - Personal playlist name (only for type !== 'server')
 * @returns {Object} Object with embeds, components and flags
 */
function generatePlaylistView(type, userId, page, playlistName = null) {
  const { items, currentPlName } = resolvePlaylistItems(type, userId, playlistName);
  const totalItems = items.length;
  const resolved = resolvePage(page, totalItems);
  const { start, maxPage } = resolved;
  page = resolved.page;

  const currentItems = items.slice(start, start + PLAYLIST_PAGE_SIZE);

  const description = currentItems.length > 0
    ? currentItems.map((s, i) => `**${start + i + 1}.** [${sanitizeTitle(s.title).substring(0, LINK_TITLE_MAX)}](${s.url})`).join('\n')
    : NO_SAVED_SONGS;

  const embed = new EmbedBuilder()
    .setColor(type === 'server' ? 0xFFAA00 : 0xFF00FF)
    .setTitle(type === 'server' ? serverPlaylistTitle(totalItems) : userPlaylistTitle(currentPlName, totalItems))
    .setDescription(description)
    .setFooter({ text: paginationFooter(page, maxPage) });

  const components = [];

  // Row 1: song selection (shared by both playlist types)
  const rowSelect = new ActionRowBuilder();
  if (currentItems.length > 0) {
    rowSelect.addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('plist_select_song')
        .setPlaceholder(SELECT_SONG_PLACEHOLDER)
        .addOptions(currentItems.map((s, i) => ({
          label: `${start + i + 1}. ${sanitizeTitle(s.title).substring(0, SELECT_LABEL_MAX)}`,
          value: type === 'server'
            ? `server_${start + i}_${page}`
            : `likes_${currentPlName}_${start + i}_${page}`
        })))
    );
  } else {
    rowSelect.addComponents(emptySelectMenu('dummy', EMPTY_PLACEHOLDER));
  }
  components.push(rowSelect);

  if (type !== 'server') {
    const db = loadDatabase();
    const plNames = getUserPlaylistNames(db, userId);
    const navId = currentPlName; // playlist name in customId

    // Row 2: Navigation and Play All
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`plist_prev_likes_${navId}_${page}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`plist_playall_likes_${navId}`).setEmoji('🚀').setLabel(PLAY_BUTTON).setStyle(ButtonStyle.Success).setDisabled(totalItems === 0),
      new ButtonBuilder().setCustomId(`plist_next_likes_${navId}_${page}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary)
    ));

    // Row 3: Playlist selection dropdown (disabled if only 1 playlist)
    const plOptions = plNames.map(name => ({
      label: `${name} (${(getUserData(db, userId).playlists[name] || []).length})`,
      value: name,
      default: name === currentPlName,
      emoji: name === DEFAULT_PLAYLIST_NAME ? '📋' : '📁'
    }));
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('plist_switch_likes')
        .setPlaceholder(SELECT_PLAYLIST_PLACEHOLDER)
        .addOptions(plOptions.length > 0 ? plOptions : [{ label: EMPTY_PLACEHOLDER, value: 'empty' }])
        .setDisabled(plNames.length <= 1)
    ));

    // Row 4: Playlist management buttons + Search
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('plist_create').setEmoji('➕').setLabel(CREATE_BUTTON).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`plist_delete_likes_${currentPlName}`).setEmoji('🗑️').setLabel(DELETE_BUTTON).setStyle(ButtonStyle.Danger).setDisabled(currentPlName === DEFAULT_PLAYLIST_NAME),
      new ButtonBuilder().setCustomId(`plist_rename_likes_${currentPlName}`).setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(currentPlName === DEFAULT_PLAYLIST_NAME),
      new ButtonBuilder().setCustomId(`plist_search_likes_${navId}`).setEmoji('🔍').setStyle(ButtonStyle.Primary).setDisabled(totalItems === 0)
    ));
  } else {
    // Row 2: Navigation, Play All, and Search
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`plist_prev_${type}_${page}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`plist_playall_${type}`).setEmoji('🚀').setLabel(PLAY_BUTTON).setStyle(ButtonStyle.Success).setDisabled(totalItems === 0),
      new ButtonBuilder().setCustomId(`plist_next_${type}_${page}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('plist_search_server').setEmoji('🔍').setStyle(ButtonStyle.Primary).setDisabled(totalItems === 0)
    ));
  }

  return { embeds: [embed], components, flags: MessageFlags.Ephemeral };
}

/**
 * Creates main dashboard components.
 * The rows are identical for every viewer: the dashboard is a single shared
 * message, so nothing here depends on who pressed the last button.
 * @param {Object} serverQueue - The server queue
 * @returns {ActionRowBuilder[]} Array of component rows
 */
function createDashboardComponents(serverQueue) {
  const song = serverQueue ? getCurrentSong(serverQueue) : null;
  const isSongValid = isValidSong(song);
  const queueList = serverQueue ? (serverQueue.songs || []) : [];
  const currentIndex = serverQueue ? getPlayingIndex(serverQueue) : 0;
  const canGoPrev = currentIndex > 0;
  // Detects terminated state: no current deck but music still exists (for replay)
  const isTerminated = !!(serverQueue && !serverQueue.currentDeckLoaded);

  const db = loadDatabase();
  const isDuplicateServer = isSongValid ? (db.server || []).some(s => areSameSong(s.url, song.url)) : false;

  // In the terminated state only 'replay' stays usable among the transport controls
  const rowControls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_replay').setEmoji('🔁').setStyle(ButtonStyle.Secondary).setDisabled(!isSongValid && !isTerminated),
    new ButtonBuilder().setCustomId('btn_prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(isTerminated || !canGoPrev || !isSongValid),
    new ButtonBuilder().setCustomId('btn_pause').setEmoji('⏯️').setStyle(ButtonStyle.Primary).setDisabled(isTerminated),
    new ButtonBuilder().setCustomId('btn_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(isTerminated || !isSongValid)
  );

  const loopState = serverQueue ? serverQueue.loopEnabled : false;
  const fadeState = serverQueue ? serverQueue.fadeEnabled : false;
  const queueHasMultiple = queueList.length >= 2;

  const rowSecondary = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_loop').setEmoji('🔄').setStyle(loopState ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(isTerminated || !isSongValid),
    new ButtonBuilder().setCustomId('btn_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary).setDisabled(isTerminated || !queueHasMultiple),
    new ButtonBuilder().setCustomId('btn_fade').setEmoji('🔗').setStyle(fadeState ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(isTerminated),
    // 📜 Current song lyrics (ephemeral message). Next to cross-fade.
    new ButtonBuilder().setCustomId('btn_lyrics').setEmoji('📜').setStyle(ButtonStyle.Secondary).setDisabled(isTerminated || !isSongValid)
  );

  const rowPlaylists = new ActionRowBuilder().addComponents(
    // Buttons to open playlists must remain clickable even when terminated
    new ButtonBuilder().setCustomId('open_plist_server').setEmoji('📂').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_toggle_server').setEmoji(isDuplicateServer ? '🗑️' : '💾').setStyle(isDuplicateServer ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(isTerminated || !isSongValid),
    new ButtonBuilder().setCustomId('open_plist_likes').setEmoji('👤').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_toggle_like').setEmoji('❤️').setStyle(ButtonStyle.Secondary).setDisabled(isTerminated || !isSongValid)
  );

  // Uses the index of the song ACTUALLY playing on the active deck
  // (consistent with the embed) rather than just playIndex.
  const songsInQueue = Math.max(0, queueList.length - (currentIndex + 1));
  const nextSongs = queueList.slice(currentIndex + 1, currentIndex + 1 + QUEUE_MENU_MAX);
  const menu = new StringSelectMenuBuilder().setCustomId('select_queue');
  if (nextSongs.length > 0 && !isTerminated) {
    menu
      .setPlaceholder(queuePlaceholder(songsInQueue))
      // Labels are the position relative to the current song, values are the
      // absolute indices in `queueList` so handlers can use them directly.
      .addOptions(nextSongs.map((s, index) => ({
        label: `${index + 1}. ${(s.title ? sanitizeTitle(s.title).substring(0, SELECT_LABEL_MAX) : UNKNOWN_QUEUE_TITLE)}`,
        value: (currentIndex + 1 + index).toString()
      })));
  } else {
    menu.setPlaceholder(NO_QUEUE_PLACEHOLDER).addOptions([{ label: EMPTY_PLACEHOLDER, value: 'empty' }]).setDisabled(true);
  }
  const rowSelect = new ActionRowBuilder().addComponents(menu);

  const rowActions = new ActionRowBuilder().addComponents(
    // 'Aggiungi' must be clickable in the terminated state too
    new ButtonBuilder().setCustomId('btn_add_modal').setEmoji('➕').setLabel(ADD_BUTTON).setStyle(ButtonStyle.Secondary),
    // 'Mix' only makes sense once the queue is over
    new ButtonBuilder().setCustomId('btn_yt_mix').setEmoji('✨').setLabel(MIX_BUTTON).setStyle(ButtonStyle.Primary).setDisabled(!isTerminated),
    new ButtonBuilder().setCustomId('btn_clear_queue').setEmoji('🧹').setLabel(CLEAR_QUEUE_BUTTON).setStyle(ButtonStyle.Danger).setDisabled(isTerminated || !isSongValid)
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
  const { items, currentPlName } = resolvePlaylistItems(type, userId, playlistName);

  // Filter by query (case-insensitive), keeping the position in the full playlist
  const lowerQuery = query.toLowerCase();
  const matchedItems = items
    .map((song, originalIndex) => ({ song, originalIndex }))
    .filter(({ song }) => song.title && song.title.toLowerCase().includes(lowerQuery));

  const totalResults = matchedItems.length;
  const resolved = resolvePage(page, totalResults);
  const { start, maxPage } = resolved;
  page = resolved.page;

  const currentResults = matchedItems.slice(start, start + PLAYLIST_PAGE_SIZE);

  const description = currentResults.length > 0
    ? currentResults.map(r => `**${r.originalIndex + 1}.** [${sanitizeTitle(r.song.title).substring(0, LINK_TITLE_MAX)}](${r.song.url})`).join('\n')
    : NO_SEARCH_RESULTS;

  const truncatedQuery = query.length > 30 ? query.substring(0, 30) + '…' : query;
  const embed = new EmbedBuilder()
    .setColor(type === 'server' ? 0xFFAA00 : 0xFF00FF)
    .setTitle(type === 'server'
      ? serverSearchTitle(truncatedQuery, totalResults)
      : userSearchTitle(currentPlName, truncatedQuery, totalResults))
    .setDescription(description)
    .setFooter({ text: totalResults > 0 ? paginationFooter(page, maxPage) : NO_SEARCH_RESULTS_FOOTER });

  const components = [];

  // Row 1: Select menu for found songs
  const rowSelect = new ActionRowBuilder();
  if (currentResults.length > 0) {
    rowSelect.addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('plist_select_song')
        .setPlaceholder(SELECT_SONG_PLACEHOLDER)
        .addOptions(currentResults.map((r) => ({
          label: `${r.originalIndex + 1}. ${sanitizeTitle(r.song.title).substring(0, SELECT_LABEL_MAX)}`,
          // The page is the one the song sits on in the full playlist, so the
          // "back" button of the action view returns to the right place.
          value: type === 'server'
            ? `server_${r.originalIndex}_${Math.floor(r.originalIndex / PLAYLIST_PAGE_SIZE)}`
            : `likes_${currentPlName}_${r.originalIndex}_${Math.floor(r.originalIndex / PLAYLIST_PAGE_SIZE)}`
        })))
    );
  } else {
    rowSelect.addComponents(emptySelectMenu('dummy_search', NO_SEARCH_RESULTS_FOOTER));
  }
  components.push(rowSelect);

  // Row 2: Navigation between result pages + back to the playlist
  const navSuffix = type === 'server' ? 'server' : `likes_${currentPlName}`;
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`srch_prev_${navSuffix}_${page}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(totalResults <= PLAYLIST_PAGE_SIZE),
    new ButtonBuilder().setCustomId(`srch_back_${navSuffix}`).setEmoji('🔙').setLabel(BACK_TO_PLAYLIST_BUTTON).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`srch_next_${navSuffix}_${page}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(totalResults <= PLAYLIST_PAGE_SIZE)
  ));

  return { embeds: [embed], components, flags: MessageFlags.Ephemeral };
}

export {
  generatePlaylistView,
  generateSearchResultsView,
  createDashboardComponents
};
