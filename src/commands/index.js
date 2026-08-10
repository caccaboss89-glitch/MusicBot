import { data, execute } from './play.js';

// Keyed by slash command name: the interaction dispatcher looks commands up here,
// and deploy-commands.js registers every `data` it finds.
export const play = { data, execute };
