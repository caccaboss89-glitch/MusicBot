/**
 * Costanti centralizzate del bot
 * Tutte le costanti temporali e di configurazione
 */

// --- LIMITI ---
export const MAX_QUEUE_SIZE = 1000;              // Massimo numero canzoni in coda
export const PLAYLIST_PAGE_SIZE = 25;            // Elementi per pagina nelle playlist
export const MAX_PLAYLIST_NAME_LENGTH = 20;      // Lunghezza massima nome playlist personale
export const MAX_PLAYLISTS_PER_USER = 25;        // Massimo numero playlist per utente
export const DEFAULT_PLAYLIST_NAME = 'Generale'; // Nome playlist personale di default

// --- COSTANTI TEMPORALI (AUDIO) ---
export const CROSSFADE_DURATION_MS = 6000;       // Durata crossfade standard (6 secondi)
export const MIN_CROSSFADE_MS = 6000;            // Minimo crossfade (3 sec fine + 3 sec inizio)
export const CROSSFADE_BUFFER_MS = 3000;         // Anticipo crossfade prima della fine canzone
export const DEFAULT_SONG_DURATION_S = 180;      // Durata default canzone se non disponibile (3 minuti)

// --- COSTANTI TEMPORALI (SISTEMA) ---
export const DISCONNECT_TIMEOUT_MS = 60000;      // Timeout disconnessione bot da canale vuoto (1 minuto)
export const RECONCILE_WINDOW_MS = 5000;         // Finestra di riconciliazione per movimenti/riconnessioni (5s)
export const RESTART_COOLDOWN_MS = 5000;         // Cooldown tra restart consecutivi
export const MIN_SONG_PLAY_TIME_MS = 30000;      // Minimo tempo riproduzione prima di accettare 'end' (30 sec)

// --- COSTANTI TEMPORALI (TIMEOUT) ---
export const VOICE_CONNECTION_TIMEOUT_MS = 20000; // Timeout per stabilire connessione vocale (20 sec) - permette al Rust engine di avviarsi
export const VIDEO_DURATION_TIMEOUT_MS = 15000;  // Timeout per getVideoDuration()
export const VIDEO_INFO_TIMEOUT_MS = 120000;     // Timeout per getVideoInfo()
export const BG_FETCH_TIMEOUT_MS = 30000;        // Timeout per background fetch durata
export const PRELOAD_SONGS_TIMEOUT_MS = 35000;   // Timeout per preloadNextSongs()
export const SKIP_THROTTLE_MS = 250;             // Throttle tra skip veloci (250ms, aumentato da 150)
export const SKIP_COMMAND_TIMEOUT_MS = 3000;     // Timeout attesa conferma skip dal Rust (3 sec)
export const PROPOSAL_HANDSHAKE_MS = 500;        // Timeout handshake proposal autoplay (500ms, aumentato da 200)
export const MIXER_INVOKE_TIMEOUT_MS = 100;      // Timeout per invoke mixer (100ms)

// --- USER AGENT ---
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
