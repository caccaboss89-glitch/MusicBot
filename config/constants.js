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

// --- TIMING CONSTANTS (AUDIO) ---
export const CROSSFADE_DURATION_MS = 6000;       // Standard crossfade duration (6 seconds)
export const MIN_CROSSFADE_MS = 6000;            // Minimum crossfade (3 sec end + 3 sec start)
export const CROSSFADE_BUFFER_MS = 3000;         // Crossfade advance before song end
export const DEFAULT_SONG_DURATION_S = 180;      // Default song duration if unavailable (3 minutes)

// --- TIMING CONSTANTS (SYSTEM) ---
export const DISCONNECT_TIMEOUT_MS = 60000;      // Bot disconnect from empty channel timeout (1 minute)
export const RECONCILE_WINDOW_MS = 5000;         // Reconciliation window for moves/reconnections (5s)
export const RESTART_COOLDOWN_MS = 5000;         // Cooldown between consecutive restarts
export const MIN_SONG_PLAY_TIME_MS = 30000;      // Minimum playback time before accepting 'end' (30 sec)
export const MAX_CONSECUTIVE_PLAYBACK_FAILURES = 3; // Unplayable songs in a row before stopping the queue

// --- TIMING CONSTANTS (TIMEOUT) ---
export const VOICE_CONNECTION_TIMEOUT_MS = 20000; // Voice connection timeout (20 sec) - allows Rust engine to start
export const VIDEO_DURATION_TIMEOUT_MS = 15000;  // Timeout for getVideoDuration()
export const VIDEO_INFO_TIMEOUT_MS = 120000;     // Timeout for getVideoInfo()
export const BG_FETCH_TIMEOUT_MS = 30000;        // Timeout for background fetch duration
export const PRELOAD_SONGS_TIMEOUT_MS = 35000;   // Timeout for preloadNextSongs()
export const SKIP_THROTTLE_MS = 250;             // Throttle between fast skips (250ms, increased from 150)
export const SKIP_COMMAND_TIMEOUT_MS = 3000;     // Timeout waiting for skip confirmation from Rust (3 sec)
export const PROPOSAL_HANDSHAKE_MS = 500;        // Autoplay proposal handshake timeout (500ms, increased from 200)
export const MIXER_INVOKE_TIMEOUT_MS = 100;      // Timeout for mixer invoke (100ms)

// --- USER AGENT ---
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
