const { SlashCommandBuilder } = require('discord.js');
const { queue } = require('../state/globals');
const { getVideoInfo } = require('../utils/youtube');
const { saveQueueState } = require('../queue/persistence');
const { createDashboardComponents, updateDashboard, createCurrentSongEmbed, updateDashboardToFinished } = require('../ui');
const { safeReply, cleanupOldMessages } = require('../utils/discord');
const { MAX_QUEUE_SIZE } = require('../../config');
const { clearFinishedQueue } = require('../queue/QueueManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Avvia il player musicale')
        .addStringOption(option => option.setName('cerca').setDescription('Titolo, Link o Playlist').setRequired(true)),

    async execute(interaction, deps) {
        const { guild, member, channel } = interaction;
        if (!member.voice.channel) return interaction.reply({ content: '❌ Entra in vocale!', flags: 64 /* Ephemeral */ });

        let serverQueue = queue.get(guild.id);
        if (serverQueue && serverQueue.isTaskRunning) return interaction.reply({ content: '⚠️ **Sto elaborando...**', flags: 64 });

        await interaction.deferReply({ flags: 64 });
        try { cleanupOldMessages(channel, serverQueue?.dashboardMessage?.id, deps.client || null); } catch(e){}

        serverQueue = await deps.ensureBotConnection(interaction);
        serverQueue.isTaskRunning = true;
        serverQueue.textChannel = channel;

        try {
            const connected = await deps.connectToVoice(serverQueue, interaction);
                if (!connected) {
                serverQueue.isTaskRunning = false;
                try { await interaction.editReply({ content: '❌ Errore connessione vocale.' }); } catch(e) { /* ignora */ }
                return;
            }

            const query = interaction.options.getString('cerca');
            if (!query) {
                // Se esiste una coda attiva in memoria, riprendi la riproduzione
                if (serverQueue.songs.length > 0) {
                    await deps.playSong(guild.id, interaction);
                    // Assicurati che la dashboard sia presente: `playSong` potrebbe non ricreare la dashboard quando
                    // `currentDeckLoaded` era già impostato durante il ripristino. In tal caso, aggiorna/manda esplicitamente
                    // la dashboard così il messaggio del player appare nel canale di testo.
                    try {
                        if (!serverQueue.dashboardMessage) {
                            try { await require('../ui').refreshDashboard(serverQueue); } catch (e) {}
                        }
                    } catch (e) {}
                    serverQueue.isTaskRunning = false;
                    return interaction.editReply("✅ **Sessione ripresa!**");
                }

                // Se la coda è terminata ma esiste history, mostra la dashboard di coda terminata (ultima riprodotta)
                const lastSong = serverQueue.history && serverQueue.history.length > 0 ? serverQueue.history[serverQueue.history.length - 1] : null;
                const isTerminated = !serverQueue.currentDeckLoaded && (!serverQueue.songs || serverQueue.songs.length === 0) && lastSong;
                try {
                    if (isTerminated) {
                        await updateDashboardToFinished(serverQueue, lastSong);
                        serverQueue.isTaskRunning = false;
                        return interaction.editReply("✅ Dashboard (Coda terminata) aperta.");
                    }
                    // Nessuna canzone: apri/aggiorna la dashboard normale
                    const embed = createCurrentSongEmbed(serverQueue);
                    const components = createDashboardComponents(serverQueue, interaction.user.id);
                    const ok = await updateDashboard(serverQueue, embed, components);
                    serverQueue.isTaskRunning = false;
                    if (ok) return interaction.editReply("✅ Dashboard aperta.");
                    return interaction.editReply("❌ Impossibile aprire la dashboard.");
                } catch (e) {
                    serverQueue.isTaskRunning = false;
                    return interaction.editReply("❌ Impossibile aprire la dashboard.");
                }
                
            }

            let songsFound = [];
            try { songsFound = await getVideoInfo(query); } catch (error) { serverQueue.isTaskRunning = false; return interaction.editReply("❌ Errore ricerca."); }

            if (songsFound.length === 0) { serverQueue.isTaskRunning = false; return interaction.editReply('❌ Nessun risultato.'); }
            if (serverQueue.songs.length + serverQueue.history.length + songsFound.length > MAX_QUEUE_SIZE) { serverQueue.isTaskRunning = false; return interaction.editReply('❌ **Limite Coda!**'); }

            // Aggiungi alla coda e persisti su disco
            clearFinishedQueue(serverQueue);
            serverQueue.songs.push(...songsFound.map(s => ({ ...s, requester: member.id })));
            saveQueueState(guild.id, serverQueue);

            if (!serverQueue.currentDeckLoaded) {
                try {
                    await deps.playSong(guild.id, interaction);
                    await interaction.editReply(serverQueue.sessionRestored ? `✅ **Sessione Ripristinata e Aggiornata!**` : `✅ Avvio riproduzione...`);
                } catch (e) {
                    console.error('Errore playSong:', e);
                    try { await interaction.editReply('❌ Errore avvio riproduzione.'); } catch(e){}
                }
            } else {
                if (serverQueue.nextDeckLoaded === null && serverQueue.songs.length >= 2) { await deps.updatePreloadAfterQueueChange(guild.id); }
                if (songsFound.length > 1) interaction.editReply(`✅ Aggiunte **${songsFound.length}** canzoni.`); else interaction.deleteReply().catch(() => {});
                if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(()=>{});
                if (serverQueue.songs.length === 2) deps.preloadNextSongs(guild.id);
            }
        } finally { if (serverQueue) serverQueue.isTaskRunning = false; }
    }
};
