/**
 * Configurazione centralizzata dei percorsi del bot
 * Tutti i percorsi sono relativi alla root del progetto
 */

const path = require('path');

// Root del progetto (una directory sopra config/)
const ROOT_DIR = path.join(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';
const PYTHON_BIN = process.env.PYTHON_BIN || (IS_WINDOWS ? 'python' : 'python3');
const DEFAULT_YTDLP_PROXY_URL = 'socks5h://127.0.0.1:5040';
const DEFAULT_YTDLP_EXTRACTOR_ARGS = 'youtube:player_client=web,android,ios,mweb';
const DEFAULT_YTDLP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isEnvDisabled(value) {
    if (!value || !String(value).trim()) return true;
    const v = String(value).trim().toLowerCase();
    return v === 'none' || v === 'off' || v === 'false' || v === '0' || v === 'no';
}

function resolveYtDlpProxyUrl() {
    if (process.env.YTDLP_PROXY_URL !== undefined) {
        const raw = process.env.YTDLP_PROXY_URL.trim();
        return isEnvDisabled(raw) ? '' : raw;
    }
    return DEFAULT_YTDLP_PROXY_URL;
}

function resolveYtDlpCookieBrowser() {
    if (process.env.YTDLP_COOKIE_BROWSER !== undefined) {
        const raw = process.env.YTDLP_COOKIE_BROWSER.trim();
        return isEnvDisabled(raw) ? null : raw;
    }
    // Su VPS Linux i cookie Chromium spesso danno solo immagini / niente bestaudio
    return IS_WINDOWS ? 'chromium' : null;
}

// --- PERCORSI FILE DATI ---
const PLAYLIST_FILE = path.join(ROOT_DIR, 'data', 'playlists.json');
const QUEUE_FILE = path.join(ROOT_DIR, 'data', 'queue_backup.json');
const STATS_FILE = path.join(ROOT_DIR, 'data', 'stats.json');

// --- PERCORSI BINARI ---
const YT_DLP_PATH = '/home/ubuntu/DiscordBots/DiscordMusicBot/bin/yt-dlp';  // Binario precompilato yt-dlp (ARM64 Linux)
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
function resolveYtDlpExtractorArgs() {
    const rawExtractorArgs = process.env.YTDLP_EXTRACTOR_ARGS;
    return (rawExtractorArgs && rawExtractorArgs.trim())
        ? rawExtractorArgs.trim()
        : DEFAULT_YTDLP_EXTRACTOR_ARGS;
}

function getYtDlpCommand(additionalArgs = []) {
    const proxyUrl = resolveYtDlpProxyUrl();
    const proxyArgs = proxyUrl ? ['--proxy', proxyUrl] : [];
    const cookieBrowser = resolveYtDlpCookieBrowser();
    const cookiesFromBrowserArgs = cookieBrowser
        ? ['--cookies-from-browser', cookieBrowser]
        : [];
    const extractorArgsValue = resolveYtDlpExtractorArgs();
    const extractorArgs = extractorArgsValue ? ['--extractor-args', extractorArgsValue] : [];
    const userAgentArgs = ['--user-agent', DEFAULT_YTDLP_USER_AGENT];

    return {
        cmd: PYTHON_BIN,
        args: ['-m', 'yt_dlp', ...proxyArgs, ...cookiesFromBrowserArgs, ...extractorArgs, ...userAgentArgs, ...additionalArgs]
    };
}

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
    getYtDlpCommand,
    resolveYtDlpProxyUrl,
    resolveYtDlpCookieBrowser,
    resolveYtDlpExtractorArgs,
    isEnvDisabled
};
