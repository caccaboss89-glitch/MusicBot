/**
 * Centralized bot constants
 * All timing and configuration constants
 */

// --- LIMITS ---
export const MAX_QUEUE_SIZE = 1000;              // Maximum number of songs in queue
export const PLAYLIST_PAGE_SIZE = 25;            // Items per page in playlists
export const MAX_PLAYLIST_NAME_LENGTH = 20;      // Maximum length of personal playlist name
export const MAX_PLAYLISTS_PER_USER = 25;        // Maximum number of playlists per user
export const DEFAULT_PLAYLIST_NAME = 'Generale'; // Default personal playlist name

// Longest track accepted into the queue. The audio engine buffers every decoded
// sample of the playing track (48 kHz x 2 ch x 4 bytes = 1.32 GB per hour, per
// deck), so this is what keeps the engine's memory bounded. Mirrored by
// MAX_TRACK_MINUTES in audio_engine/src/config.rs, which enforces it again on
// the Rust side: keep the two in step.
export const MAX_SONG_DURATION_SECONDS = 12 * 60;

// --- TIMING CONSTANTS (AUDIO) ---
export const CROSSFADE_DURATION_MS = 6000;       // Standard crossfade duration (6 seconds)

// --- TIMING CONSTANTS (SYSTEM) ---
export const DISCONNECT_TIMEOUT_MS = 60000;      // Bot disconnect from empty channel timeout (1 minute)
export const RECONCILE_WINDOW_MS = 5000;         // Reconciliation window for moves/reconnections (5s)
// A paused session keeps the whole engine (and its buffers) alive for nothing.
// Past this the bot disconnects and everything it holds is released.
export const MAX_PAUSE_MS = 5 * 60 * 1000;       // Maximum pause before disconnecting (5 min)
export const MAX_CONSECUTIVE_PLAYBACK_FAILURES = 3; // Unplayable songs in a row before stopping the queue

// --- TIMING CONSTANTS (TIMEOUT) ---
export const VOICE_CONNECTION_TIMEOUT_MS = 20000; // Voice connection timeout (20 sec) - allows Rust engine to start
export const VIDEO_DURATION_TIMEOUT_MS = 15000;  // Timeout for getVideoDuration()
export const VIDEO_INFO_TIMEOUT_MS = 120000;     // Timeout for getVideoInfo()
export const SKIP_THROTTLE_MS = 250;             // Throttle between fast skips (250ms, increased from 150)
