/**
 * src/ui/embeds.js
 * Funzioni per la creazione di embed Discord
 */

const { EmbedBuilder } = require('discord.js');
const { displayTitle } = require('../utils/sanitize');
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
        // "🎶 In Riproduzione" come header (author): il TITOLO dell'embed diventa la canzone.
        // Discord NON interpreta il markdown nei titoli degli embed, quindi il titolo viene
        // mostrato RAW (anche con ** o altri simboli) senza rompersi e senza backslash visibili,
        // ed è cliccabile grazie a setURL().
        .setAuthor({ name: '🎶 In Riproduzione' })
        .setTitle(displayTitle(song.title))
        .setURL(song.url)
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
    const embed = new EmbedBuilder()
        .setColor(0x555555)
        .setAuthor({ name: '🚫 Coda Terminata' })
        .setThumbnail(lastSong ? lastSong.thumbnail : null)
        .setFooter({ text: "Premi 🔁 per riascoltare l'ultima canzone" });

    if (lastSong) {
        // Titolo RAW e cliccabile (vedi nota in createCurrentSongEmbed): niente masked link.
        embed.setTitle(displayTitle(lastSong.title)).setURL(lastSong.url).setDescription('Ultima riproduzione:');
    } else {
        embed.setTitle('Nessuna canzone').setDescription('Aggiungi canzoni per ripartire!');
    }

    return embed;
}

module.exports = {
    createCurrentSongEmbed,
    createFinishedEmbed
};
