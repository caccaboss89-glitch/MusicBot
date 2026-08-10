/**
 * src/audio/index.js
 * Public surface of the audio system.
 *
 * Layering (each level only depends on the ones below it):
 *   rust-events.js  routes the events emitted by the Rust engine
 *   recovery.js     restarts playback after a mixer crash
 *   SkipManager.js  transitions between songs
 *   PlaybackEngine.js  preload and end-of-track timers
 *   playback.js     starts/stops the mixer and the Discord player
 *   SerialQueue.js  serializes mixer commands and user operations
 */

export { playSong, restartCurrentSong, togglePauseResume, resumeIfPaused } from './playback.js';
export { onSongStart, preloadNextSong, updatePreloadAfterQueueChange, handleTrackEnd, clearAllTimers } from './PlaybackEngine.js';
export { skipNext, skipPrev, skipToIndex, autoSkip, endQueue, hasSkipInProgress, cleanupSkipState } from './SkipManager.js';
export { handleRustEvent, handleBufferReady, confirmPlayback, clearStreamErrors, isFailedSong } from './rust-events.js';
export { handleMixerCrash, cleanupRecoveryState } from './recovery.js';
export { commandQueue, audioOperationBarrier } from './SerialQueue.js';
export { default as AudioMixerController } from './AudioMixerController.js';
