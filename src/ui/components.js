/**
 * src/ui/components.js
 * Funzioni per la creazione di componenti Discord (bottoni, menu)
 */

const { 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder,
    MessageFlags
} = require('discord.js');
const { EmbedBuilder } = require('discord.js');
const { sanitizeTitle } = require('../utils/sanitize');
const { areSameSong } = require('../utils/sanitize');
const { getCurrentSong, isValidSong } = require('../queue/QueueManager');
const { loadDatabase, getUserData, getUserPlaylist, getUserPlaylistNames, getActivePlaylistName } = require('../database/playlists');
const { PLAYLIST_PAGE_SIZE, DEFAULT_PLAYLIST_NAME } = require('../../config');

/**
 * Genera la vista di una playlist con paginazione
 * @param {string} type - 'server' o 'likes'
 * @param {string} userId - ID utente (per playlist personale)
 * @param {number} page - Numero pagina
 * @param {string|null} playlistName - Nome playlist personale (solo per type !== 'server')
 * @returns {Object} Oggetto con embeds, components e flags
 */
function generatePlaylistView(type, userId, page, playlistName = null) {
    const db = loadDatabase();
    
    let items;
    let currentPlName = DEFAULT_PLAYLIST_NAME;
    
    if (type === 'server') {
        items = db.server || [];
    } else {
        // Playlist personale — ottieni dati utente (con migrazione automatica)
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

    let description = currentItems.length > 0 
        ? currentItems.map((s, i) => `**${start + i + 1}.** [${sanitizeTitle(s.title).substring(0, 60)}](${s.url})`).join('\n')
        : '📭 Nessuna canzone salvata.';

    const embed = new EmbedBuilder()
        .setColor(type === 'server' ? 0xFFAA00 : 0xFF00FF)
        .setTitle(type === 'server' ? `📂 Playlist Server (${totalItems})` : `👤 Playlist: ${currentPlName} (${totalItems})`)
        .setDescription(description)
        .setFooter({ text: `Pagina ${page + 1} di ${maxPage + 1}` });

    const components = [];

    // Per playlist personali: aggiungi riga di selezione playlist e riga gestione
    if (type !== 'server') {
        const plNames = getUserPlaylistNames(db, userId);
        const navId = currentPlName; // nome playlist nel customId
        
        // Row 1: Selezione canzone
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
            rowSelect.addComponents(new StringSelectMenuBuilder().setCustomId('dummy').setPlaceholder('Vuoto').addOptions([{label:'vuoto', value:'vuoto'}]).setDisabled(true));
        }
        components.push(rowSelect);

        // Row 2: Navigazione e Play All
        const rowButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`plist_prev_likes_${navId}_${page}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`plist_playall_likes_${navId}`).setEmoji('🚀').setLabel('Riproduci').setStyle(ButtonStyle.Success).setDisabled(totalItems === 0),
            new ButtonBuilder().setCustomId(`plist_next_likes_${navId}_${page}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary)
        );
        components.push(rowButtons);

        // Row 4: Dropdown selezione playlist (disabilitato se solo 1 playlist)
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
                .setPlaceholder('📂 Seleziona playlist...')
                .addOptions(plOptions.length > 0 ? plOptions : [{ label: 'Vuoto', value: 'empty' }])
                .setDisabled(plNames.length <= 1)
        );
        components.push(playlistSelectRow);

        // Row 4: Bottoni gestione playlist + Cerca
        const rowManage = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('plist_create').setEmoji('➕').setLabel('Crea').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`plist_delete_likes_${currentPlName}`).setEmoji('🗑️').setLabel('Elimina').setStyle(ButtonStyle.Danger).setDisabled(currentPlName === DEFAULT_PLAYLIST_NAME),
            new ButtonBuilder().setCustomId(`plist_rename_likes_${currentPlName}`).setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(currentPlName === DEFAULT_PLAYLIST_NAME),
            new ButtonBuilder().setCustomId(`plist_search_likes_${navId}`).setEmoji('🔍').setStyle(ButtonStyle.Primary).setDisabled(totalItems === 0)
        );
        components.push(rowManage);
    } else {
        // Server playlist — Row 1: Select menu canzoni
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
            rowSelect.addComponents(new StringSelectMenuBuilder().setCustomId('dummy').setPlaceholder('Vuoto').addOptions([{label:'vuoto', value:'vuoto'}]).setDisabled(true));
        }
        components.push(rowSelect);

        // Row 2: Navigazione, Play All, e Cerca
        const rowButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`plist_prev_${type}_${page}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`plist_playall_${type}`).setEmoji('🚀').setLabel('Riproduci').setStyle(ButtonStyle.Success).setDisabled(totalItems === 0),
            new ButtonBuilder().setCustomId(`plist_next_${type}_${page}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('plist_search_server').setEmoji('🔍').setStyle(ButtonStyle.Primary).setDisabled(totalItems === 0)
        );
        components.push(rowButtons);
    }

    return { embeds: [embed], components, flags: MessageFlags.Ephemeral };
}

/**
 * Crea i componenti della dashboard principale
 * @param {Object} serverQueue - La coda del server
 * @param {string|null} userId - ID utente opzionale
 * @returns {ActionRowBuilder[]} Array di righe di componenti
 */
