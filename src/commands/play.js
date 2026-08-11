import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { queue } from '../state/globals.js';
import { getVideoInfo } from '../utils/youtube.js';
import { saveQueueState } from '../queue/persistence.js';
import { createDashboardComponents, updateDashboard, createCurrentSongEmbed, refreshDashboard } from '../ui/index.js';
import { cleanupOldMessages } from '../utils/cleanup.js';
import { MAX_QUEUE_SIZE } from '../../config/index.js';
import { clearFinishedQueue } from '../queue/QueueManager.js';
import * as msg from '../ui/messages.js';

// Name of the search option. Must match the one registered by deploy-commands.js,
// which builds the payload from this very definition.
const SEARCH_OPTION = 'cerca';

const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Avvia il player musicale')
  .addStringOption(option => option
    .setName(SEARCH_OPTION)
    .setDescription('Titolo, link o playlist')
    .setRequired(false));

/**
 * Opens the dashboard when `/play` is used without a search term.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} serverQueue
 * @param {object} deps
 */
async function openDashboard(interaction, serverQueue, deps) {
  const guildId = interaction.guildId;

  // Nothing to play: just show the empty dashboard
  if (serverQueue.songs.length === 0) {
    const ok = await updateDashboard(serverQueue, createCurrentSongEmbed(serverQueue), createDashboardComponents(serverQueue));
    return interaction.editReply(ok ? msg.DASHBOARD_OPENED : msg.DASHBOARD_OPEN_ERROR);
  }

  const connected = await deps.connectToVoice(serverQueue, interaction);
  if (!connected) return interaction.editReply(msg.VOICE_CONNECTION_ERROR);

  // Songs still queued (including the one endQueue keeps for replay): resume
  await deps.playSong(guildId, interaction);
  // playSong() skips the dashboard when a deck was already loaded during the
  // restore, so make sure the player message exists in the text channel.
  if (!serverQueue.dashboardMessage) await refreshDashboard(serverQueue);
  return interaction.editReply(msg.SESSION_RESUMED);
}

/**
 * Searches the query and appends the results to the queue.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} serverQueue
 * @param {string} query
 * @param {object} deps
 */
async function addToQueue(interaction, serverQueue, query, deps) {
  const guildId = interaction.guildId;

  const connected = await deps.connectToVoice(serverQueue, interaction);
  if (!connected) return interaction.editReply(msg.VOICE_CONNECTION_ERROR);

  let songsFound;
  try {
    songsFound = await getVideoInfo(query);
  } catch (e) {
    console.error('❌ [PLAY] Search error:', e.message);
    return interaction.editReply(msg.SEARCH_ERROR);
  }

  if (songsFound.length === 0) return interaction.editReply(msg.NO_RESULTS);
  if (serverQueue.songs.length + songsFound.length > MAX_QUEUE_SIZE) {
    return interaction.editReply(msg.QUEUE_LIMIT_REACHED);
  }

  clearFinishedQueue(serverQueue);
  serverQueue.songs.push(...songsFound.map(s => ({ ...s, requester: interaction.member.id })));
  saveQueueState(guildId, serverQueue);

  if (!serverQueue.currentDeckLoaded) {
    try {
      await deps.playSong(guildId, interaction);
      return interaction.editReply(serverQueue.sessionRestored ? msg.SESSION_RESTORED_UPDATED : msg.PLAYBACK_STARTING);
    } catch (e) {
      console.error('Error in playSong:', e);
      return interaction.editReply(msg.PLAYBACK_START_ERROR);
    }
  }

  // Already playing: the new songs may have changed what comes next
  await deps.updatePreloadAfterQueueChange(guildId);
  if (serverQueue.dashboardMessage) {
    await serverQueue.dashboardMessage.edit({ components: createDashboardComponents(serverQueue) }).catch(() => { });
  }
  if (songsFound.length > 1) return interaction.editReply(msg.songsAdded(songsFound.length));
  return interaction.deleteReply().catch(() => { });
}

async function execute(interaction, deps) {
  const { guild, member, channel } = interaction;
  if (!member.voice.channel) {
    return interaction.reply({ content: msg.JOIN_VOICE, flags: MessageFlags.Ephemeral });
  }

  if (queue.get(guild.id)?.isTaskRunning) {
    return interaction.reply({ content: msg.TASK_IN_PROGRESS, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const serverQueue = await deps.ensureBotConnection(interaction);
  serverQueue.isTaskRunning = true;
  try {
    // Debounced internally: safe to call on every invocation
    cleanupOldMessages(guild.id, channel, deps.client, serverQueue.dashboardMessage?.id).catch(() => { });

    // If the text channel changed, drop the dashboard living in the old one
    const oldTextChannelId = serverQueue.textChannel?.id;
    serverQueue.textChannel = channel;
    if (oldTextChannelId && oldTextChannelId !== channel.id && serverQueue.dashboardMessage) {
      await serverQueue.dashboardMessage.delete().catch(() => { });
      serverQueue.dashboardMessage = null;
      serverQueue.dashboardMessageId = null;
    }

    const query = interaction.options.getString(SEARCH_OPTION);
    return query
      ? await addToQueue(interaction, serverQueue, query, deps)
      : await openDashboard(interaction, serverQueue, deps);
  } finally {
    serverQueue.isTaskRunning = false;
  }
}

export { data, execute };
