/**
 * Cleanup functions (temporary files, messages)
 */

/**
 * Cleans up old bot messages in a channel
 * @param {TextChannel} channel - Discord channel
 * @param {string|null} currentDashId - Current dashboard message ID to preserve
 * @param {Client} client - Discord client (to verify author)
 */
async function cleanupOldMessages(channel, currentDashId = null, client) {
  if (!channel || !client) return;
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const botMessages = messages.filter(msg => msg.author.id === client.user.id);
    const toDelete = botMessages.filter(msg => msg.id !== currentDashId);

    if (toDelete.size > 0) {
      const now = Date.now();
      // Only messages younger than 14 days (Discord bulkDelete limit)
      const young = toDelete.filter(m => now - m.createdTimestamp < 1209600000);
      if (young.size > 0) {
        await channel.bulkDelete(young).catch(() => { });
      }
    }
  } catch (e) {
    // Ignore permission errors or inaccessible channel errors
  }
}

export {
  cleanupOldMessages
};
