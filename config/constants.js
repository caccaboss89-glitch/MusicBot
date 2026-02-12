/**
 * Costanti centralizzate del bot
 * Tutte le costanti temporali e di configurazione
 */

// --- LIMITI ---
const MAX_QUEUE_SIZE = 1000;              // Massimo numero canzoni in coda
const PLAYLIST_PAGE_SIZE = 25;            // Elementi per pagina nelle playlist
const MAX_PLAYLIST_NAME_LENGTH = 20;      // Lunghezza massima nome playlist personale
const DEFAULT_PLAYLIST_NAME = 'Generale'; // Nome playlist personale di default

// --- COSTANTI TEMPORALI (AUDIO) ---
const CROSSFADE_DURATION_MS = 6000;       // Durata crossfade standard (6 secondi)
const MIN_CROSSFADE_MS = 6000;            // Minimo crossfade (3 sec fine + 3 sec inizio)
const CROSSFADE_BUFFER_MS = 3000;         // Anticipo crossfade prima della fine canzone
const DEFAULT_SONG_DURATION_S = 180;      // Durata default canzone se non disponibile (3 minuti)

// --- COSTANTI TEMPORALI (SISTEMA) ---
const DISCONNECT_TIMEOUT_MS = 60000;      // Timeout disconnessione bot da canale vuoto (1 minuto)
const RECONCILE_WINDOW_MS = 5000;         // Finestra di riconciliazione per movimenti/riconnessioni (5s)
const RESTART_COOLDOWN_MS = 5000;         // Cooldown tra restart consecutivi
const MIN_SONG_PLAY_TIME_MS = 30000;      // Minimo tempo riproduzione prima di accettare 'end' (30 sec)

// --- COSTANTI TEMPORALI (TIMEOUT) ---
const VIDEO_DURATION_TIMEOUT_MS = 15000;  // Timeout per getVideoDuration()
const VIDEO_INFO_TIMEOUT_MS = 120000;     // Timeout per getVideoInfo()
const BG_FETCH_TIMEOUT_MS = 30000;        // Timeout per background fetch durata
const PRELOAD_SONGS_TIMEOUT_MS = 35000;   // Timeout per preloadNextSongs()
const SKIP_THROTTLE_MS = 250;             // Throttle tra skip veloci (250ms, aumentato da 150)
const SKIP_COMMAND_TIMEOUT_MS = 3000;     // Timeout attesa conferma skip dal Rust (3 sec)
const PROPOSAL_HANDSHAKE_MS = 500;        // Timeout handshake proposal autoplay (500ms, aumentato da 200)
const MIXER_INVOKE_TIMEOUT_MS = 100;      // Timeout per invoke mixer (100ms)

// --- USER AGENT ---
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

module.exports = {
    // Limiti
    MAX_QUEUE_SIZE,
    PLAYLIST_PAGE_SIZE,
    MAX_PLAYLIST_NAME_LENGTH,
    DEFAULT_PLAYLIST_NAME,
    
    // Audio
    CROSSFADE_DURATION_MS,
    MIN_CROSSFADE_MS,
    CROSSFADE_BUFFER_MS,
    DEFAULT_SONG_DURATION_S,
    
    // Sistema
    DISCONNECT_TIMEOUT_MS,
    RECONCILE_WINDOW_MS,
    RESTART_COOLDOWN_MS,
    MIN_SONG_PLAY_TIME_MS,
    
    // Timeout
    VIDEO_DURATION_TIMEOUT_MS,
    VIDEO_INFO_TIMEOUT_MS,
    BG_FETCH_TIMEOUT_MS,
    PRELOAD_SONGS_TIMEOUT_MS,
    SKIP_THROTTLE_MS,
    SKIP_COMMAND_TIMEOUT_MS,
    PROPOSAL_HANDSHAKE_MS,
    MIXER_INVOKE_TIMEOUT_MS,
    
    // Altro
    USER_AGENT
};
