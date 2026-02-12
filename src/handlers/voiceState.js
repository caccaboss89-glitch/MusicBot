const { queue } = require('../state/globals');
const { isBotAloneInChannel, scheduleDisconnectIfAlone, cancelScheduledDisconnect } = require('../queue/QueueManager');
const { DISCONNECT_TIMEOUT_MS, RECONCILE_WINDOW_MS } = require('../../config');
const stats = require('../database/stats');

module.exports = (client) => {
    client.on('voiceStateUpdate', (oldState, newState) => {
        try {
            const guildId = oldState?.guild?.id || newState?.guild?.id;
            if (!guildId) return;
            const serverQueue = queue.get(guildId);
            if (!serverQueue) return;

            // Se lo stato del bot è cambiato (spostato/disconnesso)
            const botId = client.user?.id;
            const oldIsBot = oldState?.member?.id === botId;
            const newIsBot = newState?.member?.id === botId;

            if (oldIsBot || newIsBot) {
                const botChannel = newState?.channel || newState?.member?.voice?.channel || null;
                if (!botChannel) {
                    // Il bot è stato disconnesso/espulso - ferma tutti i timer ascolto
                    try { stats.stopAllListeners(guildId); } catch (e) {}
                    // forza cleanup immediato
                    scheduleDisconnectIfAlone(serverQueue, 0);
                    return;
                } else {
                    // Il bot si è spostato in un altro canale - aggiorna `voiceChannel` memorizzato
                    serverQueue.voiceChannel = botChannel;
                    // Conta gli umani (escludi i bot)
                    const humanCount = botChannel.members ? botChannel.members.filter(m => !m.user.bot).size : 0;
                    if (humanCount === 0) {
                        // Finestra di riconciliazione breve: se nessuno entra entro questo intervallo, disconnetti
                        scheduleDisconnectIfAlone(serverQueue, RECONCILE_WINDOW_MS);
                    } else {
                        cancelScheduledDisconnect(serverQueue);
                    }
                }
            } else {
                // Stato non-bot cambiato (membro entrato/uscito) - riesamina il canale del bot
                const vc = serverQueue.voiceChannel;
                if (!vc) return;

                // ── STATS: traccia ingresso/uscita utente dal canale del bot mentre canta ──
                try {
                    const memberId = oldState?.member?.id || newState?.member?.id;
                    const isBot = oldState?.member?.user?.bot || newState?.member?.user?.bot;
                    if (memberId && !isBot && serverQueue.currentDeckLoaded && !serverQueue.isPaused) {
                        const oldChannelId = oldState?.channelId || null;
                        const newChannelId = newState?.channelId || null;
                        const botChannelId = vc.id;

                        if (oldChannelId === botChannelId && newChannelId !== botChannelId) {
                            // Utente uscito dal canale del bot
                            stats.stopListening(guildId, memberId);
                        } else if (oldChannelId !== botChannelId && newChannelId === botChannelId) {
                            // Utente entrato nel canale del bot
                            stats.startListening(guildId, memberId);
                        }
                    }
                } catch (e) {}

                const humanCount = vc.members ? vc.members.filter(m => !m.user.bot).size : 0;
                if (humanCount === 0) scheduleDisconnectIfAlone(serverQueue, DISCONNECT_TIMEOUT_MS);
                else cancelScheduledDisconnect(serverQueue);
            }

        } catch (e) {
            console.error('Errore in voiceStateUpdate:', e);
        }
    });
};