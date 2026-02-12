/**
 * src/ui/embeds.js
 * Funzioni per la creazione di embed Discord
 */

const { EmbedBuilder } = require('discord.js');
const { sanitizeTitle } = require('../utils/sanitize');
const { getCurrentSong } = require('../queue/QueueManager');

/**
 * Crea l'embed della canzone corrente
 * @param {Object} serverQueue - La coda del server
 * @returns {EmbedBuilder} L'embed della canzone corrente
 */
function createCurrentSongEmbed(serverQueue) {
    let song = null;
    
    try {
        if (serverQueue) {
            song = getCurrentSong(serverQueue);
        }
    } catch (e) {
        console.error('[EMBED] Errore durante determinazione canzone corrente:', e);
    }
    
    if (!song || !song.url) {
        return new EmbedBuilder()
            .setColor(0x555555)
            .setTitle('🚫 Nessuna canzone')
            .setDescription('Aggiungi una canzone per iniziare!');
    }
    
    const embed = new EmbedBuilder()
        .setColor(song.isLive ? 0xFF0000 : 0x0099FF)
        .setTitle('🎶 In Riproduzione')
        .setDescription(`**[${sanitizeTitle(song.title)}](${song.url})**`)
        .setThumbnail(song.thumbnail)
        .addFields({ name: 'Richiesta da', value: `<@${song.requester}>`, inline: true });

    // Footer di caricamento (impostato da SkipManager durante il loading)
    if (serverQueue && serverQueue.loadingFooter) {
        embed.setFooter({ text: serverQueue.loadingFooter });
    }
    
    return embed;
}

/**
 * Crea l'embed per coda terminata
 * @param {Object|null} lastSong - L'ultima canzone riprodotta
 * @returns {EmbedBuilder} L'embed di coda terminata
 */
function createFinishedEmbed(lastSong) {
    return new EmbedBuilder()
        .setColor(0x555555)
        .setTitle('🚫 Coda Terminata')
        .setDescription(lastSong ? `Ultima riproduzione:\n**[${sanitizeTitle(lastSong.title)}](${lastSong.url})**` : 'Aggiungi canzoni per ripartire!')
        .setThumbnail(lastSong ? lastSong.thumbnail : null)
        .setFooter({ text: "Premi 🔁 per riascoltare l'ultima canzone" });
}

module.exports = {
    createCurrentSongEmbed,
    createFinishedEmbed
};
