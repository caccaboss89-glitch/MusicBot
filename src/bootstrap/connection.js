import { queue } from '../state/globals.js';
import ServerQueue from '../state/ServerQueue.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer } from '@discordjs/voice';
import { scheduleDisconnectIfAlone, cancelScheduledDisconnect } from '../audio/teardown.js';
import { loadQueueBackup } from '../queue/persistence.js';
import { DISCONNECT_TIMEOUT_MS, RECONCILE_WINDOW_MS, VOICE_CONNECTION_TIMEOUT_MS } from '../../config/index.js';
import { safeReply } from '../utils/discord.js';
import { JOIN_VOICE, VOICE_CONNECTION_ERROR } from '../ui/messages.js';

async function ensureBotConnection(interaction) {
  if (!interaction || !interaction.guildId) return null;
  const guildId = interaction.guildId;
  let serverQueue = queue.get(guildId);
  if (!serverQueue) {
    serverQueue = new ServerQueue({
      guildId,
      textChannel: interaction.channel || null,
      voiceChannel: interaction.member?.voice?.channel || null
    });
    // Insert queue into map immediately to avoid race condition
    queue.set(guildId, serverQueue);
    // Attempt to restore from saved backup
    try {
      const backup = loadQueueBackup(guildId);
      if (backup && backup.songs && backup.songs.length > 0) {
        serverQueue.songs = backup.songs.slice();
        serverQueue.playIndex = backup.playIndex || 0;
        serverQueue.isPaused = !!backup.isPaused;
        serverQueue.loopEnabled = !!backup.loopEnabled;
        serverQueue.fadeEnabled = !!backup.fadeEnabled;
        serverQueue.dashboardMessageId = backup.dashboardMessageId || null;
        serverQueue.textChannelId = backup.textChannelId || null;
        // DO NOT restore currentDeckLoaded: on bot restart there is no mixer,
        // so the deck is not actually loaded. Setting it would cause
        // playSong() not to start when the user adds songs.
        serverQueue.currentDeckLoaded = null;
        serverQueue.sessionRestored = true;
      }
    } catch (e) { console.error('Error loading queue backup:', e); }
  } else {
    if (!serverQueue.player || typeof serverQueue.player.play !== 'function') serverQueue.player = createAudioPlayer();
    serverQueue.textChannel = serverQueue.textChannel || interaction.channel || null;
    serverQueue.voiceChannel = serverQueue.voiceChannel || interaction.member?.voice?.channel || null;
  }
  return serverQueue;
}

