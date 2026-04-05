/**
 * Handler per i modal submit (ricerca, creazione playlist, aggiunta canzone).
 * Estratti da interaction.js per modularità e crash-independence.
 */

const { MessageFlags } = require('discord.js');
const { loadDatabase, saveDatabase, getUserData, validatePlaylistName } = require('../database/playlists');
const { generateSearchResultsView, createDashboardComponents } = require('../ui');
const { getVideoInfo } = require('../utils/youtube');
const { clearFinishedQueue } = require('../queue/QueueManager');
const { saveQueueState } = require('../queue/persistence');
const { DEFAULT_PLAYLIST_NAME, MAX_PLAYLISTS_PER_USER } = require('../../config');
const { activeSearches } = require('./playlistHandlers');
const audio = require('../audio');

/**
 * Gestisce tutte le submission dei modal.
 */
async function handleModal(interaction, guildId, deps) {
    const modalCustomId = interaction.customId;

    // --- Cerca nella playlist server ---
    if (modalCustomId === 'modal_search_server') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const query = (interaction.fields.getTextInputValue('search_query_input') || '').trim();
            if (!query) return await interaction.editReply('❌ Inserisci un termine di ricerca.');
            activeSearches.set(`${interaction.user.id}_server_`, query);
            return await interaction.editReply(generateSearchResultsView('server', interaction.user.id, query, 0));
        } catch (e) {
            console.error('❌ [MODAL_SEARCH_SERVER] Errore:', e);
            return await interaction.editReply('❌ Errore durante la ricerca.');
        }
    }

    // --- Cerca nella playlist personale ---
    if (modalCustomId.startsWith('modal_search_likes_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const plName = modalCustomId.replace('modal_search_likes_', '');
            const query = (interaction.fields.getTextInputValue('search_query_input') || '').trim();
            if (!query) return await interaction.editReply('❌ Inserisci un termine di ricerca.');
            activeSearches.set(`${interaction.user.id}_likes_${plName}`, query);
            return await interaction.editReply(generateSearchResultsView('likes', interaction.user.id, query, 0, plName));
        } catch (e) {
            console.error('❌ [MODAL_SEARCH_LIKES] Errore:', e);
            return await interaction.editReply('❌ Errore durante la ricerca.');
        }
    }

    // --- Crea playlist ---
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
                return await interaction.editReply(`❌ Hai raggiunto il limite massimo di ${MAX_PLAYLISTS_PER_USER} playlist.`);
            }
            const existingNames = Object.keys(userData.playlists).map(n => n.toLowerCase());
            if (existingNames.includes(trimmedName.toLowerCase())) {
                return await interaction.editReply(`❌ Esiste già una playlist con il nome **${trimmedName}**.`);
            }
            userData.playlists[trimmedName] = [];
            userData.activePlaylist = trimmedName;
            saveDatabase(db);
            return await interaction.editReply(`✅ Playlist **${trimmedName}** creata! Ora è la tua playlist attiva.`);
        } catch (e) {
            console.error('❌ [MODAL_CREATE_PLAYLIST] Errore:', e);
            return await interaction.editReply('❌ Errore durante la creazione della playlist.');
        }
    }

    // --- Rinomina playlist ---
    if (modalCustomId.startsWith('modal_rename_playlist_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const oldName = modalCustomId.replace('modal_rename_playlist_', '');
            if (oldName === DEFAULT_PLAYLIST_NAME) {
                return await interaction.editReply(`❌ La playlist "${DEFAULT_PLAYLIST_NAME}" non può essere rinominata.`);
            }
            const trimmedName = (interaction.fields.getTextInputValue('playlist_name_input') || '').trim();
            const validation = validatePlaylistName(trimmedName);
            if (!validation.valid) return await interaction.editReply(`❌ ${validation.error}`);
            const db = loadDatabase();
            const userData = getUserData(db, interaction.user.id);
            if (!userData.playlists[oldName]) return await interaction.editReply('❌ Playlist originale non trovata.');
            const existingNames = Object.keys(userData.playlists).filter(n => n !== oldName).map(n => n.toLowerCase());
            if (existingNames.includes(trimmedName.toLowerCase())) {
                return await interaction.editReply(`❌ Esiste già una playlist con il nome **${trimmedName}**.`);
            }
            userData.playlists[trimmedName] = userData.playlists[oldName];
            delete userData.playlists[oldName];
            if (userData.activePlaylist === oldName) userData.activePlaylist = trimmedName;
            saveDatabase(db);
            return await interaction.editReply(`✅ Playlist rinominata: **${oldName}** → **${trimmedName}**`);
        } catch (e) {
            console.error('❌ [MODAL_RENAME_PLAYLIST] Errore:', e);
            return await interaction.editReply('❌ Errore durante la rinomina della playlist.');
        }
    }

    // --- Aggiungi canzone (modal_add_song) ---
    const serverQueue = await deps.ensureBotConnection(interaction);
    if (!serverQueue) return;
    serverQueue.isTaskRunning = true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        let found = [];
        try { found = await getVideoInfo(interaction.fields.getTextInputValue('song_input')); }
        catch (error) { serverQueue.isTaskRunning = false; return interaction.editReply("❌ Errore ricerca."); }

        if (found.length > 0) {
            clearFinishedQueue(serverQueue);
            found.forEach(s => serverQueue.songs.push({ ...s, requester: interaction.user.id }));
            saveQueueState(guildId, serverQueue);

            const needStartDueToMissingAudio = (!!serverQueue.currentDeckLoaded && (!serverQueue.connection || !serverQueue.mixer || !serverQueue.player));
            if (!serverQueue.currentDeckLoaded || needStartDueToMissingAudio) {
                if (interaction.member && interaction.member.voice && interaction.member.voice.channel) {
                    if (needStartDueToMissingAudio) {
                        serverQueue.currentDeckLoaded = null;
                        serverQueue.nextDeckLoaded = null;
                        if (serverQueue.mixer) {
                            try { serverQueue.mixer.kill(); } catch(e) {}
                        }
                        serverQueue.mixer = null;
                    }
                    if (!serverQueue.connection) await deps.connectToVoice(serverQueue, interaction);
                    try { await audio.playSong(interaction.guild.id, interaction); } catch(e) { console.error('playSong error after modal add', e); }
                } else {
                    if (serverQueue.nextDeckLoaded === null && serverQueue.songs.length >= 2) { await audio.updatePreloadAfterQueueChange(interaction.guild.id); }
                    if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
                }
            } else {
                if (serverQueue.nextDeckLoaded === null && serverQueue.songs.length >= 2) { await audio.updatePreloadAfterQueueChange(interaction.guild.id); }
                if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
            }
            if (found.length > 1) interaction.editReply(`✅ Aggiunte **${found.length}** canzoni.`); else interaction.deleteReply().catch(() => {});
        } else interaction.editReply('❌ Errore.');
    } finally { serverQueue.isTaskRunning = false; }
}

module.exports = handleModal;
