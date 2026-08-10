/**
 * src/ui/dashboard.js
 * Functions for dashboard management
 */

import { createCurrentSongEmbed, createFinishedEmbed } from './embeds.js';
import { createDashboardComponents } from './components.js';

/**
 * Attempts to retrieve the dashboard message from the channel using the saved ID
 * @param {Object} serverQueue
 * @returns {Promise<Message|null>}
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
 * Updates the dashboard with throttling to avoid rate limiting
 * @param {Object} serverQueue - The server queue
 * @param {EmbedBuilder} embed - The embed to display
 * @param {ActionRowBuilder[]} components - The components to display
 */
async function updateDashboard(serverQueue, embed, components) {
  if (!serverQueue || !serverQueue.textChannel) return false;

  if (!serverQueue.dashboardState) {
    serverQueue.dashboardState = { isUpdating: false, lastUpdate: 0, nextData: null, timer: null };
  }
  const state = serverQueue.dashboardState;
  state.nextData = { embed, components };

  if (state.isUpdating || state.timer) return true;

  const performUpdate = async () => {
    if (!state.nextData) { state.isUpdating = false; return; }
    const dataToUse = state.nextData;
    state.nextData = null;
    state.isUpdating = true;

    try {
      const channel = serverQueue.textChannel;
      if (!channel || !channel.send) {
        console.warn('⚠️ [DASHBOARD] Invalid textChannel on serverQueue');
        state.isUpdating = false;
        return false;
      }

      // If the message is not in memory, try to recover it from backup (saved ID)
      if (!serverQueue.dashboardMessage && serverQueue.dashboardMessageId) {
        await tryRestoreDashboardMessage(serverQueue);
      }

      if (serverQueue.dashboardMessage) {
        // Verifies that the stored `dashboardMessage` is still the last message in the channel.
        try {
          const last = await channel.messages.fetch({ limit: 1 });
          const lastMsg = last.first();
          if (lastMsg && lastMsg.id !== serverQueue.dashboardMessage.id) {
            // There is an old dashboard but it is not the last: remove it and force resending
            try { await serverQueue.dashboardMessage.delete().catch(() => { }); } catch { }
            serverQueue.dashboardMessage = null;
            serverQueue.dashboardMessageId = null;
            serverQueue.dashboardMessage = await channel.send({ embeds: [dataToUse.embed], components: dataToUse.components });
            serverQueue.dashboardMessageId = serverQueue.dashboardMessage.id;
          } else {
            await serverQueue.dashboardMessage.edit({ embeds: [dataToUse.embed], components: dataToUse.components });
          }
        } catch (e) {
          // If something fails, attempt to resend the dashboard
          try {
            serverQueue.dashboardMessage = await channel.send({ embeds: [dataToUse.embed], components: dataToUse.components });
            serverQueue.dashboardMessageId = serverQueue.dashboardMessage.id;
          } catch { throw e; }
        }
      } else {
        serverQueue.dashboardMessage = await channel.send({ embeds: [dataToUse.embed], components: dataToUse.components });
        serverQueue.dashboardMessageId = serverQueue.dashboardMessage.id;
      }
      state.lastUpdate = Date.now();
    } catch (e) {
      console.error('⚠️ [DASHBOARD] Rate Limit/Error:', e.message);
      state.isUpdating = false;
      return false;
    } finally {
      state.isUpdating = false;
      if (state.nextData) {
        const timeSinceLast = Date.now() - state.lastUpdate;
        const delay = Math.max(0, 1000 - timeSinceLast);
        state.timer = setTimeout(() => {
          state.timer = null;
          performUpdate();
        }, delay);
      }
      return true;
    }
  };
  return performUpdate();
}

/**
 * Updates the dashboard to the "queue finished" state
 * @param {Object} serverQueue - The server queue
 * @param {Object|null} lastSong - The last song played
 */
async function updateDashboardToFinished(serverQueue, lastSong) {
  if (!serverQueue) return;
  try {
    if (!serverQueue.dashboardMessage) {
      // Try to recover the message from backup before creating a new one
      if (!serverQueue.dashboardMessage && serverQueue.dashboardMessageId) {
        await tryRestoreDashboardMessage(serverQueue);
      }

      // If there is still no message, create a new one
      if (!serverQueue.dashboardMessage) {
        console.log(`🔔 [DASH] updateDashboardToFinished creating message guild=${serverQueue.guildId || 'unknown'}`);
        const channel = serverQueue.textChannel;
        if (channel && channel.send) {
          try {
            serverQueue.dashboardMessage = await channel.send({ embeds: [createFinishedEmbed(lastSong)], components: createDashboardComponents(serverQueue) });
            serverQueue.dashboardMessageId = serverQueue.dashboardMessage.id;
          } catch (e) { console.error('⚠️ [DASH] failed to send finished dashboard:', e && e.message); }
        }
      }
    }
  } catch (e) { console.error('⚠️ [DASH] updateDashboardToFinished preflight error', e); }
  const embed = createFinishedEmbed(lastSong);
  const components = createDashboardComponents(serverQueue);
  if (lastSong) {
    // Determines the 'finished' state: no deck loaded = queue finished
    const isTerminated = serverQueue && !serverQueue.currentDeckLoaded;
    try {
      if (components[0] && components[0].components) {
        // replay idx 0, prev idx 1, pause idx 2, skip idx 3 (indices of controls)
        if (components[0].components[0]) components[0].components[0].setDisabled(false);
        if (components[0].components[1]) components[0].components[1].setDisabled(true);
        if (components[0].components[2]) components[0].components[2].setDisabled(true);
        if (components[0].components[3]) components[0].components[3].setDisabled(true);
      }
      // secondary controls: disable loop/shuffle/fade
      if (components[1] && components[1].components) components[1].components.forEach(c => c.setDisabled(true));
      // playlist row: keep 'open playlist' buttons enabled when finished
      if (components[2] && components[2].components) {
        if (components[2].components[0]) components[2].components[0].setDisabled(false); // open_plist_server
        if (components[2].components[2]) components[2].components[2].setDisabled(false); // open_plist_likes
        // toggles remain as created (probably disabled)
      }
      // select row: keep it disabled
      if (components[3] && components[3].components) components[3].components.forEach(c => c.setDisabled(true));
      // action row: enable 'add' and 'mix' if finished, keep 'clear' disabled
      if (components[4] && components[4].components) {
        if (components[4].components[0]) components[4].components[0].setDisabled(false); // add
        if (components[4].components[1]) components[4].components[1].setDisabled(!isTerminated); // mix only when finished
        if (components[4].components[2]) components[4].components[2].setDisabled(true); // clear
      }
    } catch { /* ignore */ }
  }
  await updateDashboard(serverQueue, embed, components);
}

/**
 * Quickly updates the dashboard using the current song embed
 * @param {Object} serverQueue
 * @param {string|null} userId
 */
async function refreshDashboard(serverQueue, userId = null) {
  try {
    const embed = createCurrentSongEmbed(serverQueue);
    const components = createDashboardComponents(serverQueue, userId);
    return await updateDashboard(serverQueue, embed, components);
  } catch (e) {
    console.error('⚠️ [DASHBOARD] refreshDashboard error:', e);
    return false;
  }
}

export {
  updateDashboard,
  updateDashboardToFinished,
  // Re-export for convenience
  createCurrentSongEmbed,
  createFinishedEmbed,
  createDashboardComponents,
  refreshDashboard
};
