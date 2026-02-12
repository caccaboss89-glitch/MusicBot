/**
 * Funzioni di utilità per interazioni Discord
 */

const { cleanupOldMessages } = require('./cleanup');

/**
 * Risponde in modo sicuro a un'interazione Discord
 * Gestisce il caso di interazione già risposta o deferita
 * @param {Interaction} interaction - Interazione Discord
 * @param {object} data - Dati della risposta
 */
async function safeReply(interaction, data) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(data);
        } else {
            await interaction.reply(data);
        }
    } catch (e) {
        // Ignora errori di interazione scaduta o già gestita
    }
}

module.exports = {
    safeReply
};
