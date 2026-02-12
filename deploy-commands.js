require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

// Unico comando rimasto: /play
const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Avvia il player musicale')
        .addStringOption(option => 
            option.setName('cerca')
                .setDescription('Titolo, Link o Playlist')
                .setRequired(true))
]
    .map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('🧹 Pulizia comandi vecchi e registrazione di /play...');
        // Questo sovrascrive tutto, lasciando solo play
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log('✅ Fatto! Ora esiste solo il comando /play.');
    } catch (error) {
        console.error(error);
    }
})();