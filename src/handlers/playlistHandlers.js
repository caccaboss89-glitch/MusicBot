/**
 * Handler per interazioni relative alle playlist (bottoni, select menu, ricerca).
 * Estratti da interaction.js per modularità e crash-independence.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { loadDatabase, saveDatabase, getUserData, getUserPlaylist, getActivePlaylistName, setActivePlaylist, validatePlaylistName } = require('../database/playlists');
const { generatePlaylistView, generateSearchResultsView, createDashboardComponents } = require('../ui');
const { sanitizeTitle, areSameSong, safeParseInt, getYoutubeId } = require('../utils/sanitize');
const { clearFinishedQueue, insertSongAtIndex, getCurrentSong } = require('../queue/QueueManager');
const { saveQueueState } = require('../queue/persistence');
const { safeReply } = require('../utils/discord');
const { DEFAULT_PLAYLIST_NAME, MAX_PLAYLIST_NAME_LENGTH } = require('../../config');
const audio = require('../audio');

// Mappa in-memory per query di ricerca attive (per paginazione risultati)
const activeSearches = new Map();

// Pulizia periodica per prevenire memory leak (ogni 30 minuti)
setInterval(() => {
    activeSearches.clear();
}, 30 * 60 * 1000);

/**
 * Gestisce tutte le interazioni playlist (plist_*, act_*, srch_*, open_plist_*, btn_toggle_*).
 * @returns {boolean} true se l'interazione è stata gestita
 */
