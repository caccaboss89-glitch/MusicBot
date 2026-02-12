/**
 * src/ui/dashboard.js
 * Funzioni per la gestione della dashboard
 */

const { createCurrentSongEmbed, createFinishedEmbed } = require('./embeds');
const { createDashboardComponents } = require('./components');

/**
 * Tenta di recuperare il messaggio dashboard dal canale usando l'ID salvato
 * @param {Object} serverQueue
 * @returns {Promise<Message|null>}
 */
async function tryRestoreDashboardMessage(serverQueue) {
    if (!serverQueue || !serverQueue.textChannel || !serverQueue.dashboardMessageId) return null;
    
    try {
        const message = await serverQueue.textChannel.messages.fetch(serverQueue.dashboardMessageId);
        if (message) {
            console.log(`✅ [DASHBOARD] Messaggio dashboard recuperato da backup (id=${serverQueue.dashboardMessageId})`);
            serverQueue.dashboardMessage = message;
            return message;
        }
    } catch (e) {
        // Messaggio non trovato (cancellato o scaduto)
        console.warn(`⚠️ [DASHBOARD] Messaggio salvato non trovato (id=${serverQueue.dashboardMessageId}):`, e.message);
        serverQueue.dashboardMessageId = null;
        serverQueue.dashboardMessage = null;
    }
    return null;
}

/**
 * Aggiorna la dashboard con throttling per evitare rate limit
 * @param {Object} serverQueue - La coda del server
 * @param {EmbedBuilder} embed - L'embed da mostrare
 * @param {ActionRowBuilder[]} components - I componenti da mostrare
 */
async function updateDashboard(serverQueue, embed, components) {
    if (!serverQueue || !serverQueue.textChannel) return false;

    if (!serverQueue.dashboardState) {
        serverQueue.dashboardState = { isUpdating: false, lastUpdate: 0, nextData: null, timer: null };
    }
    const state = serverQueue.dashboardState;
    state.nextData = { embed, components };

    if (state.isUpdating || state.timer) return true;

    const performUpdate = async () => {
        if (!state.nextData) { state.isUpdating = false; return; }
        const dataToUse = state.nextData;
        state.nextData = null; 
        state.isUpdating = true;

        try {
            const channel = serverQueue.textChannel;
            if (!channel || !channel.send) {
                console.warn('⚠️ [DASHBOARD] Invalid textChannel on serverQueue');
                state.isUpdating = false;
                return false;
            }

            // Se il messaggio non è in memoria, prova a recuperarlo dal backup (ID salvato)
            if (!serverQueue.dashboardMessage && serverQueue.dashboardMessageId) {
                await tryRestoreDashboardMessage(serverQueue);
            }

            if (serverQueue.dashboardMessage) {
                // Verifica che `dashboardMessage` memorizzato sia ancora l'ultimo messaggio nel canale.
                try {
                    const last = await channel.messages.fetch({ limit: 1 });
                    const lastMsg = last.first();
                    if (lastMsg && lastMsg.id !== serverQueue.dashboardMessage.id) {
                            // Esiste una dashboard vecchia ma non è l'ultima: rimuovila e forza il reinvio
                        try { await serverQueue.dashboardMessage.delete().catch(() => {}); } catch (e) {}
                        serverQueue.dashboardMessage = null;
                        serverQueue.dashboardMessageId = null;
                        serverQueue.dashboardMessage = await channel.send({ embeds: [dataToUse.embed], components: dataToUse.components });
                        serverQueue.dashboardMessageId = serverQueue.dashboardMessage.id;
                    } else {
                        await serverQueue.dashboardMessage.edit({ embeds: [dataToUse.embed], components: dataToUse.components });
                    }
                } catch (e) {
                    // Se qualcosa fallisce, tenta di reinviare la dashboard
                    try { 
                        serverQueue.dashboardMessage = await channel.send({ embeds: [dataToUse.embed], components: dataToUse.components }); 
                        serverQueue.dashboardMessageId = serverQueue.dashboardMessage.id;
                    } catch (err) { throw err; }
                }
            } else {
                serverQueue.dashboardMessage = await channel.send({ embeds: [dataToUse.embed], components: dataToUse.components });
                serverQueue.dashboardMessageId = serverQueue.dashboardMessage.id;
            }
            state.lastUpdate = Date.now();
        } catch (e) {
            console.error("⚠️ [DASHBOARD] Rate Limit/Error:", e.message);
            state.isUpdating = false;
            return false;
        } finally {
            state.isUpdating = false;
            if (state.nextData) {
                const timeSinceLast = Date.now() - state.lastUpdate;
                const delay = Math.max(0, 1000 - timeSinceLast);
                state.timer = setTimeout(() => {
                    state.timer = null;
                    performUpdate();
                }, delay);
            }
            return true;
        }
    };
    return performUpdate();
}

