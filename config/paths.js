/**
 * Configurazione centralizzata dei percorsi del bot
 * Tutti i percorsi sono relativi alla root del progetto
 * Compatibile con Windows 11
 */

const path = require('path');
const fs = require('fs');

// Root del progetto (una directory sopra config/)
const ROOT_DIR = path.join(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';
const PYTHON_BIN = process.env.PYTHON_BIN || (IS_WINDOWS ? 'python' : 'python3');
const DEFAULT_YTDLP_COOKIES_FILE = path.join(ROOT_DIR, 'youtube-cookies.txt');
const DEFAULT_YTDLP_PROXY_URL = 'socks5h://127.0.0.1:5040';
const DEFAULT_YTDLP_EXTRACTOR_ARGS = 'youtube:client=ANDROID_MUSIC,ANDROID,WEB';
const DEFAULT_YTDLP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- PERCORSI FILE DATI ---
const PLAYLIST_FILE = path.join(ROOT_DIR, 'data', 'playlists.json');
const QUEUE_FILE = path.join(ROOT_DIR, 'data', 'queue_backup.json');
const STATS_FILE = path.join(ROOT_DIR, 'data', 'stats.json');

// --- PERCORSI BINARI ---
// yt-dlp viene lanciato tramite Python (python -m yt_dlp)
// Supporta sia il comando diretto che il ripiego tramite Python
const YT_DLP_PATH = 'yt-dlp';  // Comando diretto (ripiego a python -m yt_dlp se non trovato)
const RUST_ENGINE_FILENAME = IS_WINDOWS ? 'discord_audio_mixer.exe' : 'discord_audio_mixer';
const RUST_ENGINE_PATH = path.join(ROOT_DIR, 'audio_engine', 'target', 'release', RUST_ENGINE_FILENAME);

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
    const cookieFile = process.env.YTDLP_COOKIES_FILE || DEFAULT_YTDLP_COOKIES_FILE;
    const cookieArgs = fs.existsSync(cookieFile) ? ['--cookies', cookieFile] : [];
    const rawProxyUrl = process.env.YTDLP_PROXY_URL;
    const proxyUrl = (rawProxyUrl && rawProxyUrl.trim())
        ? rawProxyUrl.trim()
        : DEFAULT_YTDLP_PROXY_URL;
    const proxyArgs = proxyUrl ? ['--proxy', proxyUrl] : [];
    const rawExtractorArgs = process.env.YTDLP_EXTRACTOR_ARGS;
    const extractorArgsValue = (rawExtractorArgs && rawExtractorArgs.trim())
        ? rawExtractorArgs.trim()
        : DEFAULT_YTDLP_EXTRACTOR_ARGS;
    const extractorArgs = extractorArgsValue ? ['--extractor-args', extractorArgsValue] : [];
    const userAgentArgs = ['--user-agent', DEFAULT_YTDLP_USER_AGENT];

    // Consente override esplicito via PYTHON_BIN e usa python3 come default su Linux.
    return {
        cmd: PYTHON_BIN,
        args: ['-m', 'yt_dlp', ...proxyArgs, ...cookieArgs, ...extractorArgs, ...userAgentArgs, ...additionalArgs]
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
