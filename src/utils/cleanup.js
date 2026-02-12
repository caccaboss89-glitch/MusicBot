/**
 * Funzioni di pulizia (file temporanei, messaggi)
 */

const fs = require('fs');
const path = require('path');
const { LOCAL_TEMP_DIR } = require('../../config');

/**
 * Pulisce i vecchi messaggi del bot in un canale
 * @param {TextChannel} channel - Canale Discord
 * @param {string|null} currentDashId - ID del messaggio dashboard attuale da preservare
 * @param {Client} client - Client Discord (per verificare l'autore)
 */
async function cleanupOldMessages(channel, currentDashId = null, client) {
    if (!channel || !client) return;
    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const botMessages = messages.filter(msg => msg.author.id === client.user.id);
        const toDelete = botMessages.filter(msg => msg.id !== currentDashId);
        
        if (toDelete.size > 0) {
            const now = Date.now();
            // Solo messaggi più giovani di 14 giorni (limite Discord per bulkDelete)
            const young = toDelete.filter(m => now - m.createdTimestamp < 1209600000);
            if (young.size > 0) {
                await channel.bulkDelete(young).catch(() => {});
            }
        }
    } catch (e) {
        // Ignora errori di permessi o canale non accessibile
    }
}

module.exports = {
    cleanupOldMessages
};
