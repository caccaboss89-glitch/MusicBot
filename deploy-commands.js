import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

// Register the application slash command
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Start the music player')
    .addStringOption(option =>
      option.setName('search')
        .setDescription('Title, link or playlist')
        .setRequired(false))
]
  .map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('🧹 Resetting Discord commands, keeping only /play...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Command /play registered.');
  } catch (e) {
    console.error(e);
  }
})();