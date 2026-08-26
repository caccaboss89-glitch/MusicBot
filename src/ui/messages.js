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

/**
 * Every result was refused (too long or live).
 * @param {number} maxMinutes - Maximum track length allowed
 * @returns {string}
 */
export const allSongsRejected = (maxMinutes) =>
  `❌ Nessuna canzone aggiunta: sono ammesse solo tracce non in diretta e più corte di ${maxMinutes} minuti.`;

/**
 * Some results were refused: appended to the confirmation message.
 * @param {number} tooLong - Tracks refused because too long
 * @param {number} live - Tracks refused because they are live streams
 * @param {number} maxMinutes - Maximum track length allowed
 * @returns {string}
 */
export const rejectedSongsNotice = (tooLong, live, maxMinutes) => {
  const parts = [];
  if (tooLong > 0) parts.push(`${tooLong} più lunghe di ${maxMinutes} minuti`);
  if (live > 0) parts.push(`${live} in diretta`);
  return parts.length > 0 ? `
⚠️ Scartate: ${parts.join(', ')}.` : '';
};

/**
 * A single track was refused because it exceeds the length limit.
 * @param {number} maxMinutes - Maximum track length allowed
 * @returns {string}
 */
export const songTooLong = (maxMinutes) =>
  `❌ Traccia troppo lunga: il limite è ${maxMinutes} minuti.`;

export const SONG_IS_LIVE = '❌ Le dirette non sono supportate.';

/**
 * Another server is already using the player.
 * @returns {string}
 */
export const PLAYER_BUSY_ELSEWHERE = '❌ Il player è già in uso in un altro server: riprova quando la riproduzione sarà terminata.';
export const TASK_IN_PROGRESS = '⚠️ **Sto elaborando...**';

/**
 * @param {number} count - Number of songs added to the queue
 * @returns {string}
 */
export const songsAdded = (count) => `✅ Aggiunte **${count}** canzoni.`;

// ─── Dashboard / playback ───────────────────────────────────
export const DASHBOARD_OPENED = '✅ Dashboard aperta.';
export const DASHBOARD_OPEN_ERROR = '❌ Impossibile aprire la dashboard.';
export const SESSION_RESUMED = '✅ **Sessione ripresa!**';
export const SESSION_RESTORED_UPDATED = '✅ **Sessione ripristinata e aggiornata!**';
export const PLAYBACK_STARTING = '✅ Avvio riproduzione...';
export const PLAYBACK_START_ERROR = '❌ Errore durante l\'avvio della riproduzione.';
export const LOADING_FOOTER = '⏳ Caricamento in corso...';

/**
 * The bot left the channel after being paused for too long.
 * @param {number} minutes - Pause limit in minutes
 * @returns {string}
 */
export const pausedTooLong = (minutes) =>
  `⏸️ In pausa da più di ${minutes} minuti: mi disconnetto per liberare memoria. Usa \`/play\` per riprendere.`;
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

/**
 * @param {number} count - Number of songs added to the playlist
 * @returns {string}
 */
export const playlistSongsAdded = (count) => `✅ Aggiunte ${count} canzoni dalla playlist.`;

/**
 * @param {string} plName - Playlist name
 * @param {number} deletedCount - Number of songs in deleted playlist
 * @returns {string}
 */
export const playlistDeleted = (plName, deletedCount) => `🗑️ Playlist **${plName}** eliminata (${deletedCount} canzoni rimosse).`;

/**
 * @param {string} activePlName - Active playlist name
 * @returns {string}
 */
export const songRemovedFromPlaylist = (activePlName) => `🗑️ Rimossa da: **${activePlName}**!`;

/**
 * @param {string} activePlName - Active playlist name
 * @returns {string}
 */
export const songAddedToPlaylist = (activePlName) => `✅ Aggiunta a: **${activePlName}**!`;

/**
 * @param {string} title - Sanitized song title
 * @returns {string}
 */
export const songStartedPlaying = (title) => `🚀 Avviata: **${title}**`;

/**
 * @param {string} title - Sanitized song title
 * @returns {string}
 */
export const songAddedAsNext = (title) => `➕ Aggiunta come prossima: **${title}**`;

