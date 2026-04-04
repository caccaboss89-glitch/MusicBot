const { Events, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { interactionCooldowns } = require('../state/globals');
const { audioOperationBarrier } = require('./AudioOperationBarrier');
const audio = require('../audio');
const { getCurrentSong, clearFinishedQueue } = require('../queue/QueueManager');
const { createDashboardComponents } = require('../ui');
const { sanitizeTitle, areSameSong, safeParseInt, getYoutubeId } = require('../utils/sanitize');
const { getVideoInfo } = require('../utils/youtube');
const { loadDatabase } = require('../database/playlists');
const { saveQueueState } = require('../queue/persistence');
const { safeReply } = require('../utils/discord');
const { MAX_QUEUE_SIZE } = require('../../config');
const SkipManager = require('../audio/SkipManager');
const { handlePlaylist } = require('./playlistHandlers');
const handleModal = require('./modalHandlers');

// ─── Button Handlers ────────────────────────────────────────

async function handleClearQueue(interaction, serverQueue, guildId) {
    const currentSong = getCurrentSong(serverQueue);
    serverQueue.songs = currentSong ? [currentSong] : [];
    serverQueue.playIndex = 0;
    serverQueue.history = [];
    serverQueue.nextDeckLoaded = null;
    serverQueue.nextDeckTarget = null;
    saveQueueState(guildId, serverQueue);
    try { await audio.updatePreloadAfterQueueChange(guildId); } catch(e) {}
    if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
}

async function handlePause(interaction, serverQueue, guildId, deps) {
    const result = await audio.togglePauseResume(guildId, serverQueue, { connectToVoice: deps.connectToVoice });
    if (!result.success) {
        console.error(`❌ [PAUSE-BUTTON] ${result.error}`);
        await safeReply(interaction, { content: `❌ Errore durante ${result.action === 'pause' ? 'pausa' : 'ripresa'}.`, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
    }
    saveQueueState(guildId, serverQueue);
    try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); }
    catch(e) { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{}); }
}

async function handleYtMix(interaction, serverQueue, guildId, deps) {
    serverQueue.isTaskRunning = true;
    let statusMsg = null;
    try { statusMsg = await interaction.followUp({ content: '✨ **Generazione Mix YouTube in corso...**', flags: MessageFlags.Ephemeral }); } catch(e) {}
    try {
        const db = loadDatabase();
        const currentSong = getCurrentSong(serverQueue);
        let seedSource = db.server.length > 0 ? db.server : (currentSong ? [currentSong] : serverQueue.history);
        if (!seedSource || seedSource.length === 0) { if(statusMsg) await statusMsg.edit({ content: '❌ Serve almeno una canzone salvata o in riproduzione per generare un Mix!' }).catch(() => {}); return; }
        const randomSong = seedSource[Math.floor(Math.random() * seedSource.length)];
        const videoId = getYoutubeId(randomSong.url);
        if (!videoId) throw new Error("ID Video non valido");
        const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
        const songsFound = await getVideoInfo(mixUrl);
        if (songsFound && songsFound.length > 0) {
            const currentMixSong = getCurrentSong(serverQueue);
            if (currentMixSong && areSameSong(songsFound[0].url, currentMixSong.url)) songsFound.shift();
            if (serverQueue.songs.length + (serverQueue.history || []).length + songsFound.length > MAX_QUEUE_SIZE) { if(statusMsg) await statusMsg.edit({ content: `❌ **Limite Coda Raggiunto!**` }).catch(() => {}); return; }
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
}

async function handleReplay(interaction, serverQueue, guildId, deps) {
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
        console.error(`❌ [SKIP] Errore:`, result.error?.message);
        await safeReply(interaction, { content: '❌ Impossibile eseguire skip. Riprova tra un attimo.', flags: MessageFlags.Ephemeral }).catch(() => {});
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
        console.error(`❌ [PREV] Errore:`, result.error?.message);
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
        console.error(`❌ [SELECT-QUEUE] Errore:`, result.error?.message);
    }
}

async function handleLoop(interaction, serverQueue, guildId) {
    serverQueue.loopEnabled = !serverQueue.loopEnabled;
    if (serverQueue.mixer && serverQueue.mixer.isProcessAlive()) {
        try { serverQueue.mixer.setLoop(serverQueue.loopEnabled); } catch(e) {}
    }
    saveQueueState(guildId, serverQueue);
    try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); }
    catch(e) { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{}); }
}