function createDashboardComponents(serverQueue, userId = null) {
    const song = serverQueue ? getCurrentSong(serverQueue) : null;
    const isSongValid = isValidSong(song);
    const queueList = serverQueue ? (serverQueue.songs || []) : [];
    const canGoPrev = serverQueue && (serverQueue.playIndex || 0) > 0;
    // Rileva stato terminato: nessun deck corrente ma c'è ancora musica (per replay)
    const isTerminated = serverQueue && !serverQueue.currentDeckLoaded;
    
    const db = loadDatabase();
    const isDuplicateServer = isSongValid ? (db.server || []).some(s => areSameSong(s.url, song.url)) : false;
    const isLive = isSongValid ? song.isLive === true : false;

    
    let rowControls;
    if (isTerminated) {
        // Solo 'replay' abilitato nello stato terminato
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
        new ButtonBuilder().setCustomId('btn_fade').setEmoji('🔗').setStyle(fadeState ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(isTerminated)
    );

    const rowPlaylists = new ActionRowBuilder().addComponents(
        // I pulsanti per aprire le playlist devono rimanere cliccabili anche quando terminato
        new ButtonBuilder().setCustomId('open_plist_server').setEmoji('📂').setStyle(ButtonStyle.Primary).setDisabled(false),
        new ButtonBuilder().setCustomId('btn_toggle_server').setEmoji(isDuplicateServer ? '🗑️' : '💾').setStyle(isDuplicateServer ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(isTerminated || !isSongValid),
        new ButtonBuilder().setCustomId('open_plist_likes').setEmoji('👤').setStyle(ButtonStyle.Primary).setDisabled(false),
        new ButtonBuilder().setCustomId('btn_toggle_like').setEmoji('❤️').setStyle(ButtonStyle.Secondary).setDisabled(isTerminated || !isSongValid)
    );


    const rowSelect = new ActionRowBuilder();
    // Usa playIndex per determinare la posizione corrente
    const currentIndex = serverQueue ? (serverQueue.playIndex || 0) : 0;

    const songsInQueue = queueList ? Math.max(0, queueList.length - (currentIndex + 1)) : 0;
    const nextSongs = queueList ? queueList.slice(currentIndex + 1, currentIndex + 26) : [];
    const menu = new StringSelectMenuBuilder().setCustomId('select_queue');
    if (nextSongs.length > 0) {
        menu.setPlaceholder(songsInQueue > 25 ? `📜 Prossime (${songsInQueue})...` : `📜 Prossime in coda (${songsInQueue})...`).addOptions(
            // Mostra solo le canzoni dopo quella corrente. Le etichette sono la posizione relativa nella lista,
            // i valori sono indici assoluti in `queueList` così gli handler possono usarli direttamente.
            nextSongs.map((s, index) => {
                const absIndex = currentIndex + 1 + index;
                return { label: `${index + 1}. ${(s.title ? s.title.substring(0, 50) : "Sconosciuto")}`, value: absIndex.toString() };
            })
        );
    } else {
        menu.setPlaceholder('🚫 Nessuna canzone in coda').addOptions([{ label: 'Vuoto', value: 'empty' }]).setDisabled(true);
    }
    rowSelect.addComponents(menu);

    const rowActions = new ActionRowBuilder().addComponents(
        // Il pulsante 'Add' deve essere cliccabile nello stato terminato
        new ButtonBuilder().setCustomId('btn_add_modal').setEmoji('➕').setLabel('Aggiungi').setStyle(ButtonStyle.Secondary).setDisabled(false),
        // 'Mix' deve essere premibile SOLO quando la coda è terminata
        new ButtonBuilder().setCustomId('btn_yt_mix').setEmoji('✨').setLabel('Mix').setStyle(ButtonStyle.Primary).setDisabled(!isTerminated),
        new ButtonBuilder().setCustomId('btn_clear_queue').setEmoji('🧹').setLabel('Svuota coda').setStyle(ButtonStyle.Danger).setDisabled(isTerminated || !isSongValid)
    );
    return [rowControls, rowSecondary, rowPlaylists, rowSelect, rowActions];
}

/**
 * Genera la vista dei risultati di ricerca in una playlist
 * @param {string} type - 'server' o 'likes'
 * @param {string} userId - ID utente
 * @param {string} query - Stringa di ricerca
 * @param {number} page - Numero pagina dei risultati
 * @param {string|null} playlistName - Nome playlist personale (solo per type !== 'server')
 * @returns {Object} Oggetto con embeds, components e flags
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

    // Filtra per query (case-insensitive)
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

    let description = currentResults.length > 0
        ? currentResults.map((r, i) => `**${r.originalIndex + 1}.** [${sanitizeTitle(r.song.title).substring(0, 60)}](${r.song.url})`).join('\n')
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

    // Row 1: Select menu canzoni trovate
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
                .setPlaceholder('⚡ Seleziona una canzone per Azioni...')
                .addOptions(selectOptions)
        );
    } else {
        rowSelect.addComponents(
            new StringSelectMenuBuilder().setCustomId('dummy_search').setPlaceholder('Nessun risultato').addOptions([{ label: 'vuoto', value: 'vuoto' }]).setDisabled(true)
        );
    }
    components.push(rowSelect);

    // Row 2: Navigazione risultati + torna alla playlist
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

module.exports = {
    generatePlaylistView,
    generateSearchResultsView,
    createDashboardComponents
};
