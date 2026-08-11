/**
 * src/audio/index.js
 * Public surface of the audio system, for callers outside the audio layer.
 *
 * Modules, from the lowest level up:
 *   crash-cooldown.js  how long ago each guild's mixer died
 *   SerialQueue.js     serializes mixer commands and user operations
 *   AudioMixerController.js  owns one Rust mixer process
 *   playback.js        starts/stops the mixer and the Discord player
 *   PlaybackEngine.js  preload and playback-confirmation timers
 *   SkipManager.js     transitions between songs
 *   teardown.js        stops a guild's audio, from any of the four ways it ends
 *   recovery.js        restarts playback after a mixer crash
 *   rust-events.js     routes the events emitted by the Rust engine
 *
 * The upper modules call into the lower ones; the few calls that go the other
 * way (a transition asking for a preload, a crash asking for a restart) are
 * function calls resolved at run time, never at import time.
 */

export { playSong, restartCurrentSong, togglePauseResume } from './playback.js';
export { updatePreloadAfterQueueChange, clearAllTimers } from './PlaybackEngine.js';
export { skipNext, skipPrev, skipToIndex, endQueue, cleanupSkipState } from './SkipManager.js';
export { handleRustEvent, clearStreamErrors, isFailedSong } from './rust-events.js';
export { handleMixerCrash } from './recovery.js';
export {
  stopGuildAudio,
  clearGuildAudioState,
  performDisconnectCleanup,
  scheduleDisconnectIfAlone,
  cancelScheduledDisconnect
} from './teardown.js';
export { commandQueue, audioOperationBarrier } from './SerialQueue.js';
