/**
 * src/state/globals.js
 * Stato globale centralizzato per il bot
 * Tutte le Map e variabili condivise tra moduli
 */

// --- CODA PER GUILD ---
// Map<guildId, serverQueue>
const queue = new Map();

// --- TIMER DISCONNESSIONE ---
// Map<guildId, timeoutId> - Timer per disconnettere il bot quando resta solo
const disconnectTimers = new Map();

// --- COOLDOWN INTERAZIONI ---
// Map<guildId, Map<interactionId, timestamp>> - Previene spam di bottoni
const interactionCooldowns = new Map();

// NOTA: I pending skip sono gestiti internamente da SkipManager v3 (skipLock).

// --- CRASH RECOVERY ---
// Map<guildId, { count, firstCrash }> - Contatore crash consecutivi per evitare loop
const crashRecoveryCounters = new Map();

// --- RESTART COOLDOWNS ---
// Map<guildId, timestamp> - Previene restart troppo frequenti
const restartCooldowns = new Map();

// --- RESTART COUNTERS ---
// Map<guildId, { count, firstTime }> - Conta restart consecutivi
const restartCounters = new Map();

// --- GENERAZIONE MIXER ---
// Contatore globale per invalidare eventi da mixer vecchi
let globalMixerGeneration = 0;

/**
 * Incrementa e restituisce la nuova generazione mixer
 * @returns {number} Nuova generazione
 */
function getNextMixerGeneration() {
    return ++globalMixerGeneration;
}

module.exports = {
    // Map principali
    queue,
    disconnectTimers,
    interactionCooldowns,
    crashRecoveryCounters,
    restartCooldowns,
    restartCounters,
    // Funzione generazione mixer
    getNextMixerGeneration
};
