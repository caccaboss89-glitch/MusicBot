import { SlashCommandBuilder } from 'discord.js';
import { queue } from '../state/globals.js';
import { getVideoInfo } from '../utils/youtube.js';
import { saveQueueState } from '../queue/persistence.js';
import { createDashboardComponents, updateDashboard, createCurrentSongEmbed, updateDashboardToFinished } from '../ui/index.js';
import { cleanupOldMessages } from '../utils/cleanup.js';
import { MAX_QUEUE_SIZE } from '../../config/index.js';
import { clearFinishedQueue } from '../queue/QueueManager.js';

const _lastCleanupTime = new Map(); // guildId -> timestamp (debounce cleanup)

const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Avvia il player musicale')
  .addStringOption(option => option.setName('cerca').setDescription('Titolo, Link o Playlist').setRequired(false));

async function execute(interaction, deps) {
    const { guild, member, channel } = interaction;
    if (!member.voice.channel) return interaction.reply({ content: '❌ Entra in vocale!', flags: 64 /* Ephemeral */ });

    let serverQueue = queue.get(guild.id);
    if (serverQueue && serverQueue.isTaskRunning) return interaction.reply({ content: '⚠️ **Sto elaborando...**', flags: 64 });

    await interaction.deferReply({ flags: 64 });
    // Clean up old messages with debounce to avoid too many deletes
    if (!_lastCleanupTime.has(guild.id) || Date.now() - _lastCleanupTime.get(guild.id) > 60000) {
      _lastCleanupTime.set(guild.id, Date.now());
      cleanupOldMessages(channel, serverQueue?.dashboardMessage?.id, deps.client || null).catch(() => { });
    }

    serverQueue = await deps.ensureBotConnection(interaction);
    serverQueue.isTaskRunning = true;

    // If text channel has changed, invalidate old dashboard
    const oldTextChannelId = serverQueue.textChannel?.id;
    serverQueue.textChannel = channel;
    if (oldTextChannelId && oldTextChannelId !== channel.id && serverQueue.dashboardMessage) {
      try { await serverQueue.dashboardMessage.delete(); } catch { }
      serverQueue.dashboardMessage = null;
      serverQueue.dashboardMessageId = null;
    }

    try {
      const query = interaction.options.getString('cerca');

      if (!query) {
        // If nothing to play and no history, show dashboard without entering voice
        const hasSongs = serverQueue.songs.length > 0;
        const hasHistory = serverQueue.history && serverQueue.history.length > 0;
        if (!hasSongs && !hasHistory) {
          try {
            const embed = createCurrentSongEmbed(serverQueue);
            const components = createDashboardComponents(serverQueue, interaction.user.id);
            const ok = await updateDashboard(serverQueue, embed, components);
            serverQueue.isTaskRunning = false;
            if (ok) return interaction.editReply('✅ Dashboard aperta.');
            return interaction.editReply('❌ Impossibile aprire la dashboard.');
          } catch (e) {
            serverQueue.isTaskRunning = false;
            return interaction.editReply('❌ Impossibile aprire la dashboard.');
          }
        }

        // Something to play/show: connect to voice
        const connected = await deps.connectToVoice(serverQueue, interaction);
        if (!connected) {
          serverQueue.isTaskRunning = false;
          try { await interaction.editReply({ content: '❌ Errore connessione vocale.' }); } catch { /* ignora */ }
          return;
        }

        // If there's an active queue in memory, resume playback
        if (serverQueue.songs.length > 0) {
          await deps.playSong(guild.id, interaction);
          // Ensure dashboard is present: `playSong` may not recreate the dashboard when
          // `currentDeckLoaded` was already set during restore. In that case, explicitly update/send
          // the dashboard so the player message appears in the text channel.
          try {
            if (!serverQueue.dashboardMessage) {
              try { const uiModule = await import('../ui/index.js'); await uiModule.default.refreshDashboard(serverQueue); } catch { }
            }
          } catch { }
          serverQueue.isTaskRunning = false;
          return interaction.editReply('✅ **Session resumed!**');
        }

        // If queue is terminated but history exists, show finished queue dashboard (last played)
        const lastSong = serverQueue.history && serverQueue.history.length > 0 ? serverQueue.history[serverQueue.history.length - 1] : null;
        const isTerminated = !serverQueue.currentDeckLoaded && (!serverQueue.songs || serverQueue.songs.length === 0) && lastSong;
        try {
          if (isTerminated) {
            await updateDashboardToFinished(serverQueue, lastSong);
            serverQueue.isTaskRunning = false;
            return interaction.editReply('✅ Dashboard (Queue finished) opened.');
          }
        } catch (e) {
          serverQueue.isTaskRunning = false;
          return interaction.editReply('❌ Impossibile aprire la dashboard.');
        }

      }

      // Voice connection to play with query
      const connected = await deps.connectToVoice(serverQueue, interaction);
      if (!connected) {
        serverQueue.isTaskRunning = false;
        try { await interaction.editReply({ content: '❌ Errore connessione vocale.' }); } catch { /* ignora */ }
        return;
      }

      let songsFound = [];
      try { songsFound = await getVideoInfo(query); } catch { serverQueue.isTaskRunning = false; return interaction.editReply('❌ Errore ricerca.'); }

      if (songsFound.length === 0) { serverQueue.isTaskRunning = false; return interaction.editReply('❌ Nessun risultato.'); }
      if (serverQueue.songs.length + serverQueue.history.length + songsFound.length > MAX_QUEUE_SIZE) { serverQueue.isTaskRunning = false; return interaction.editReply('❌ **Limite Coda!**'); }

      // Add to queue and persist to disk
      clearFinishedQueue(serverQueue);
      serverQueue.songs.push(...songsFound.map(s => ({ ...s, requester: member.id })));
      saveQueueState(guild.id, serverQueue);

      if (!serverQueue.currentDeckLoaded) {
        try {
          await deps.playSong(guild.id, interaction);
          await interaction.editReply(serverQueue.sessionRestored ? '✅ **Session Restored and Updated!**' : '✅ Starting playback...');
        } catch (e) {
          console.error('Error in playSong:', e);
          try { await interaction.editReply('❌ Error starting playback.'); } catch { }
        }
      } else {
        if (serverQueue.nextDeckLoaded === null && serverQueue.songs.length >= 2) { await deps.updatePreloadAfterQueueChange(guild.id); }
        if (songsFound.length > 1) interaction.editReply(`✅ Added **${songsFound.length}** songs.`); else interaction.deleteReply().catch(() => { });
        if (serverQueue.dashboardMessage) serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue, interaction.user.id) }).catch(() => { });
        if (serverQueue.songs.length === 2) deps.preloadNextSongs(guild.id);
      }
    } finally { if (serverQueue) serverQueue.isTaskRunning = false; }
}

function cleanupLastCleanupTime(guildId) {
  _lastCleanupTime.delete(guildId);
}

export { data, execute, cleanupLastCleanupTime };
