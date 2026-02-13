const { Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { queue } = require('../state/globals');
const { interactionCooldowns } = require('../state/globals');
const { audioOperationBarrier } = require('./AudioOperationBarrier');
const audio = require('../audio');
const { getCurrentSong, getNextSong, clearFinishedQueue, insertSongAtIndex } = require('../queue/QueueManager');
const { createCurrentSongEmbed, createDashboardComponents, updateDashboard, updateDashboardToFinished, refreshDashboard, generatePlaylistView, generateSearchResultsView } = require('../ui');
const { sanitizeTitle, areSameSong, safeParseInt, getYoutubeId } = require('../utils/sanitize');
const { getVideoInfo } = require('../utils/youtube');
const { loadDatabase, saveDatabase, getUserData, getUserPlaylist, getActivePlaylistName, setActivePlaylist, getUserPlaylistNames, validatePlaylistName } = require('../database/playlists');
const { saveQueueState } = require('../queue/persistence');
const { safeReply, cleanupOldMessages } = require('../utils/discord');
const { DEFAULT_SONG_DURATION_S, MAX_QUEUE_SIZE, CROSSFADE_DURATION_MS, PRELOAD_SONGS_TIMEOUT_MS, DEFAULT_PLAYLIST_NAME, MAX_PLAYLIST_NAME_LENGTH } = require('../../config');
const SkipManager = require('../audio/SkipManager');

// Mappa in-memory per query di ricerca attive (per paginazione risultati)
// Key: `${userId}_${type}_${plName || ''}`, Value: stringa di ricerca
const activeSearches = new Map();

// Throttle map per operazioni audio critiche (mixer restart, skip, prev)
// NOTA: Sostituito con AudioOperationBarrier per serializzazione globale

module.exports = function registerInteractionHandlers(client, deps) {
    client.on(Events.InteractionCreate, async interaction => {
        try { console.log('[INTERACTION] type=', interaction.type, 'id=', interaction.id, 'user=', interaction.user?.tag, 'customId=', interaction.customId || null); } catch(e){}
        try {
            if (interaction.isChatInputCommand()) {
                // Prova a inoltrare al registro comandi se disponibile
                let commands = {};
                try { commands = require('../commands'); } catch (e) { /* ignora */ }
                const cmd = commands[interaction.commandName];
                if (cmd && typeof cmd.execute === 'function') {
                    try { await cmd.execute(interaction, deps); } catch (e) { console.error('Command execute error', e); }
                    return;
                }
            }

            else if (interaction.isButton() || interaction.isStringSelectMenu()) {
                const guildId = interaction.guildId;
                const customId = interaction.customId;

                // Percorso rapido per l'apertura del modal
                if (customId === 'btn_add_modal') {
                    const modal = new ModalBuilder().setCustomId('modal_add_song').setTitle('Aggiungi Canzone');
                    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('song_input').setLabel("Link o Nome").setStyle(TextInputStyle.Short)));
                    await interaction.showModal(modal);
                    return;
                }

                // Defer dell'update per la maggior parte dei pulsanti (salvo quelli ad aggiornamento immediato o che aprono modal)
                const immediateUpdateButtons = ['btn_loop', 'btn_shuffle', 'btn_fade'];
                const modalButtons = ['plist_create', 'plist_search_server'];
                const isModalButton = modalButtons.includes(customId) || customId.startsWith('plist_rename_likes_') || customId.startsWith('plist_search_likes_');
                if (customId !== 'btn_add_modal' && !immediateUpdateButtons.includes(customId) && !isModalButton) {
                    try { await interaction.deferUpdate(); } catch(e){}
                }

                const now = Date.now();
                if (interactionCooldowns.has(guildId)) {
                    if (now < interactionCooldowns.get(guildId) + 200) return; // piccolo debounce
                }
                interactionCooldowns.set(guildId, now);

                const serverQueue = await deps.ensureBotConnection(interaction);
                if (!serverQueue) return;

                if (!serverQueue.dashboardMessage && interaction.message) serverQueue.dashboardMessage = interaction.message;

                // Playlist select
                if (customId === 'plist_select_song') {
                    const rawValue = interaction.values[0];
                    const parts = rawValue.split('_');
                    let items, songType, songIndex, songPage, plName;

                    if (parts[0] === 'server') {
                        // server_{index}_{page}
                        songType = 'server';
                        songIndex = safeParseInt(parts[1], -1);
                        songPage = parts[2];
                        plName = null;
                        items = loadDatabase().server;
                    } else {
                        // likes_{playlistName}_{index}_{page}
                        songType = 'likes';
                        // Il nome playlist può NON contenere _ (validazione), quindi parts[1] è il nome
                        plName = parts[1];
                        songIndex = safeParseInt(parts[2], -1);
                        songPage = parts[3];
                        const db = loadDatabase();
                        items = getUserPlaylist(db, interaction.user.id, plName);
                    }

                    if (songIndex < 0 || songIndex >= items.length) return await safeReply(interaction, { content: '❌ Canzone non trovata', flags: MessageFlags.Ephemeral });

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
                    return await interaction.editReply({ embeds: [embed], components: [row] });
                }

                // Playlist switch (cambio playlist attiva nella vista personale)
                if (customId === 'plist_switch_likes') {
                    const selectedName = interaction.values[0];
                    const db = loadDatabase();
                    setActivePlaylist(db, interaction.user.id, selectedName);
                    saveDatabase(db);
                    return await interaction.editReply(generatePlaylistView('likes', interaction.user.id, 0, selectedName));
                }

                // Playlist: play all (plist_playall_{type}) e paginazione (plist_prev_{type}_{page}, plist_next_{type}_{page})
                    if (customId && customId.startsWith('plist_playall_')) {
                    const parts = customId.split('_');
                    const type = parts[2]; // 'server' o 'likes'
                    const db = loadDatabase();
                    let items;
                    if (type === 'server') {
                        items = db.server;
                    } else {
                        // plist_playall_likes_{plName}
                        const plName = parts.slice(3).join('_'); // supporto nomi con eventuali spazi (non _)
                        items = getUserPlaylist(db, interaction.user.id, plName);
                    }
                    if (!items || items.length === 0) return await safeReply(interaction, { content: '❌ Playlist vuota', flags: MessageFlags.Ephemeral });
                    // Costruisci l'array e mescola prima di aggiungere (Play All deve randomizzare come btn_shuffle)
                    let toAdd = items.map(s => ({ ...s, requester: interaction.user.id }));
                    // Shuffle Fisher-Yates
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
                    return await safeReply(interaction, { content: `✅ Aggiunte ${toAdd.length} canzoni dalla playlist.`, flags: MessageFlags.Ephemeral });
                }

                if (customId && (customId.startsWith('plist_prev_') || customId.startsWith('plist_next_'))) {
                    const parts = customId.split('_');
                    const dir = parts[1]; // 'prev' o 'next'
                    const type = parts[2]; // 'server' o 'likes'
                    let newPage, plName = null;
                    if (type === 'server') {
                        // plist_prev_server_{page}
                        const page = safeParseInt(parts[3], 0);
                        newPage = dir === 'prev' ? page - 1 : page + 1;
                    } else {
                        // plist_prev_likes_{plName}_{page}
                        plName = parts[3];
                        const page = safeParseInt(parts[4], 0);
                        newPage = dir === 'prev' ? page - 1 : page + 1;
                    }
                    return await interaction.editReply(generatePlaylistView(type, interaction.user.id, newPage, plName));
                }

                    // act_ handlers (azioni playlist)
                if (customId && customId.startsWith('act_')) {
                    const parts = customId.split('_');
                    // parts[1] = action (back/remove/play), parts[2] = type (server/likes)

                    if (parts[1] === 'back') {
                        if (parts[2] === 'server') {
                            // act_back_server_{page}
                            return await interaction.editReply(generatePlaylistView('server', interaction.user.id, safeParseInt(parts[3], 0)));
                        } else {
                            // act_back_likes_{plName}_{page}
                            const plName = parts[3];
                            const page = safeParseInt(parts[4], 0);
                            return await interaction.editReply(generatePlaylistView('likes', interaction.user.id, page, plName));
                        }
                    }

                    if (parts[1] === 'remove') {
                        const db = loadDatabase();
                        if (parts[2] === 'server') {
                            // act_remove_server_{index}_{page}
                            const index = safeParseInt(parts[3], -1);
                            const page = safeParseInt(parts[4], 0);
                            if (index < 0) return;
                            if (index < db.server.length) db.server.splice(index, 1);
                            saveDatabase(db);
                            return await interaction.editReply(generatePlaylistView('server', interaction.user.id, page));
                        } else {
                            // act_remove_likes_{plName}_{index}_{page}
                            const plName = parts[3];
                            const index = safeParseInt(parts[4], -1);
                            const page = safeParseInt(parts[5], 0);
                            if (index < 0) return;
                            const userData = getUserData(db, interaction.user.id);
                            if (userData.playlists[plName] && index < userData.playlists[plName].length) {
                                userData.playlists[plName].splice(index, 1);
                            }
                            saveDatabase(db);
                            return await interaction.editReply(generatePlaylistView('likes', interaction.user.id, page, plName));
                        }
                    }

                    if (parts[1] === 'play') {
                        let items, songIndex;
                        if (parts[2] === 'server') {
                            // act_play_server_{index}
                            items = loadDatabase().server;
                            songIndex = safeParseInt(parts[3], -1);
                        } else {
                            // act_play_likes_{plName}_{index}
                            const plName = parts[3];
                            const db = loadDatabase();
                            items = getUserPlaylist(db, interaction.user.id, plName);
                            songIndex = safeParseInt(parts[4], -1);
                        }
                        if (songIndex < 0 || songIndex >= items.length) return;
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
                        return await safeReply(interaction, { content: `🚀 Avviata: **${song.title}**`, flags: MessageFlags.Ephemeral });
                    }
                }

                // Gestione playlist: Cerca nella playlist (apre modal)
                if (customId === 'plist_search_server') {
                    const modal = new ModalBuilder().setCustomId('modal_search_server').setTitle('Cerca nella Playlist Server');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('search_query_input')
                            .setLabel('Nome canzone da cercare')
                            .setStyle(TextInputStyle.Short)
                            .setMaxLength(50)
                            .setPlaceholder('Es: Bohemian Rhapsody...')
                            .setRequired(true)
                    ));
                    await interaction.showModal(modal);
                    return;
                }

                if (customId && customId.startsWith('plist_search_likes_')) {
                    const plName = customId.replace('plist_search_likes_', '');
                    const modal = new ModalBuilder().setCustomId(`modal_search_likes_${plName}`).setTitle('Cerca nella Playlist');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('search_query_input')
                            .setLabel('Nome canzone da cercare')
                            .setStyle(TextInputStyle.Short)
                            .setMaxLength(50)
                            .setPlaceholder('Es: Bohemian Rhapsody...')
                            .setRequired(true)
                    ));
                    await interaction.showModal(modal);
                    return;
                }

                // Gestione ricerca: navigazione risultati e ritorno alla playlist
                if (customId && (customId.startsWith('srch_prev_') || customId.startsWith('srch_next_'))) {
                    const parts = customId.split('_');
                    const dir = parts[1]; // 'prev' o 'next'
                    const type = parts[2]; // 'server' o 'likes'
                    let newPage, plName = null;
                    if (type === 'server') {
                        const page = safeParseInt(parts[3], 0);
                        newPage = dir === 'prev' ? page - 1 : page + 1;
                    } else {
                        plName = parts[3];
                        const page = safeParseInt(parts[4], 0);
                        newPage = dir === 'prev' ? page - 1 : page + 1;
                    }
                    const searchKey = `${interaction.user.id}_${type}_${plName || ''}`;
                    const query = activeSearches.get(searchKey);
                    if (!query) {
                        return await interaction.editReply(generatePlaylistView(type, interaction.user.id, 0, plName));
                    }
                    return await interaction.editReply(generateSearchResultsView(type, interaction.user.id, query, newPage, plName));
                }

                if (customId && customId.startsWith('srch_back_')) {
                    const parts = customId.split('_');
                    const type = parts[2]; // 'server' o 'likes'
                    let plName = null;
                    if (type === 'likes') {
                        plName = parts.slice(3).join('_');
                    }
                    const searchKey = `${interaction.user.id}_${type}_${plName || ''}`;
                    activeSearches.delete(searchKey);
                    return await interaction.editReply(generatePlaylistView(type, interaction.user.id, 0, plName));
                }

                // Gestione playlist: Crea nuova playlist (apre modal)
                if (customId === 'plist_create') {
                    const modal = new ModalBuilder().setCustomId('modal_create_playlist').setTitle('Crea Nuova Playlist');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('playlist_name_input')
                            .setLabel(`Nome playlist (max ${MAX_PLAYLIST_NAME_LENGTH} caratteri)`)
                            .setStyle(TextInputStyle.Short)
                            .setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
                            .setPlaceholder('Es: Rock, Chill, Preferiti...')
                            .setRequired(true)
                    ));
                    await interaction.showModal(modal);
                    return;
                }

                // Gestione playlist: Elimina playlist
                if (customId && customId.startsWith('plist_delete_likes_')) {
                    const plName = customId.replace('plist_delete_likes_', '');
                    if (plName === DEFAULT_PLAYLIST_NAME) {
                        return await safeReply(interaction, { content: `❌ La playlist "${DEFAULT_PLAYLIST_NAME}" non può essere eliminata.`, flags: MessageFlags.Ephemeral });
                    }
                    const db = loadDatabase();
                    const userData = getUserData(db, interaction.user.id);
                    if (!userData.playlists[plName]) {
                        return await safeReply(interaction, { content: '❌ Playlist non trovata.', flags: MessageFlags.Ephemeral });
                    }
                    const deletedCount = userData.playlists[plName].length;
                    delete userData.playlists[plName];
                    if (userData.activePlaylist === plName) {
                        userData.activePlaylist = DEFAULT_PLAYLIST_NAME;
                    }
                    saveDatabase(db);
                    // Ri-renderizza con la playlist Generale
                    await interaction.editReply(generatePlaylistView('likes', interaction.user.id, 0, DEFAULT_PLAYLIST_NAME));
                    return await safeReply(interaction, { content: `🗑️ Playlist **${plName}** eliminata (${deletedCount} canzoni rimosse).`, flags: MessageFlags.Ephemeral });
                }

                // Gestione playlist: Rinomina playlist (apre modal)
                if (customId && customId.startsWith('plist_rename_likes_')) {
                    const plName = customId.replace('plist_rename_likes_', '');
                    if (plName === DEFAULT_PLAYLIST_NAME) {
                        return await safeReply(interaction, { content: `❌ La playlist "${DEFAULT_PLAYLIST_NAME}" non può essere rinominata.`, flags: MessageFlags.Ephemeral });
                    }
                    const modal = new ModalBuilder().setCustomId(`modal_rename_playlist_${plName}`).setTitle('Rinomina Playlist');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('playlist_name_input')
                            .setLabel(`Nuovo nome (max ${MAX_PLAYLIST_NAME_LENGTH} caratteri)`)
                            .setStyle(TextInputStyle.Short)
                            .setMaxLength(MAX_PLAYLIST_NAME_LENGTH)
                            .setValue(plName)
                            .setRequired(true)
                    ));
                    await interaction.showModal(modal);
                    return;
                }

                // Altri casi di pulsanti
                switch (customId) {
                    case 'btn_clear_queue': {
                        const currentSongClear = getCurrentSong(serverQueue);
                        serverQueue.songs = currentSongClear ? [currentSongClear] : [];
                        serverQueue.playIndex = 0;
                        serverQueue.history = [];
                        serverQueue.nextDeckLoaded = null;
                        serverQueue.nextDeckTarget = null;
                        saveQueueState(guildId, serverQueue);
                        try { await audio.updatePreloadAfterQueueChange(guildId); } catch(e) {}
                        if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
                        return;
                    }

                    case 'btn_pause': {
                        // Usa il nuovo state machine atomico per pause/resume
                        try {
                            const result = await audio.togglePauseResume(guildId, serverQueue, {
                                connectToVoice: deps.connectToVoice
                            });

                            if (!result.success) {
                                console.error(`❌ [PAUSE-BUTTON] ${result.error}`);
                                await safeReply(interaction, {
                                    content: `❌ Errore durante ${result.action === 'pause' ? 'pausa' : 'ripresa'}.`,
                                    flags: MessageFlags.Ephemeral
                                }).catch(() => {});
                                return;
                            }

                            console.log(`✅ [PAUSE-BUTTON] Azione completata: ${result.action}`);

                            // Salva lo stato e aggiorna UI
                            saveQueueState(guildId, serverQueue);
                            try {
                                await interaction.update({
                                    components: createDashboardComponents(serverQueue, interaction.user.id)
                                });
                            } catch(e) {
                                if (serverQueue.dashboardMessage) {
                                    serverQueue.dashboardMessage.edit({
                                        components: createDashboardComponents(serverQueue, interaction.user.id)
                                    }).catch(()=>{});
                                }
                            }

                        } catch (e) {
                            console.error('❌ [PAUSE-BUTTON] Fatal error:', e);
                            await safeReply(interaction, {
                                content: '❌ Errore critico durante la pausa.',
                                flags: MessageFlags.Ephemeral
                            }).catch(() => {});
                        }
                        return;
                    }

                    case 'btn_yt_mix': {
                        serverQueue.isTaskRunning = true;
                        let statusMsg = null;
                        try { statusMsg = await interaction.followUp({ content: '✨ **Generazione Mix YouTube in corso...**', flags: MessageFlags.Ephemeral }); } catch(e) {}
                        try {
                            const db = loadDatabase();
                            const currentSongForMix = getCurrentSong(serverQueue);
                            let seedSource = db.server.length > 0 ? db.server : (currentSongForMix ? [currentSongForMix] : serverQueue.history);
                            if (!seedSource || seedSource.length === 0) { if(statusMsg) await statusMsg.edit({ content: '❌ Serve almeno una canzone salvata o in riproduzione per generare un Mix!' }).catch(() => {}); return; }
                            const randomSong = seedSource[Math.floor(Math.random() * seedSource.length)];
                            const videoId = getYoutubeId(randomSong.url);
                            if (!videoId) throw new Error("ID Video non valido");
                            const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
                            const songsFound = await getVideoInfo(mixUrl);
                            if (songsFound && songsFound.length > 0) {
                                const currentMixSong = getCurrentSong(serverQueue);
                                if (currentMixSong && areSameSong(songsFound[0].url, currentMixSong.url)) songsFound.shift();
                                if (serverQueue.songs.length + serverQueue.history.length + songsFound.length > MAX_QUEUE_SIZE) { if(statusMsg) await statusMsg.edit({ content: `❌ **Limite Coda Raggiunto!**` }).catch(() => {}); return; }
                                clearFinishedQueue(serverQueue);
                                songsFound.forEach(s => serverQueue.songs.push({ ...s, requester: interaction.user.id }));
                                saveQueueState(guildId, serverQueue);
                                if (!serverQueue.currentDeckLoaded) {
                                    const connected = await deps.connectToVoice(serverQueue, interaction);
                                    if (connected) audio.playSong(interaction.guild.id);
                                } else {
                                    if (serverQueue.nextDeckLoaded === null && serverQueue.songs.length >= 2) { await audio.updatePreloadAfterQueueChange(guildId); }
                                    if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
                                }
                                if(statusMsg) await statusMsg.edit({ content: `✨ Generato Mix YouTube da: **${sanitizeTitle(randomSong.title)}**` }).catch(() => {});
                            } else { if(statusMsg) await statusMsg.edit({ content: '❌ Nessuna canzone trovata nel Mix.' }).catch(() => {}); }
                        } catch (e) {
                            console.error("Errore Mix:", e);
                            if(statusMsg) await statusMsg.edit({ content: '❌ Errore durante la generazione del Mix.' }).catch(() => {});
                        } finally { serverQueue.isTaskRunning = false; }
                        return;
                    }

                    case 'open_plist_server':
                        return await safeReply(interaction, generatePlaylistView('server', interaction.user.id, 0));
                    case 'open_plist_likes': {
                        const dbLikes = loadDatabase();
                        const activePl = getActivePlaylistName(dbLikes, interaction.user.id);
                        return await safeReply(interaction, generatePlaylistView('likes', interaction.user.id, 0, activePl));
                    }

                    case 'plist_prev':
                    case 'plist_next':
                        // handled by components' customId patterns elsewhere
                        return;

                    case 'btn_replay': {
                        // Se sessione ripristinata senza mixer, avvia
                        if (serverQueue.sessionRestored && !serverQueue.currentDeckLoaded && serverQueue.songs && serverQueue.songs.length > 0) {
                            serverQueue.sessionRestored = false; serverQueue.isPaused = false;
                            const connected = await deps.connectToVoice(serverQueue, interaction);
                            if (connected) await audio.playSong(interaction.guild.id, interaction);
                            return;
                        }
                        if (serverQueue.currentDeckLoaded) {
                            // In riproduzione: riavvia la canzone corrente
                            await audio.restartCurrentSong(interaction.guild.id);
                        } else if (serverQueue.songs.length > 0) {
                            // Coda terminata: replay dell'ultima canzone
                            serverQueue.playIndex = 0;
                            serverQueue.currentDeckLoaded = null;
                            const connected = await deps.connectToVoice(serverQueue, interaction);
                            if (connected) await audio.playSong(interaction.guild.id, interaction);
                        }
                        return;
                    }

                    case 'btn_skip': {
                        // Usa AudioOperationBarrier per serializzare skip con altre operazioni audio
                        const result = await audioOperationBarrier.request(
                            guildId,
                            'skip',
                            async () => {
                                // Se sessione ripristinata senza mixer, avvia
                                if (serverQueue.sessionRestored && !serverQueue.currentDeckLoaded && serverQueue.songs.length > 1) {
                                    serverQueue.sessionRestored = false; serverQueue.isPaused = false;
                                    await audio.playSong(interaction.guildId);
                                    return;
                                }
                                
                                // Se nessun deck è caricato e il mixer non è vivo, avvia la riproduzione prima dello skip
                                if (!serverQueue.currentDeckLoaded && (!serverQueue.mixer || !serverQueue.mixer.isProcessAlive())) {
                                    if (serverQueue.songs && serverQueue.songs.length > 0) {
                                        const connected = await deps.connectToVoice(serverQueue, interaction);
                                        if (connected) await audio.playSong(interaction.guildId, interaction);
                                        return;
                                    }
                                }
                                
                                // Usa il nuovo SkipManager unificato
                                await SkipManager.skipNext(guildId);
                            },
                            { timeout: 10000, minThrottle: 2000 }
                        );

                        if (result.throttled) {
                            console.warn(`⏳ [SKIP] Operazione throttled`);
                        } else if (!result.success) {
                            console.error(`❌ [SKIP] Errore:`, result.error?.message);
                            await safeReply(interaction, {
                                content: '❌ Impossibile eseguire skip. Riprova tra un attimo.',
                                flags: MessageFlags.Ephemeral
                            }).catch(() => {});
                        }
                        return;
                    }

                    case 'btn_prev': {
                        // Usa AudioOperationBarrier per serializzare prev con altre operazioni audio
                        const result = await audioOperationBarrier.request(
                            guildId,
                            'prev',
                            async () => {
                                // Se nessun deck è caricato e il mixer non è vivo...
                                if (!serverQueue.currentDeckLoaded && (!serverQueue.mixer || !serverQueue.mixer.isProcessAlive())) {
                                    // Se la sessione è stata ripristinata, decrementa il playIndex prima di avviare
                                    if (serverQueue.sessionRestored) {
                                        const newIndex = (serverQueue.playIndex || 0) - 1;
                                        if (newIndex >= 0) {
                                            serverQueue.playIndex = newIndex;
                                        }
                                    }
                                    
                                    if (serverQueue.songs && serverQueue.songs.length > 0) {
                                        const connected = await deps.connectToVoice(serverQueue, interaction);
                                        if (connected) await audio.playSong(interaction.guildId, interaction);
                                        return;
                                    }
                                }
                                
                                // Usa il nuovo SkipManager unificato
                                await SkipManager.skipPrev(guildId);
                            },
                            { timeout: 10000, minThrottle: 2000 }
                        );

                        if (result.throttled) {
                            console.warn(`⏳ [PREV] Operazione throttled`);
                        } else if (!result.success) {
                            console.error(`❌ [PREV] Errore:`, result.error?.message);
                        }
                        return;
                    }

                    case 'btn_toggle_server': {
                        const sServer = getCurrentSong(serverQueue);
                        if (!sServer) return;
                        const dbServer = loadDatabase();
                        const idxServer = (dbServer.server || []).findIndex(x => areSameSong(x.url, sServer.url));
                        if (idxServer !== -1) {
                            dbServer.server.splice(idxServer, 1);
                        } else {
                            if (!dbServer.server) dbServer.server = [];
                            dbServer.server.push({ ...sServer, addedBy: interaction.user.id });
                            try { require('../database/stats').recordPlaylistAdd(interaction.user.id, 'server'); } catch(e){}
                        }
                        saveDatabase(dbServer);
                        if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
                        return;
                    }

                    case 'btn_toggle_like': {
                        const sPersonal = getCurrentSong(serverQueue);
                        if (!sPersonal) return;
                        const dbPersonal = loadDatabase();
                        const userDataToggle = getUserData(dbPersonal, interaction.user.id);
                        const activePlName = userDataToggle.activePlaylist || DEFAULT_PLAYLIST_NAME;
                        if (!userDataToggle.playlists[activePlName]) userDataToggle.playlists[activePlName] = [];
                        const playlist = userDataToggle.playlists[activePlName];
                        const idxPersonal = playlist.findIndex(x => areSameSong(x.url, sPersonal.url));
                        let messageText = '';
                        if (idxPersonal !== -1) {
                            playlist.splice(idxPersonal, 1);
                            messageText = `🗑️ Rimossa da: **${activePlName}**!`;
                        } else {
                            playlist.push({ ...sPersonal });
                            messageText = `✅ Aggiunta a: **${activePlName}**!`;
                            try { require('../database/stats').recordPlaylistAdd(interaction.user.id, 'personal'); } catch(e){}
                        }
                        saveDatabase(dbPersonal);
                        await safeReply(interaction, { content: messageText, flags: MessageFlags.Ephemeral });
                        return;
                    }

                    case 'select_queue': {
                        // Usa AudioOperationBarrier per serializzare skip to index
                        const result = await audioOperationBarrier.request(
                            guildId,
                            'skipToIndex',
                            async () => {
                                const targetIdx = safeParseInt(interaction.values[0], -1);
                                if (targetIdx < 0 || targetIdx >= serverQueue.songs.length) return;
                                if (targetIdx === (serverQueue.playIndex || 0)) return; // Già in riproduzione
                                
                                // Esegui skip verso l'indice selezionato
                                await SkipManager.skipToIndex(guildId, targetIdx);
                            },
                            { timeout: 10000, minThrottle: 2000 }
                        );

                        if (result.throttled) {
                            console.warn(`⏳ [SELECT-QUEUE] Operazione throttled`);
                        } else if (!result.success) {
                            console.error(`❌ [SELECT-QUEUE] Errore:`, result.error?.message);
                        }
                        return;
                    }

                    case 'btn_loop': {
                        serverQueue.loopEnabled = !serverQueue.loopEnabled;
                        // Sincronizza loop mode con il mixer Rust per auto-gapless
                        if (serverQueue.mixer && serverQueue.mixer.isProcessAlive()) {
                            try { serverQueue.mixer.setLoop(serverQueue.loopEnabled); } catch(e) {}
                        }
                        saveQueueState(guildId, serverQueue);
                        try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); } catch(e) { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{}); }
                        return;
                    }

                    case 'btn_shuffle': {
                        if (serverQueue.songs.length >= 2) {
                            const currentIdx = serverQueue.playIndex || 0;
                            // Tieni le canzoni fino all'indice corrente (incluso), shuffla solo le successive
                            const before = serverQueue.songs.slice(0, currentIdx + 1);
                            const after = serverQueue.songs.slice(currentIdx + 1);
                            for (let i = after.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [after[i], after[j]] = [after[j], after[i]]; }
                            serverQueue.songs = [...before, ...after];
                            // Invalida preload (l'ordine è cambiato)
                            serverQueue.nextDeckLoaded = null;
                            serverQueue.nextDeckTarget = null;
                            saveQueueState(guildId, serverQueue);
                            try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); } catch(e) { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{}); }
                            audio.updatePreloadAfterQueueChange(guildId).catch(()=>{});
                        } else { try { await interaction.deferUpdate(); } catch(e){} }
                        return;
                    }

                    case 'btn_fade': {
                        serverQueue.fadeEnabled = !serverQueue.fadeEnabled; saveQueueState(guildId, serverQueue);
                        // Node.js gestisce la decisione crossfade vs istantaneo – nessun comando a Rust
                        try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); } catch(e) { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{}); }
                        return;
                    }
                }
            }

            else if (interaction.isModalSubmit()) {
                const guildId = interaction.guildId;
                const modalCustomId = interaction.customId;

                // --- Modal: Cerca nella playlist server ---
                if (modalCustomId === 'modal_search_server') {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    try {
                        const rawQuery = interaction.fields.getTextInputValue('search_query_input');
                        const query = rawQuery ? rawQuery.trim() : '';
                        if (!query) {
                            return await interaction.editReply('❌ Inserisci un termine di ricerca.');
                        }
                        const searchKey = `${interaction.user.id}_server_`;
                        activeSearches.set(searchKey, query);
                        return await interaction.editReply(generateSearchResultsView('server', interaction.user.id, query, 0));
                    } catch (e) {
                        console.error('❌ [MODAL_SEARCH_SERVER] Errore:', e);
                        return await interaction.editReply('❌ Errore durante la ricerca.');
                    }
                }

                // --- Modal: Cerca nella playlist personale ---
                if (modalCustomId.startsWith('modal_search_likes_')) {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    try {
                        const plName = modalCustomId.replace('modal_search_likes_', '');
                        const rawQuery = interaction.fields.getTextInputValue('search_query_input');
                        const query = rawQuery ? rawQuery.trim() : '';
                        if (!query) {
                            return await interaction.editReply('❌ Inserisci un termine di ricerca.');
                        }
                        const searchKey = `${interaction.user.id}_likes_${plName}`;
                        activeSearches.set(searchKey, query);
                        return await interaction.editReply(generateSearchResultsView('likes', interaction.user.id, query, 0, plName));
                    } catch (e) {
                        console.error('❌ [MODAL_SEARCH_LIKES] Errore:', e);
                        return await interaction.editReply('❌ Errore durante la ricerca.');
                    }
                }

                // --- Modal: Crea playlist ---
                if (modalCustomId === 'modal_create_playlist') {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    try {
                        const rawName = interaction.fields.getTextInputValue('playlist_name_input');
                        const trimmedName = rawName ? rawName.trim() : '';
                        const validation = validatePlaylistName(trimmedName);
                        if (!validation.valid) {
                            return await interaction.editReply(`❌ ${validation.error}`);
                        }
                        // Case-insensitive check per duplicati
                        const db = loadDatabase();
                        const userData = getUserData(db, interaction.user.id);
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

                // --- Modal: Rinomina playlist ---
                if (modalCustomId.startsWith('modal_rename_playlist_')) {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    try {
                        const oldName = modalCustomId.replace('modal_rename_playlist_', '');
                        if (oldName === DEFAULT_PLAYLIST_NAME) {
                            return await interaction.editReply(`❌ La playlist "${DEFAULT_PLAYLIST_NAME}" non può essere rinominata.`);
                        }
                        const rawName = interaction.fields.getTextInputValue('playlist_name_input');
                        const trimmedName = rawName ? rawName.trim() : '';
                        const validation = validatePlaylistName(trimmedName);
                        if (!validation.valid) {
                            return await interaction.editReply(`❌ ${validation.error}`);
                        }
                        const db = loadDatabase();
                        const userData = getUserData(db, interaction.user.id);
                        if (!userData.playlists[oldName]) {
                            return await interaction.editReply('❌ Playlist originale non trovata.');
                        }
                        // Case-insensitive check (escludi il nome corrente)
                        const existingNames = Object.keys(userData.playlists).filter(n => n !== oldName).map(n => n.toLowerCase());
                        if (existingNames.includes(trimmedName.toLowerCase())) {
                            return await interaction.editReply(`❌ Esiste già una playlist con il nome **${trimmedName}**.`);
                        }
                        // Rinomina: copia dati sotto nuovo nome, elimina vecchio
                        userData.playlists[trimmedName] = userData.playlists[oldName];
                        delete userData.playlists[oldName];
                        if (userData.activePlaylist === oldName) {
                            userData.activePlaylist = trimmedName;
                        }
                        saveDatabase(db);
                        return await interaction.editReply(`✅ Playlist rinominata: **${oldName}** → **${trimmedName}**`);
                    } catch (e) {
                        console.error('❌ [MODAL_RENAME_PLAYLIST] Errore:', e);
                        return await interaction.editReply('❌ Errore durante la rinomina della playlist.');
                    }
                }

                // --- Modal: Aggiungi canzone ---
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

                        // Log di debug sullo stato della sessione/connessione per diagnostica post-restart
                        try {
                            console.log('[MODAL_ADD] sessionRestored=', !!serverQueue.sessionRestored, 'currentDeckLoaded=', !!serverQueue.currentDeckLoaded, 'hasConnection=', !!serverQueue.connection, 'hasMixer=', !!serverQueue.mixer, 'hasPlayer=', !!serverQueue.player);
                        } catch(e){}

                        // Se non è stato caricato un deck corrente o se il deck risulta caricato
                        // ma non esiste una connessione/mixer/ player attivi, proviamo a connetterci e avviare la riproduzione.
                        const needStartDueToMissingAudio = (!!serverQueue.currentDeckLoaded && (!serverQueue.connection || !serverQueue.mixer || !serverQueue.player));
                        if (!serverQueue.currentDeckLoaded || needStartDueToMissingAudio) {
                            if (interaction.member && interaction.member.voice && interaction.member.voice.channel) {
                                // Se il deck risulta caricato ma mancano componenti audio (mixer/connection/player),
                                // resettiamo lo stato del deck così che `playSong` esegua la procedura di avvio del mixer.
                                if (needStartDueToMissingAudio) {
                                    try {
                                        console.log('[MODAL_ADD] Reset currentDeckLoaded to force mixer start');
                                        serverQueue.currentDeckLoaded = null;
                                        serverQueue.nextDeckLoaded = null;
                                        serverQueue.mixer = null;
                                    } catch(e) { console.error('Error resetting deck state', e); }
                                }
                                if (!serverQueue.connection) await deps.connectToVoice(serverQueue, interaction);
                                try { await audio.playSong(interaction.guild.id, interaction); } catch(e) { console.error('playSong error after modal add', e); }
                            } else {
                                // Nessun canale vocale: aggiorniamo solo preload/dashboard
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
        } catch (e) { console.error("Errore Handler:", e); }
    });
};
