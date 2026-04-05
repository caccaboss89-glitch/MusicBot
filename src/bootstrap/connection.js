const { queue } = require('../state/globals');
const ServerQueue = require('../state/ServerQueue');
const { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer } = require('@discordjs/voice');
const { scheduleDisconnectIfAlone, cancelScheduledDisconnect } = require('../queue/QueueManager');
const { loadQueueBackup } = require('../queue/persistence');
const { DISCONNECT_TIMEOUT_MS, RECONCILE_WINDOW_MS, VOICE_CONNECTION_TIMEOUT_MS } = require('../../config');
const { safeReply } = require('../utils/discord');

async function ensureBotConnection(interaction) {
    if (!interaction || !interaction.guildId) return null;
    const guildId = interaction.guildId;
    let serverQueue = queue.get(guildId);
    if (!serverQueue) {
        serverQueue = new ServerQueue({
            guildId,
            textChannel: interaction.channel || null,
            voiceChannel: interaction.member?.voice?.channel || null
        });
        // Tentativo di ripristino da backup salvato
        try {
            const backup = loadQueueBackup(guildId);
            if (backup && ((backup.songs && backup.songs.length > 0) || (backup.history && backup.history.length > 0))) {
                serverQueue.songs = Array.isArray(backup.songs) ? backup.songs.slice() : [];
                serverQueue.history = Array.isArray(backup.history) ? backup.history.slice() : [];
                serverQueue.playIndex = backup.playIndex || 0;
                serverQueue.isPaused = !!backup.isPaused;
                serverQueue.loopEnabled = !!backup.loopEnabled;
                serverQueue.fadeEnabled = !!backup.fadeEnabled;
                serverQueue.dashboardMessageId = backup.dashboardMessageId || null;
                serverQueue.textChannelId = backup.textChannelId || null;
                // NON ripristinare currentDeckLoaded: al riavvio del bot non c'è mixer,
                // quindi il deck non è effettivamente caricato. Impostarlo causerebbe
                // il mancato avvio di playSong() quando l'utente aggiunge canzoni.
                serverQueue.currentDeckLoaded = null;
                serverQueue.sessionRestored = true;
            }
        } catch (e) { console.error('Errore caricamento backup coda:', e); }
        queue.set(guildId, serverQueue);
    } else {
        if (!serverQueue.player || typeof serverQueue.player.play !== 'function') serverQueue.player = createAudioPlayer();
        serverQueue.textChannel = serverQueue.textChannel || interaction.channel || null;
        serverQueue.voiceChannel = serverQueue.voiceChannel || interaction.member?.voice?.channel || serverQueue.voiceChannel || null;
    }
    return serverQueue;
}