async function handlePlaylist(interaction, serverQueue, guildId, customId, deps) {
    // --- Playlist: selezione canzone ---
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

        if (songIndex < 0 || songIndex >= items.length) return await safeReply(interaction, { content: '❌ Canzone non trovata', flags: MessageFlags.Ephemeral }), true;

        const song = items[songIndex];
        const embed = new EmbedBuilder().setColor(0xFFAA00).setTitle("⚡ Azioni Playlist").setDescription(`**${sanitizeTitle(song.title)}**`);

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
            new ButtonBuilder().setCustomId(playId).setLabel('Riproduci').setEmoji('▶️').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(removeId).setLabel('Rimuovi').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(backId).setLabel('Indietro').setEmoji('🔙').setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({ embeds: [embed], components: [row] });
        return true;
    }

    // --- Playlist: cambio playlist attiva ---
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
        if (!items || items.length === 0) return await safeReply(interaction, { content: '❌ Playlist vuota', flags: MessageFlags.Ephemeral }), true;

        let toAdd = items.map(s => ({ ...s, requester: interaction.user.id }));
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
            if (serverQueue.nextDeckLoaded === null && serverQueue.songs.length >= 2) { await audio.updatePreloadAfterQueueChange(guildId); }
            if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
        }
        await safeReply(interaction, { content: `✅ Aggiunte ${toAdd.length} canzoni dalla playlist.`, flags: MessageFlags.Ephemeral });
        return true;
    }

    // --- Playlist: navigazione pagine ---
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

    // --- Azioni playlist (play/remove/back) ---
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
            const playObj = { ...song, requester: interaction.user.id };

            clearFinishedQueue(serverQueue);
            if (serverQueue.songs.length === 0) {
                serverQueue.songs.push(playObj);
                if (!serverQueue.currentDeckLoaded) {
                    const connected = await deps.connectToVoice(serverQueue, interaction);
                    if (connected) await audio.playSong(interaction.guild.id, interaction);
                }
            } else {
                const insertAt = (serverQueue.playIndex || 0) + 1;
                insertSongAtIndex(serverQueue, playObj, insertAt);
                saveQueueState(guildId, serverQueue);
                if (serverQueue.nextDeckLoaded === null || !areSameSong(serverQueue.nextDeckLoaded, playObj.url)) {
                    await audio.updatePreloadAfterQueueChange(guildId);
                }
                if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
            }
            await safeReply(interaction, { content: `🚀 Avviata: **${song.title}**`, flags: MessageFlags.Ephemeral });
            return true;
        }

        return true;
    }

    // --- Cerca nella playlist (apre modal) ---
    if (customId === 'plist_search_server') {
        const modal = new ModalBuilder().setCustomId('modal_search_server').setTitle('Cerca nella Playlist Server');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('search_query_input').setLabel('Nome canzone da cercare')
                .setStyle(TextInputStyle.Short).setMaxLength(50).setPlaceholder('Es: Bohemian Rhapsody...').setRequired(true)
        ));
        await interaction.showModal(modal);
        return true;
    }

    if (customId && customId.startsWith('plist_search_likes_')) {
        const plName = customId.replace('plist_search_likes_', '');
        const modal = new ModalBuilder().setCustomId(`modal_search_likes_${plName}`).setTitle('Cerca nella Playlist');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('search_query_input').setLabel('Nome canzone da cercare')
                .setStyle(TextInputStyle.Short).setMaxLength(50).setPlaceholder('Es: Bohemian Rhapsody...').setRequired(true)
        ));
        await interaction.showModal(modal);
        return true;
    }

    // --- Navigazione risultati ricerca ---
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

    // --- Crea nuova playlist ---
    if (customId === 'plist_create') {
        const modal = new ModalBuilder().setCustomId('modal_create_playlist').setTitle('Crea Nuova Playlist');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('playlist_name_input')
                .setLabel(`Nome playlist (max ${MAX_PLAYLIST_NAME_LENGTH} caratteri)`)
                .setStyle(TextInputStyle.Short).setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
                .setPlaceholder('Es: Rock, Chill, Preferiti...').setRequired(true)
        ));
        await interaction.showModal(modal);
        return true;
    }

    // --- Elimina playlist ---
    if (customId && customId.startsWith('plist_delete_likes_')) {
        const plName = customId.replace('plist_delete_likes_', '');
        if (plName === DEFAULT_PLAYLIST_NAME) {
            await safeReply(interaction, { content: `❌ La playlist "${DEFAULT_PLAYLIST_NAME}" non può essere eliminata.`, flags: MessageFlags.Ephemeral });
            return true;
        }
        const db = loadDatabase();
        const userData = getUserData(db, interaction.user.id);
        if (!userData.playlists[plName]) {
            await safeReply(interaction, { content: '❌ Playlist non trovata.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const deletedCount = userData.playlists[plName].length;
        delete userData.playlists[plName];
        if (userData.activePlaylist === plName) userData.activePlaylist = DEFAULT_PLAYLIST_NAME;
        // Pulisci ricerche attive relative a questa playlist
        activeSearches.delete(`${interaction.user.id}_likes_${plName}`);
        saveDatabase(db);
        await interaction.editReply(generatePlaylistView('likes', interaction.user.id, 0, DEFAULT_PLAYLIST_NAME));
        await safeReply(interaction, { content: `🗑️ Playlist **${plName}** eliminata (${deletedCount} canzoni rimosse).`, flags: MessageFlags.Ephemeral });
        return true;
    }

    // --- Rinomina playlist (apre modal) ---
    if (customId && customId.startsWith('plist_rename_likes_')) {
        const plName = customId.replace('plist_rename_likes_', '');
        if (plName === DEFAULT_PLAYLIST_NAME) {
            await safeReply(interaction, { content: `❌ La playlist "${DEFAULT_PLAYLIST_NAME}" non può essere rinominata.`, flags: MessageFlags.Ephemeral });
            return true;
        }
        const modal = new ModalBuilder().setCustomId(`modal_rename_playlist_${plName}`).setTitle('Rinomina Playlist');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('playlist_name_input')
                .setLabel(`Nuovo nome (max ${MAX_PLAYLIST_NAME_LENGTH} caratteri)`)
                .setStyle(TextInputStyle.Short).setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
                .setValue(plName).setRequired(true)
        ));
        await interaction.showModal(modal);
        return true;
    }

    // --- Apri playlist server/personale ---
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

    // --- Toggle canzone in playlist server ---
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
            try { require('../database/stats').recordPlaylistAdd(interaction.user.id, 'server'); } catch(e){}
        }
        saveDatabase(db);
        if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
        return true;
    }

    // --- Toggle canzone in playlist personale ---
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
            await safeReply(interaction, { content: `🗑️ Rimossa da: **${activePlName}**!`, flags: MessageFlags.Ephemeral });
        } else {
            playlist.push({ ...song });
            await safeReply(interaction, { content: `✅ Aggiunta a: **${activePlName}**!`, flags: MessageFlags.Ephemeral });
            try { require('../database/stats').recordPlaylistAdd(interaction.user.id, 'personal'); } catch(e){}
        }
        saveDatabase(db);
        return true;
    }

    return false;
}

module.exports = { handlePlaylist, activeSearches };
