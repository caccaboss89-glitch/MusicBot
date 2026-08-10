/**
 * src/ui/messages.js
 * User-facing strings.
 *
 * The bot talks to users in Italian; logs and comments stay in English.
 * Everything the user can read lives here, so the same situation never ends up
 * with two different wordings (or two different languages) in two files.
 */

// ─── Voice / connection ─────────────────────────────────────
export const JOIN_VOICE = '❌ Entra in vocale!';
export const VOICE_CONNECTION_ERROR = '❌ Errore di connessione vocale.';

// ─── Search / queue ─────────────────────────────────────────
export const SEARCH_ERROR = '❌ Errore durante la ricerca.';
export const SEARCH_TERM_REQUIRED = '❌ Inserisci un termine di ricerca.';
export const NO_RESULTS = '❌ Nessun risultato.';
export const QUEUE_LIMIT_REACHED = '❌ **Limite della coda raggiunto!**';
export const QUEUE_EMPTY = '❌ La coda è vuota.';
export const TASK_IN_PROGRESS = '⚠️ **Sto elaborando...**';

/**
 * @param {number} count - Number of songs added to the queue
 * @returns {string}
 */
export const songsAdded = (count) => `✅ Aggiunte **${count}** canzoni.`;

// ─── Dashboard / playback ───────────────────────────────────
export const DASHBOARD_OPENED = '✅ Dashboard aperta.';
export const DASHBOARD_OPENED_FINISHED = '✅ Dashboard aperta (coda terminata).';
export const DASHBOARD_OPEN_ERROR = '❌ Impossibile aprire la dashboard.';
export const SESSION_RESUMED = '✅ **Sessione ripresa!**';
export const SESSION_RESTORED_UPDATED = '✅ **Sessione ripristinata e aggiornata!**';
export const PLAYBACK_STARTING = '✅ Avvio riproduzione...';
export const PLAYBACK_START_ERROR = '❌ Errore durante l\'avvio della riproduzione.';
export const LOADING_FOOTER = '⏳ Caricamento in corso...';
export const SKIP_FAILED = '❌ Impossibile saltare. Riprova tra un momento.';
export const PAUSE_TOGGLE_FAILED = '❌ Impossibile mettere in pausa o riprendere la riproduzione.';

// ─── Embeds ─────────────────────────────────────────────────
export const NO_SONGS = '🚫 Nessuna canzone';
export const ADD_SONGS_TO_START = 'Aggiungi una canzone per iniziare!';
export const NOW_PLAYING = '🎶 In riproduzione';
export const REQUESTED_BY = 'Richiesta da';
export const QUEUE_FINISHED = '🚫 Coda terminata';
export const QUEUE_FINISHED_HINT = 'Premi 🔁 per riascoltare l\'ultima canzone';
export const LAST_PLAYED = 'Ultima riprodotta:';
export const ADD_SONGS_TO_RESTART = 'Aggiungi canzoni per ricominciare!';
export const UNKNOWN_SONG = 'Canzone sconosciuta';
export const PLAYBACK_ERROR_TITLE = '⚠️ Errore di riproduzione';
export const PLAYBACK_ERROR_WILL_SKIP = 'Non è stato possibile ricevere audio per questa canzone. Passo alla successiva.';
export const PLAYBACK_ERROR_GAVE_UP = 'Non è stato possibile ricevere audio. Troppi errori consecutivi, riproduzione interrotta.';

// ─── Lyrics ─────────────────────────────────────────────────
export const NO_SONG_PLAYING = '❌ Nessuna canzone in riproduzione.';

/**
 * @param {string} title - Sanitized song title
 * @returns {string}
 */
export const lyricsSearching = (title) => `🔎 Cerco il testo di **${title}**...`;

/**
 * @param {string} title - Sanitized song title
 * @returns {string}
 */
export const lyricsNotFound = (title) => `📜 Testo non trovato per **${title}**.`;

/**
 * @param {string} title - Sanitized song title
 * @returns {string}
 */
export const lyricsHeader = (title) => `📜 **${title}**\n\n`;

// ─── YouTube Mix ────────────────────────────────────────────
export const MIX_GENERATING = '✨ **Generazione YouTube Mix in corso...**';
export const MIX_NEEDS_SEED = '❌ Serve almeno una canzone salvata o in riproduzione per generare un Mix!';
export const MIX_NO_RESULTS = '❌ Nessuna canzone trovata nel Mix.';
export const MIX_ERROR = '❌ Errore durante la generazione del Mix.';

/**
 * @param {string} title - Sanitized title of the seed song
 * @returns {string}
 */
export const mixGeneratedFrom = (title) => `✨ YouTube Mix generato da: **${title}**`;

// ─── Playlists ──────────────────────────────────────────────
export const PLAYLIST_NOT_FOUND = '❌ Playlist non trovata.';
export const PLAYLIST_NOT_FOUND_ORIGINAL = '❌ Playlist originale non trovata.';
export const PLAYLIST_EMPTY = '❌ Playlist vuota.';
export const SONG_NOT_FOUND = '❌ Canzone non trovata.';
export const PLAYLIST_CREATION_ERROR = '❌ Errore durante la creazione della playlist.';
export const PLAYLIST_RENAME_ERROR = '❌ Errore durante la rinomina della playlist.';
export const NO_SAVED_SONGS = '📭 Nessuna canzone salvata.';
export const NO_SEARCH_RESULTS = '🔍 Nessun risultato trovato.';

/**
 * @param {string} name - Name of the protected default playlist
 * @returns {string}
 */
export const defaultPlaylistNotRenamable = (name) => `❌ La playlist "${name}" non può essere rinominata.`;

/**
 * @param {string} name - Name of the protected default playlist
 * @returns {string}
 */
export const defaultPlaylistNotDeletable = (name) => `❌ La playlist "${name}" non può essere eliminata.`;

/**
 * @param {string} name - Name that is already taken
 * @returns {string}
 */
export const playlistAlreadyExists = (name) => `❌ Esiste già una playlist con il nome **${name}**.`;

/**
 * @param {number} maxPlaylists - Maximum number of playlists allowed
 * @returns {string}
 */
export const playlistLimitReached = (maxPlaylists) => `❌ Hai raggiunto il limite massimo di ${maxPlaylists} playlist.`;

/**
 * @param {string} name - Playlist name
 * @returns {string}
 */
export const playlistCreated = (name) => `✅ Playlist **${name}** creata! Ora è la tua playlist attiva.`;

/**
 * @param {string} oldName - Previous playlist name
 * @param {string} newName - New playlist name
 * @returns {string}
 */
export const playlistRenamed = (oldName, newName) => `✅ Playlist rinominata: **${oldName}** → **${newName}**`;
