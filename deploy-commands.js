import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import * as commands from './src/commands/index.js';

// Single source of truth: the payload is built from the very definitions the
// bot executes, so an option can never be registered under a different name
// than the one the command handler reads.
const body = Object.values(commands).map(command => command.data.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  console.error('❌ DISCORD_TOKEN and CLIENT_ID must be set in the environment.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  const names = body.map(c => `/${c.name}`).join(', ');
  console.log(`🧹 Resetting Discord commands, keeping only: ${names}...`);
  await rest.put(Routes.applicationCommands(clientId), { body });
  console.log(`✅ Registered: ${names}`);
} catch (e) {
  console.error('❌ Command registration failed:', e);
  process.exit(1);
}
