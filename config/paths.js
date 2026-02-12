/**
 * Configurazione centralizzata dei percorsi del bot
 * Tutti i percorsi sono relativi alla root del progetto
 * Compatibile con Windows 11
 */

const path = require('path');
const fs = require('fs');

// Root del progetto (una directory sopra config/)
const ROOT_DIR = path.join(__dirname, '..');

// --- PERCORSI FILE DATI ---
const PLAYLIST_FILE = path.join(ROOT_DIR, 'data', 'playlists.json');
const QUEUE_FILE = path.join(ROOT_DIR, 'data', 'queue_backup.json');
const STATS_FILE = path.join(ROOT_DIR, 'data', 'stats.json');

// --- PERCORSI BINARI ---
// yt-dlp viene lanciato tramite Python (python -m yt_dlp)
// Supporta sia il comando diretto che il ripiego tramite Python
const YT_DLP_PATH = 'yt-dlp';  // Comando diretto (ripiego a python -m yt_dlp se non trovato)
const RUST_ENGINE_PATH = path.join(ROOT_DIR, 'audio_engine', 'target', 'release', 'discord_audio_mixer.exe');

// --- PERCORSI DIRECTORY ---
const LOCAL_TEMP_DIR = path.join(ROOT_DIR, 'temp');
const DATA_DIR = path.join(ROOT_DIR, 'data');

// --- UTILITY FUNZIONE PER YT-DLP ---
/**
 * Restituisce il comando e gli argomenti per lanciare yt-dlp
 * Prova prima 'yt-dlp' direttamente, poi ripiego a 'python -m yt_dlp'
 * @param {string} args - Gli argomenti aggiuntivi da passare a yt-dlp
 * @returns {object} - {cmd: string, args: string[]} - Il comando e gli argomenti
 */
function getYtDlpCommand(additionalArgs = []) {
    // Usa `python -m yt_dlp` come comando più robusto su Windows
    // Questo funziona se Python è nel PATH (che è il caso quando è installato)
    return {
        cmd: 'python',
        args: ['-m', 'yt_dlp', ...additionalArgs]
    };
}

// --- Funzioni di utilità rimosse (non usate) ---
// ensureDirectories() - Directory create on-demand
// checkCriticalFiles() - Debug-only helper

module.exports = {
    // Directory
    ROOT_DIR,
    LOCAL_TEMP_DIR,
    DATA_DIR,
    
    // File
    PLAYLIST_FILE,
    QUEUE_FILE,
    STATS_FILE,
    
    // Binari
    YT_DLP_PATH,
    RUST_ENGINE_PATH,
    
    // Funzioni
    getYtDlpCommand
};
