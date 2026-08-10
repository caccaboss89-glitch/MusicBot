/**
 * Utility functions for Discord interactions
 */

/**
 * Safely replies to a Discord interaction
 * Handles case of already-replied or deferred interaction
 * @param {Interaction} interaction - Discord interaction
 * @param {object} data - Response data
 */
async function safeReply(interaction, data) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(data);
    } else {
      await interaction.reply(data);
    }
  } catch {
    // Ignore errors from expired or already-handled interaction
  }
}

export {
  safeReply
};

