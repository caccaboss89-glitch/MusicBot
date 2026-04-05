/**
 * src/state/globals.js
 * Stato globale centralizzato per il bot
 * Tutte le Map e variabili condivise tra moduli
 */

// ─── CODA PER GUILD ───────────────────────────────────────
// Map<guildId, serverQueue>
const queue = new Map();

// ─── TIMER DISCONNESSIONE ───────────────────────────────────
// Map<guildId, timeoutId> - Timer per disconnettere il bot quando resta solo
const disconnectTimers = new Map();

// --- COOLDOWN INTERAZIONI ---
// Map<guildId, Map<interactionId, timestamp>> - Previene spam di bottoni
const interactionCooldowns = new Map();

// NOTA: I pending skip sono gestiti internamente da SkipManager v3 (skipLock).

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

// Pulizia periodica cooldown interazioni per prevenire memory leak (ogni 5 minuti)
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of interactionCooldowns) {
        if (now - timestamp > 60000) interactionCooldowns.delete(key);
    }
}, 5 * 60 * 1000);

module.exports = {
    // Map principali
    queue,
    disconnectTimers,
    interactionCooldowns,
    // Funzione generazione mixer
    getNextMixerGeneration
};
