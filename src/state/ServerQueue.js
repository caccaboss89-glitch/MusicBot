/**
 * src/state/ServerQueue.js
 * Classe che rappresenta lo stato di riproduzione per una singola guild.
 * Sostituisce l'oggetto ad-hoc creato in connection.js, garantendo
 * che tutte le proprietà siano dichiarate esplicitamente.
 */

const { createAudioPlayer } = require('@discordjs/voice');

class ServerQueue {
    /**
     * @param {object} opts
     * @param {string} opts.guildId
     * @param {import('discord.js').TextChannel|null} [opts.textChannel]
     * @param {import('discord.js').VoiceChannel|null} [opts.voiceChannel]
     */
    constructor({ guildId, textChannel = null, voiceChannel = null }) {
        // ── Identità ──
        this.guildId = guildId;

        // ── Canali Discord ──
        this.textChannel = textChannel;
        this.voiceChannel = voiceChannel;

        // ── Connessione e player ──
        this.connection = null;
        this.player = createAudioPlayer();

        // ── Coda e navigazione ──
        this.songs = [];
        this.history = [];
        this.playIndex = 0;

        // ── Stato riproduzione ──
        this.isPaused = false;
        this.isTaskRunning = false;
        this.loopEnabled = false;
        this.fadeEnabled = true;
        this.songStartTime = null;
        this.pauseStart = null;
        this.sessionRestored = false;

        // ── Deck e mixer ──
        this.mixer = null;
        this.currentDeck = null;
        this.currentDeckLoaded = null;
        this.nextDeckLoaded = null;
        this.nextDeckTarget = null;
        this.bufferReady = {};
        this.mixerStarting = false;
        this.mixerGeneration = null;

        // ── Binding deck → canzone (fonte di verità per la sincronizzazione embed) ──
        // Per ogni deck registra { index, url } della canzone effettivamente caricata.
        // Quando il Rust commuta deck autonomamente (auto-gapless) sappiamo con certezza
        // QUALE canzone (indice in songs[]) è ora in riproduzione, senza "indovinare" playIndex+1.
        this.deckSongs = { A: null, B: null };

        // ── Crossfade ──
        this.isCrossfading = false;
        this.crossfadeStartTime = null;

        // ── Transizione differita ──
        this.pendingTransition = null;

        // ── Crash recovery ──
        this.crashRecoveryAttempts = 0;
        this.intentionalKill = false;

        // ── UI / Dashboard ──
        this.dashboardMessage = null;
        this.dashboardMessageId = null;
        this.textChannelId = null;
        this.loadingFooter = null;
        this.dashboardState = null;

        // ── Interno (stream a bassa latenza) ──
        this._llStream = null;
        this._lastTransitionTime = null;
    }
}

module.exports = ServerQueue;