async function handleShuffle(interaction, serverQueue, guildId) {
    if (serverQueue.songs.length >= 2) {
        const currentIdx = serverQueue.playIndex || 0;
        const before = serverQueue.songs.slice(0, currentIdx + 1);
        const after = serverQueue.songs.slice(currentIdx + 1);
        for (let i = after.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [after[i], after[j]] = [after[j], after[i]]; }
        serverQueue.songs = [...before, ...after];
        serverQueue.nextDeckLoaded = null;
        serverQueue.nextDeckTarget = null;
        saveQueueState(guildId, serverQueue);
        try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); }
        catch(e) { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{}); }
        audio.updatePreloadAfterQueueChange(guildId).catch(()=>{});
    } else { try { await interaction.deferUpdate(); } catch(e){} }
}

async function handleFade(interaction, serverQueue, guildId) {
    serverQueue.fadeEnabled = !serverQueue.fadeEnabled;
    saveQueueState(guildId, serverQueue);
    try { await interaction.update({ components: createDashboardComponents(serverQueue, interaction.user.id) }); }
    catch(e) { if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{}); }
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
};

// ─── Main Dispatcher ────────────────────────────────────────

module.exports = function registerInteractionHandlers(client, deps) {
    client.on(Events.InteractionCreate, async interaction => {
        try {
            if (interaction.isChatInputCommand()) {
                let commands = {};
                try { commands = require('../commands'); } catch (e) {}
                const cmd = commands[interaction.commandName];
                if (cmd && typeof cmd.execute === 'function') {
                    try { await cmd.execute(interaction, deps); } catch (e) { console.error('Command execute error', e); }
                }
                return;
            }

            if (interaction.isButton() || interaction.isStringSelectMenu()) {
                const guildId = interaction.guildId;
                const customId = interaction.customId;

                // Percorso rapido per modal
                if (customId === 'btn_add_modal') {
                    const modal = new ModalBuilder().setCustomId('modal_add_song').setTitle('Aggiungi Canzone');
                    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('song_input').setLabel("Link o Nome").setStyle(TextInputStyle.Short)));
                    await interaction.showModal(modal);
                    return;
                }

                // Defer dell'update (salvo bottoni ad aggiornamento immediato o che aprono modal)
                const immediateUpdateButtons = ['btn_loop', 'btn_shuffle', 'btn_fade'];
                const modalButtons = ['plist_create', 'plist_search_server'];
                const isModalButton = modalButtons.includes(customId) || customId.startsWith('plist_rename_likes_') || customId.startsWith('plist_search_likes_');
                if (!immediateUpdateButtons.includes(customId) && !isModalButton) {
                    try { await interaction.deferUpdate(); } catch(e){}
                }

                const now = Date.now();
                if (interactionCooldowns.has(guildId) && now < interactionCooldowns.get(guildId) + 200) return;
                interactionCooldowns.set(guildId, now);

                const serverQueue = await deps.ensureBotConnection(interaction);
                if (!serverQueue) return;
                if (!serverQueue.dashboardMessage && interaction.message) serverQueue.dashboardMessage = interaction.message;

                // Prova prima i playlist handlers
                try {
                    if (await handlePlaylist(interaction, serverQueue, guildId, customId, deps)) return;
                } catch (e) { console.error(`❌ [PLAYLIST-HANDLER] Errore (${customId}):`, e); return; }

                // Poi i button handlers
                const handler = BUTTON_HANDLERS[customId];
                if (handler) {
                    try { await handler(interaction, serverQueue, guildId, deps); }
                    catch (e) { console.error(`❌ [BUTTON-HANDLER] Errore (${customId}):`, e); }
                }
                return;
            }

            if (interaction.isModalSubmit()) {
                try { await handleModal(interaction, interaction.guildId, deps); }
                catch (e) { console.error(`❌ [MODAL-HANDLER] Errore (${interaction.customId}):`, e); }
                return;
            }
        } catch (e) { console.error("Errore Handler:", e); }
    });
};
