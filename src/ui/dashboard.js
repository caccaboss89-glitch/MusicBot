/**
 * src/ui/dashboard.js
 * Functions for dashboard management
 */

import { createCurrentSongEmbed, createFinishedEmbed } from './embeds.js';
import { createDashboardComponents } from './components.js';

const MIN_UPDATE_INTERVAL_MS = 1000; // Throttle window to stay clear of Discord rate limits

/**
 * Attempts to retrieve the dashboard message from the channel using the saved ID
 * @param {Object} serverQueue
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function tryRestoreDashboardMessage(serverQueue) {
  if (!serverQueue || !serverQueue.textChannel || !serverQueue.dashboardMessageId) return null;

  try {
    const message = await serverQueue.textChannel.messages.fetch(serverQueue.dashboardMessageId);
    if (message) {
      console.log(`✅ [DASHBOARD] Dashboard message recovered from backup (id=${serverQueue.dashboardMessageId})`);
      serverQueue.dashboardMessage = message;
      return message;
    }
  } catch (e) {
    // Message not found (deleted or expired)
    console.warn(`⚠️ [DASHBOARD] Saved message not found (id=${serverQueue.dashboardMessageId}):`, e.message);
    serverQueue.dashboardMessageId = null;
    serverQueue.dashboardMessage = null;
  }
  return null;
}

/**
 * Sends a new dashboard message and stores its ID.
 * @param {Object} serverQueue
 * @param {Object} payload - { embeds, components }
 */
async function sendDashboard(serverQueue, payload) {
  serverQueue.dashboardMessage = await serverQueue.textChannel.send(payload);
  serverQueue.dashboardMessageId = serverQueue.dashboardMessage.id;
}

/**
 * Updates the dashboard with throttling to avoid rate limiting.
 * @param {Object} serverQueue - The server queue
 * @param {import('discord.js').EmbedBuilder} embed - The embed to display
 * @param {import('discord.js').ActionRowBuilder[]} components - The components to display
 * @returns {Promise<boolean>} false if the message could not be delivered
 */
async function updateDashboard(serverQueue, embed, components) {
  if (!serverQueue || !serverQueue.textChannel) return false;

  if (!serverQueue.dashboardState) {
    serverQueue.dashboardState = { isUpdating: false, lastUpdate: 0, nextData: null, timer: null };
  }
  const state = serverQueue.dashboardState;
  state.nextData = { embeds: [embed], components };

  // An update is already in flight (or scheduled): it will pick up `nextData`
  if (state.isUpdating || state.timer) return true;

  return performUpdate(serverQueue, state);
}

/**
 * Publishes the latest queued dashboard data, then reschedules itself if newer
 * data arrived while it was running.
 * @param {Object} serverQueue
 * @param {Object} state - serverQueue.dashboardState
 * @returns {Promise<boolean>} false if the message could not be delivered
 */
async function performUpdate(serverQueue, state) {
  if (!state.nextData) return true;

  const payload = state.nextData;
  state.nextData = null;
  state.isUpdating = true;

  let delivered = true;
  try {
    const channel = serverQueue.textChannel;
    if (!channel || !channel.send) {
      console.warn('⚠️ [DASHBOARD] Invalid textChannel on serverQueue');
      return false;
    }

    // If the message is not in memory, try to recover it from backup (saved ID)
    if (!serverQueue.dashboardMessage && serverQueue.dashboardMessageId) {
      await tryRestoreDashboardMessage(serverQueue);
    }

    if (!serverQueue.dashboardMessage) {
      await sendDashboard(serverQueue, payload);
    } else {
      try {
        // The dashboard must stay the last message in the channel, otherwise it
        // scrolls out of view: if it is not, delete it and post a new one.
        const lastMsg = (await channel.messages.fetch({ limit: 1 })).first();
        if (lastMsg && lastMsg.id !== serverQueue.dashboardMessage.id) {
          await serverQueue.dashboardMessage.delete().catch(() => { });
          serverQueue.dashboardMessage = null;
          serverQueue.dashboardMessageId = null;
          await sendDashboard(serverQueue, payload);
        } else {
          await serverQueue.dashboardMessage.edit(payload);
        }
      } catch {
        // Editing failed (message deleted, missing permissions, rate limit):
        // fall back to sending a fresh dashboard.
        await sendDashboard(serverQueue, payload);
      }
    }
    state.lastUpdate = Date.now();
  } catch (e) {
    console.error('⚠️ [DASHBOARD] Rate Limit/Error:', e.message);
    delivered = false;
  } finally {
    state.isUpdating = false;
  }

  // Newer data arrived while we were publishing: schedule the next pass
  if (state.nextData && !state.timer) {
    const delay = Math.max(0, MIN_UPDATE_INTERVAL_MS - (Date.now() - state.lastUpdate));
    state.timer = setTimeout(() => {
      state.timer = null;
      performUpdate(serverQueue, state).catch(e => {
        console.error('⚠️ [DASHBOARD] Deferred update error:', e.message);
      });
    }, delay);
  }

  return delivered;
}

/**
 * Updates the dashboard to the "queue finished" state.
 * The component layout already reflects it: `createDashboardComponents` builds
 * the terminated variant whenever no deck is loaded, which is exactly the state
 * every caller of this function is in.
 * @param {Object} serverQueue - The server queue
 * @param {Object|null} lastSong - The last song played
 * @returns {Promise<boolean>}
 */
async function updateDashboardToFinished(serverQueue, lastSong) {
  if (!serverQueue) return false;
  return updateDashboard(serverQueue, createFinishedEmbed(lastSong), createDashboardComponents(serverQueue));
}

/**
 * Quickly updates the dashboard using the current song embed
 * @param {Object} serverQueue
 * @returns {Promise<boolean>}
 */
async function refreshDashboard(serverQueue) {
  try {
    return await updateDashboard(serverQueue, createCurrentSongEmbed(serverQueue), createDashboardComponents(serverQueue));
  } catch (e) {
    console.error('⚠️ [DASHBOARD] refreshDashboard error:', e);
    return false;
  }
}

export {
  updateDashboard,
  updateDashboardToFinished,
  refreshDashboard
};