async function connectToVoice(serverQueue, interaction) {
  try {
    if (!serverQueue) return false;
    // Prefer the calling member's voice channel (try to follow the user), fall back to stored one
    const memberVoice = interaction?.member?.voice?.channel || null;
    const targetVoice = memberVoice || serverQueue.voiceChannel || null;
    if (!targetVoice) {
      await safeReply(interaction, { content: JOIN_VOICE, flags: 64 });
      return false;
    }
    // Update the stored `voiceChannel` to target (we're trying to follow the user)
    serverQueue.voiceChannel = targetVoice;

    // Clear any pending disconnect timer — we're (re)connecting intentionally
    cancelScheduledDisconnect(serverQueue);

    // Flag: prevents voiceStateUpdate/cleanup from destroying the new connection during channel change
    serverQueue._isReconnecting = true;

    // If a connection exists, validate it. If it's ready and matches the target channel, reuse it.
    if (serverQueue.connection) {
      try {
        const status = serverQueue.connection.state?.status;
        const joinedChannelId = serverQueue.connection.joinConfig?.channelId || serverQueue.voiceChannel?.id;
        if (status === VoiceConnectionStatus.Ready && joinedChannelId === targetVoice.id) {
          serverQueue._isReconnecting = false;
          return true;
        }
      } catch {
        // fallthrough: recreate the connection
      }
      // Existing connection obsolete or in wrong channel — remove listeners BEFORE destroying
      // to prevent destroy from triggering cleanup cascade
      const oldConn = serverQueue.connection;
      if (serverQueue._connStateHandler) {
        try { oldConn.off('stateChange', serverQueue._connStateHandler); } catch { /* listener already removed */ }
        serverQueue._connStateHandler = null;
      }
      if (serverQueue._connErrorHandler) {
        try { oldConn.off('error', serverQueue._connErrorHandler); } catch { /* listener already removed */ }
        serverQueue._connErrorHandler = null;
      }
      try { oldConn.destroy(); } catch { /* connection already destroyed */ }
      serverQueue.connection = null;
    }

    const connection = joinVoiceChannel({
      channelId: serverQueue.voiceChannel.id,
      guildId: serverQueue.guildId || interaction.guildId,
      adapterCreator: serverQueue.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false
    });
    serverQueue.connection = connection;
    // Clear pending reconciliation timer
    if (serverQueue._reconcileTimer) {
      clearTimeout(serverQueue._reconcileTimer);
      serverQueue._reconcileTimer = null;
    }
    // Add lifecycle listener to react to disconnections/moves
    try {
      const stateChangeHandler = (oldState, newState) => {
        try {
          if (newState.status === VoiceConnectionStatus.Destroyed) {
            // Force immediate cleanup
            scheduleDisconnectIfAlone(serverQueue, 0);
          } else if (newState.status === VoiceConnectionStatus.Ready) {
            // Connected; cancel any pending auto-disconnect
            cancelScheduledDisconnect(serverQueue);

            // Reconcile potential channel mismatch between connection and stored voiceChannel
            try {
              const connChannelId = connection.joinConfig?.channelId;
              const storedChannelId = serverQueue.voiceChannel?.id;
              if (connChannelId && storedChannelId && connChannelId !== storedChannelId) {
                // Clear previous timer if exists
                if (serverQueue._reconcileTimer) {
                  clearTimeout(serverQueue._reconcileTimer);
                }
                // Wait a short window then reconcile
                serverQueue._reconcileTimer = setTimeout(() => {
                  serverQueue._reconcileTimer = null;
                  try {
                    const latestStoredId = serverQueue.voiceChannel?.id;
                    const latestConnId = connection.joinConfig?.channelId;
                    if (latestStoredId !== latestConnId) {
                      // Try to resolve the channel object from guild channel cache
                      const guild = serverQueue.voiceChannel?.guild;
                      if (guild && guild.channels && guild.channels.cache) {
                        const newChan = guild.channels.cache.get(latestConnId);
                        if (newChan) {
                          serverQueue.voiceChannel = newChan;
                          const humanCount = newChan.members ? newChan.members.filter(m => !m.user.bot).size : 0;
                          if (humanCount === 0) scheduleDisconnectIfAlone(serverQueue, RECONCILE_WINDOW_MS);
                          else cancelScheduledDisconnect(serverQueue);
                        } else {
                          scheduleDisconnectIfAlone(serverQueue, DISCONNECT_TIMEOUT_MS);
                        }
                      }
                    }
                  } catch { /* the guild or channel may have gone away meanwhile */ }
                }, RECONCILE_WINDOW_MS);
              }
            } catch { /* reconciliation is best effort */ }

          } else if (newState.status === VoiceConnectionStatus.Disconnected) {
            // Try a short reconnection window, otherwise schedule cleanup
            scheduleDisconnectIfAlone(serverQueue, DISCONNECT_TIMEOUT_MS);
          }
        } catch { /* a listener error must not break the connection */ }
      };
      const errorHandler = (err) => {
        console.error('VoiceConnection error:', err);
        scheduleDisconnectIfAlone(serverQueue, 0);
      };
      // Save references to remove them at next connection
      serverQueue._connStateHandler = stateChangeHandler;
      serverQueue._connErrorHandler = errorHandler;
      connection.on('stateChange', stateChangeHandler);
      connection.on('error', errorHandler);
    } catch { /* listeners are best effort */ }
    try { serverQueue.connection.subscribe(serverQueue.player); } catch { /* player not ready yet: playSong() subscribes again */ }
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_CONNECTION_TIMEOUT_MS);
    } catch (e) {
      console.error('Voice connection failed:', e);
      // Remove listeners BEFORE destroying to prevent cleanup cascade
      try { connection.off('stateChange', serverQueue._connStateHandler); } catch { /* listener already removed */ }
      try { connection.off('error', serverQueue._connErrorHandler); } catch { /* listener already removed */ }
      serverQueue._connStateHandler = null;
      serverQueue._connErrorHandler = null;
      try { connection.destroy(); } catch { /* connection already destroyed */ }
      serverQueue.connection = null;
      serverQueue._isReconnecting = false;
      await safeReply(interaction, { content: VOICE_CONNECTION_ERROR, flags: 64 });
      return false;
    }
    serverQueue._isReconnecting = false;
    return true;
  } catch (e) {
    console.error('connectToVoice error:', e);
    if (serverQueue) serverQueue._isReconnecting = false;
    return false;
  }
}

export { ensureBotConnection, connectToVoice };