async function connectToVoice(serverQueue, interaction) {
    try {
        if (!serverQueue) return false;
        // Preferisci il canale vocale del membro invocante (cerca di seguire l'utente), ripiego a quello memorizzato
        const memberVoice = interaction?.member?.voice?.channel || null;
        const targetVoice = memberVoice || serverQueue.voiceChannel || null;
        if (!targetVoice) {
            await safeReply(interaction, { content: '❌ Entra in vocale!', flags: 64 });
            return false;
        }
        // Aggiorna il `voiceChannel` memorizzato al target (cerchiamo di seguire l'utente)
        serverQueue.voiceChannel = targetVoice;

        // Se esiste una connessione, convalidala. Se è pronta e corrisponde al canale target, riutilizzala.
        if (serverQueue.connection) {
            try {
                const status = serverQueue.connection.state?.status;
                const joinedChannelId = serverQueue.connection.joinConfig?.channelId || serverQueue.voiceChannel?.id;
                if (status === VoiceConnectionStatus.Ready && joinedChannelId === targetVoice.id) {
                    return true;
                }
            } catch (e) {
                // fallthrough: ricrea la connessione
            }
            // Connessione esistente obsoleta o nel canale sbagliato — distruggi e ricrea
            try { serverQueue.connection.destroy(); } catch (e) {}
            serverQueue.connection = null;
        }

        const connection = joinVoiceChannel({
            channelId: serverQueue.voiceChannel.id,
            guildId: serverQueue.guildId || interaction.guildId,
            adapterCreator: serverQueue.voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false
        });
        serverQueue.connection = connection;
        // Rimuovi listener obsoleti dalla connessione precedente (se riutilizzata)
        if (serverQueue._connStateHandler) {
            try { connection.off('stateChange', serverQueue._connStateHandler); } catch(e) {}
        }
        if (serverQueue._connErrorHandler) {
            try { connection.off('error', serverQueue._connErrorHandler); } catch(e) {}
        }
        // Cancella timer di riconciliazione pendente
        if (serverQueue._reconcileTimer) {
            clearTimeout(serverQueue._reconcileTimer);
            serverQueue._reconcileTimer = null;
        }
        // Aggiungi listener sul ciclo di vita per reagire a disconnessioni/spostamenti
        try {
            const stateChangeHandler = (oldState, newState) => {
                try {
                        if (newState.status === VoiceConnectionStatus.Destroyed) {
                        // Forza cleanup immediato
                        scheduleDisconnectIfAlone(serverQueue, 0);
                    } else if (newState.status === VoiceConnectionStatus.Ready) {
                        // Connected; cancel any pending auto-disconnect
                        cancelScheduledDisconnect(serverQueue);

                        // Reconcile potential channel mismatch between connection and stored voiceChannel
                        try {
                            const connChannelId = connection.joinConfig?.channelId;
                            const storedChannelId = serverQueue.voiceChannel?.id;
                            if (connChannelId && storedChannelId && connChannelId !== storedChannelId) {
                                // Cancella timer precedente se esiste
                                if (serverQueue._reconcileTimer) {
                                    clearTimeout(serverQueue._reconcileTimer);
                                }
                                // Attendi una finestra breve e poi riconcilia
                                serverQueue._reconcileTimer = setTimeout(() => {
                                    serverQueue._reconcileTimer = null;
                                    try {
                                        const latestStoredId = serverQueue.voiceChannel?.id;
                                        const latestConnId = connection.joinConfig?.channelId;
                                        if (latestStoredId !== latestConnId) {
                                            // Prova a risolvere l'oggetto canale dalla cache dei canali della guild
                                            const guild = serverQueue.voiceChannel?.guild;
                                            if (guild && guild.channels && guild.channels.cache) {
                                                const newChan = guild.channels.cache.get(latestConnId);
                                                if (newChan) {
                                                    serverQueue.voiceChannel = newChan;
                                                    const humanCount = newChan.members ? newChan.members.filter(m => !m.user.bot).size : 0;
                                                    if (humanCount === 0) scheduleDisconnectIfAlone(serverQueue, RECONCILE_WINDOW_MS);
                                                    else cancelScheduledDisconnect(serverQueue);
                                                } else {
                                                    scheduleDisconnectIfAlone(serverQueue, DISCONNECT_TIMEOUT_MS);
                                                }
                                            }
                                        }
                                    } catch (e) {}
                                }, RECONCILE_WINDOW_MS);
                            }
                        } catch (e) {}

                    } else if (newState.status === VoiceConnectionStatus.Disconnected) {
                        // Prova una breve finestra di riconnessione, altrimenti programma il cleanup
                        scheduleDisconnectIfAlone(serverQueue, DISCONNECT_TIMEOUT_MS);
                    }
                } catch (e) {}
            };
            const errorHandler = (err) => {
                console.error('Errore VoiceConnection:', err);
                scheduleDisconnectIfAlone(serverQueue, 0);
            };
            // Salva riferimenti per poterli rimuovere alla prossima connessione
            serverQueue._connStateHandler = stateChangeHandler;
            serverQueue._connErrorHandler = errorHandler;
            connection.on('stateChange', stateChangeHandler);
            connection.on('error', errorHandler);
        } catch (e) {}
        try { serverQueue.connection.subscribe(serverQueue.player); } catch(e){}
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, VOICE_CONNECTION_TIMEOUT_MS);
        } catch (e) {
            console.error('Connessione vocale fallita:', e);
            try { connection.destroy(); } catch(e){}
            serverQueue.connection = null;
            await safeReply(interaction, { content: '❌ Errore connessione vocale', flags: 64 });
            return false;
        }
        return true;
    } catch (e) {
        console.error('Errore connectToVoice:', e);
        return false;
    }
}

module.exports = { ensureBotConnection, connectToVoice };