// ─── Components / UI strings ─────────────────────────────────
export const EMPTY_PLACEHOLDER = 'Vuoto';
export const SELECT_SONG_PLACEHOLDER = '⚡ Seleziona una canzone per le azioni...';
export const SELECT_PLAYLIST_PLACEHOLDER = '📂 Seleziona playlist...';
export const NO_SEARCH_RESULTS_FOOTER = 'Nessun risultato';
export const NO_QUEUE_PLACEHOLDER = '🚫 Nessuna canzone in coda';
export const UNKNOWN_QUEUE_TITLE = 'Sconosciuta';
export const ADD_BUTTON = 'Aggiungi';
export const MIX_BUTTON = 'Mix';
export const CLEAR_QUEUE_BUTTON = 'Svuota coda';
export const CREATE_BUTTON = 'Crea';
export const DELETE_BUTTON = 'Elimina';
export const BACK_TO_PLAYLIST_BUTTON = 'Playlist';

/**
 * @param {number} totalItems - Songs in the server playlist
 * @returns {string}
 */
export const serverPlaylistTitle = (totalItems) => `📂 Playlist Server (${totalItems})`;

/**
 * @param {string} name - Playlist name
 * @param {number} totalItems - Songs in that playlist
 * @returns {string}
 */
export const userPlaylistTitle = (name, totalItems) => `👤 Playlist: ${name} (${totalItems})`;

/**
 * @param {number} page - Zero-based current page
 * @param {number} maxPage - Zero-based last page
 * @returns {string}
 */
export const paginationFooter = (page, maxPage) => `Pagina ${page + 1} di ${maxPage + 1}`;

/**
 * @param {string} query - Already truncated search term
 * @param {number} totalResults
 * @returns {string}
 */
export const serverSearchTitle = (query, totalResults) => `🔍 Cerca: "${query}" (${totalResults} risultati)`;

/**
 * @param {string} name - Playlist being searched
 * @param {string} query - Already truncated search term
 * @param {number} totalResults
 * @returns {string}
 */
export const userSearchTitle = (name, query, totalResults) => `🔍 Cerca in ${name}: "${query}" (${totalResults})`;

/**
 * @param {number} songsInQueue - Songs still queued after the current one
 * @returns {string}
 */
export const queuePlaceholder = (songsInQueue) => `📜 Prossime in coda (${songsInQueue})...`;

// ─── Playlist action modals ────────────────────────────────────
export const ACTION_TITLE = '⚡ Azioni Playlist';
export const PLAY_BUTTON = 'Riproduci';
export const REMOVE_BUTTON = 'Rimuovi';
export const BACK_MODAL_BUTTON = 'Indietro';

// ─── Search modals ────────────────────────────────────────────
export const SEARCH_MODAL_TITLE_SERVER = 'Cerca nella Playlist Server';
export const SEARCH_MODAL_TITLE_USER = 'Cerca nella Playlist';
export const SEARCH_SONG_LABEL = 'Nome canzone da cercare';
export const SEARCH_SONG_PLACEHOLDER = 'Es: Bohemian Rhapsody...';

// ─── Create/Rename modals ────────────────────────────────────
export const CREATE_PLAYLIST_TITLE = 'Crea Nuova Playlist';
export const RENAME_PLAYLIST_TITLE = 'Rinomina Playlist';
export const PLAYLIST_NAME_PLACEHOLDER = 'Es: Rock, Chill, Preferiti...';

/**
 * @param {number} maxLength - Maximum playlist name length
 * @returns {string}
 */
export const createPlaylistLabel = (maxLength) => `Nome playlist (max ${maxLength} caratteri)`;

/**
 * @param {number} maxLength - Maximum playlist name length
 * @returns {string}
 */
export const renamePlaylistLabel = (maxLength) => `Nuovo nome (max ${maxLength} caratteri)`;

// ─── Delete confirmation ──────────────────────────────────────
export const DELETE_CONFIRMATION_TITLE = '⚠️ Conferma eliminazione';

/**
 * @param {string} name - Playlist about to be deleted
 * @param {number} songCount - Songs it holds
 * @returns {string}
 */
export const deleteConfirmationMessage = (name, songCount) => {
  const songLabel = songCount === 1 ? 'canzone' : 'canzoni';
  return `Sei sicuro di voler eliminare la playlist **${name}**?\n\nContiene **${songCount}** ${songLabel}.\nQuesta azione non può essere annullata.`;
};
export const CONFIRM_BUTTON = 'Conferma';
export const CANCEL_BUTTON = 'Annulla';

// ─── Add song modal ───────────────────────────────────────────
export const ADD_SONG_MODAL_TITLE = 'Aggiungi canzone';
export const ADD_SONG_INPUT_LABEL = 'Link o nome';

// ─── YouTube / Video info ────────────────────────────────────
export const UNKNOWN_TITLE = 'Titolo sconosciuto';
