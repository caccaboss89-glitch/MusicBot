/**
 * Cleanup of the bot's own old messages in a text channel.
 * The debounce lives here rather than in the caller, so the rate limit belongs
 * to the operation itself and no command has to remember to apply it.
 */

const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // Discord refuses to bulk delete older messages
const CLEANUP_DEBOUNCE_MS = 60000;

const lastCleanupTime = new Map(); // guildId -> timestamp

/**
 * Deletes the bot's recent messages in a channel, keeping the dashboard.
 * Does nothing if the same guild was already cleaned less than a minute ago.
 * @param {string} guildId - Guild the channel belongs to (debounce key)
 * @param {import('discord.js').TextChannel} channel - Discord channel
 * @param {import('discord.js').Client} client - Discord client (to identify our own messages)
 * @param {string|null} [currentDashId=null] - Dashboard message ID to preserve
 */
async function cleanupOldMessages(guildId, channel, client, currentDashId = null) {
  if (!guildId || !channel || !client) return;

  if (Date.now() - (lastCleanupTime.get(guildId) || 0) < CLEANUP_DEBOUNCE_MS) return;
  lastCleanupTime.set(guildId, Date.now());

  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const now = Date.now();
    const toDelete = messages.filter(msg =>
      msg.author.id === client.user.id &&
      msg.id !== currentDashId &&
      now - msg.createdTimestamp < BULK_DELETE_MAX_AGE_MS
    );

    if (toDelete.size > 0) {
      await channel.bulkDelete(toDelete).catch(() => { });
    }
  } catch {
    // Ignore permission errors or inaccessible channel errors
  }
}

/**
 * Forgets the debounce state of a guild (disconnect, bot removed from server).
 * @param {string} guildId
 */
function resetMessageCleanupState(guildId) {
  lastCleanupTime.delete(guildId);
}

export { cleanupOldMessages, resetMessageCleanupState };
