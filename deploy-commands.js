require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

// Registra il comando slash dell'applicazione
const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Avvia il player musicale')
        .addStringOption(option =>
            option.setName('cerca')
                .setDescription('Titolo, link o playlist')
                .setRequired(false))
]
    .map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('🧹 Reimposto i comandi di Discord, mantenendo solo /play...');
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log('✅ Comando /play registrato.');
    } catch (error) {
        console.error(error);
    }
})();