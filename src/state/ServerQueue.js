/**
 * src/state/ServerQueue.js
 * Class representing playback state for a single guild.
 * Replaces the ad-hoc object created in connection.js, ensuring
 * all properties are explicitly declared.
 */

import { createAudioPlayer } from '@discordjs/voice';

class ServerQueue {
  /**
     * @param {object} opts
     * @param {string} opts.guildId
     * @param {import('discord.js').TextChannel|null} [opts.textChannel]
     * @param {import('discord.js').VoiceChannel|null} [opts.voiceChannel]
     */
  constructor({ guildId, textChannel = null, voiceChannel = null }) {
    // ── Identity ──
    this.guildId = guildId;

    // ── Discord Channels ──
    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;

    // ── Connection and Player ──
    this.connection = null;
    this.player = createAudioPlayer();

    // ── Queue and Navigation ──
    this.songs = [];
    this.history = [];
    this.playIndex = 0;

    // ── Playback State ──
    this.isPaused = false;
    this.isTaskRunning = false;
    this.loopEnabled = false;
    this.fadeEnabled = true;
    this.songStartTime = null;
    this.pauseStart = null;
    this.sessionRestored = false;

    // ── Deck and Mixer ──
    this.mixer = null;
    this.currentDeck = null;
    this.currentDeckLoaded = null;
    this.nextDeckLoaded = null;
    this.nextDeckTarget = null;
    this.bufferReady = {};
    this.mixerStarting = false;
    this.mixerGeneration = null;

    // ── Deck → Song Binding (source of truth for embed sync) ──
    // For each deck registers { index, url } of the actually loaded song.
    // When Rust switches decks autonomously (auto-gapless) we know for sure
    // WHICH song (index in songs[]) is now playing, without "guessing" playIndex+1.
    this.deckSongs = { A: null, B: null };

    // ── Crossfade ──
    this.isCrossfading = false;
    this.crossfadeStartTime = null;

    // ── Deferred Transition ──
    this.pendingTransition = null;

    // ── Crash Recovery ──
    this.crashRecoveryAttempts = 0;
    this.intentionalKill = false;

    // ── UI / Dashboard ──
    this.dashboardMessage = null;
    this.dashboardMessageId = null;
    this.textChannelId = null;
    this.loadingFooter = null;
    this.dashboardState = null;

    // ── Internal (low-latency stream) ──
    this._llStream = null;
    this._lastTransitionTime = null;
  }
}

export default ServerQueue;