/**
 * Aggiorna la dashboard allo stato "coda terminata"
 * @param {Object} serverQueue - La coda del server
 * @param {Object|null} lastSong - L'ultima canzone riprodotta
 */
async function updateDashboardToFinished(serverQueue, lastSong) {
    if (!serverQueue) return;
    try {
        if (!serverQueue.dashboardMessage) {
            // Prova a recuperare il messaggio dal backup prima di crearne uno nuovo
            if (!serverQueue.dashboardMessage && serverQueue.dashboardMessageId) {
                await tryRestoreDashboardMessage(serverQueue);
            }
            
            // Se ancora non c'è un messaggio, creane uno nuovo
            if (!serverQueue.dashboardMessage) {
                console.log(`🔔 [DASH] updateDashboardToFinished creating message guild=${serverQueue.guildId || 'unknown'}`);
                const channel = serverQueue.textChannel;
                if (channel && channel.send) {
                    try { 
                        serverQueue.dashboardMessage = await channel.send({ embeds: [createFinishedEmbed(lastSong)], components: createDashboardComponents(serverQueue) }); 
                        serverQueue.dashboardMessageId = serverQueue.dashboardMessage.id;
                    } catch (e) { console.error(`⚠️ [DASH] failed to send finished dashboard:`, e && e.message); }
                }
            }
        }
    } catch (e) { console.error('⚠️ [DASH] updateDashboardToFinished preflight error', e); }
    const embed = createFinishedEmbed(lastSong);
    const components = createDashboardComponents(serverQueue);
    if (lastSong) {
        // Determina lo stato 'terminato': nessun deck caricato = coda finita
        const isTerminated = serverQueue && !serverQueue.currentDeckLoaded;
        try {
            if (components[0] && components[0].components) {
                // replay idx 0, prev idx 1, pause idx 2, skip idx 3
                if (components[0].components[0]) components[0].components[0].setDisabled(false);
                if (components[0].components[1]) components[0].components[1].setDisabled(true);
                if (components[0].components[2]) components[0].components[2].setDisabled(true);
                if (components[0].components[3]) components[0].components[3].setDisabled(true);
            }
            // controlli secondari: disabilita loop/shuffle/fade
            if (components[1] && components[1].components) components[1].components.forEach(c => c.setDisabled(true));
            // riga playlist: mantieni i pulsanti 'open playlist' abilitati quando terminato
            if (components[2] && components[2].components) {
                if (components[2].components[0]) components[2].components[0].setDisabled(false); // open_plist_server
                if (components[2].components[2]) components[2].components[2].setDisabled(false); // open_plist_likes
                // i toggle rimangono come creati (probabilmente disabilitati)
            }
            // riga select: mantenerla disabilitata
            if (components[3] && components[3].components) components[3].components.forEach(c => c.setDisabled(true));
            // riga azioni: abilita 'add' e 'mix' se terminato, mantieni 'clear' disabilitato
            if (components[4] && components[4].components) {
                if (components[4].components[0]) components[4].components[0].setDisabled(false); // add
                if (components[4].components[1]) components[4].components[1].setDisabled(!isTerminated); // mix solo quando terminata
                if (components[4].components[2]) components[4].components[2].setDisabled(true); // clear
            }
            } catch (e) { /* ignora */ }
    }
    await updateDashboard(serverQueue, embed, components);
}

/**
 * Aggiorna rapidamente la dashboard usando l'embed canzone corrente
 * @param {Object} serverQueue
 * @param {string|null} userId
 */
async function refreshDashboard(serverQueue, userId = null) {
    try {
        const embed = createCurrentSongEmbed(serverQueue);
        const components = createDashboardComponents(serverQueue, userId);
        return await updateDashboard(serverQueue, embed, components);
    } catch (e) {
        console.error('⚠️ [DASHBOARD] refreshDashboard error:', e);
        return false;
    }
}

module.exports = {
    updateDashboard,
    updateDashboardToFinished,
    // Re-export per comodità
    createCurrentSongEmbed,
    createFinishedEmbed,
    createDashboardComponents,
    refreshDashboard
};
