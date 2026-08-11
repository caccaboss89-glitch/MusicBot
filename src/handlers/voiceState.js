import { queue } from '../state/globals.js';
import { scheduleDisconnectIfAlone, cancelScheduledDisconnect } from '../audio/teardown.js';
import { DISCONNECT_TIMEOUT_MS, RECONCILE_WINDOW_MS } from '../../config/index.js';
import * as stats from '../database/stats.js';

export default (client) => {
  client.on('voiceStateUpdate', (oldState, newState) => {
    try {
      const guildId = oldState?.guild?.id || newState?.guild?.id;
      if (!guildId) return;
      const serverQueue = queue.get(guildId);
      if (!serverQueue) return;

      // If bot state has changed (moved/disconnected)
      const botId = client.user?.id;
      const oldIsBot = oldState?.member?.id === botId;
      const newIsBot = newState?.member?.id === botId;

      if (oldIsBot || newIsBot) {
        const botChannel = newState?.channel || newState?.member?.voice?.channel || null;
        if (!botChannel) {
          // If reconnection is in progress (channel change), don't interfere
          if (serverQueue._isReconnecting) return;
          // Bot was disconnected/kicked - stop all listeners
          try { stats.stopAllListeners(guildId); } catch { /* stats are best effort */ }
          // Update queue state to reflect lack of channel
          serverQueue.voiceChannel = null;
          // Force immediate cleanup
          scheduleDisconnectIfAlone(serverQueue, 0);
          return;
        } else {
          // Bot moved to another channel - update stored `voiceChannel`
          serverQueue.voiceChannel = botChannel;
          // Count humans (exclude bots)
          const humanCount = botChannel.members ? botChannel.members.filter(m => !m.user.bot).size : 0;
          if (humanCount === 0) {
            // Short reconciliation window: if nobody joins within this interval, disconnect
            scheduleDisconnectIfAlone(serverQueue, RECONCILE_WINDOW_MS);
          } else {
            cancelScheduledDisconnect(serverQueue);
          }
        }
      } else {
        // Non-bot state changed (user joined/left) - reexamine bot's channel
        const vc = serverQueue.voiceChannel;
        if (!vc) return;

        // ── STATS: track user entry/exit from bot channel while playing ──
        try {
          const memberId = oldState?.member?.id || newState?.member?.id;
          const isBot = oldState?.member?.user?.bot || newState?.member?.user?.bot;
          if (memberId && !isBot && serverQueue.currentDeckLoaded && !serverQueue.isPaused) {
            const oldChannelId = oldState?.channelId || null;
            const newChannelId = newState?.channelId || null;
            const botChannelId = vc.id;

            if (oldChannelId === botChannelId && newChannelId !== botChannelId) {
              // User left bot's channel
              stats.stopListening(guildId, memberId);
            } else if (oldChannelId !== botChannelId && newChannelId === botChannelId) {
              // User joined bot's channel
              stats.startListening(guildId, memberId);
            }
          }
        } catch { /* partial voice state: nothing to track */ }

        const humanCount = vc.members ? vc.members.filter(m => !m.user.bot).size : 0;
        if (humanCount === 0) scheduleDisconnectIfAlone(serverQueue, DISCONNECT_TIMEOUT_MS);
        else cancelScheduledDisconnect(serverQueue);
      }

    } catch (e) {
      console.error('Error in voiceStateUpdate:', e);
    }
  });
};
