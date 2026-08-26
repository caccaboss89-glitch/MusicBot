/**
 * Centralized bot path configuration
 * All paths are relative to project root
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root (one directory above config/)
export const ROOT_DIR = path.join(__dirname, '..');
export const IS_WINDOWS = process.platform === 'win32';
export const PYTHON_BIN = process.env.PYTHON_BIN || (IS_WINDOWS ? 'python' : 'python3');
export const DEFAULT_YTDLP_EXTRACTOR_ARGS = 'youtube:player_client=web,android,ios,mweb';
export const DEFAULT_YTDLP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function isEnvDisabled(value) {
  if (!value || !String(value).trim()) return true;
  const v = String(value).trim().toLowerCase();
  return v === 'none' || v === 'off' || v === 'false' || v === '0' || v === 'no';
}

/**
 * Proxy for yt-dlp. There is NO default: the bot runs on a residential
 * connection and talks to YouTube directly. Set YTDLP_PROXY_URL only if that
 * ever has to change again (VPN, tunnel, another network).
 * @returns {string} Proxy URL, or '' when no proxy must be used
 */
export function resolveYtDlpProxyUrl() {
  const raw = process.env.YTDLP_PROXY_URL;
  if (raw === undefined) return '';
  return isEnvDisabled(raw) ? '' : raw.trim();
}

export function resolveYtDlpCookieBrowser() {
  if (process.env.YTDLP_COOKIE_BROWSER !== undefined) {
    const raw = process.env.YTDLP_COOKIE_BROWSER.trim();
    return isEnvDisabled(raw) ? null : raw;
  }
  // On Linux servers, Chromium cookies often give only images / no bestaudio
  return IS_WINDOWS ? 'chromium' : null;
}

// --- DATA FILE PATHS ---
export const PLAYLIST_FILE = path.join(ROOT_DIR, 'data', 'playlists.json');
export const QUEUE_FILE = path.join(ROOT_DIR, 'data', 'queue_backup.json');
export const STATS_FILE = path.join(ROOT_DIR, 'data', 'stats.json');

// --- BINARY PATHS ---
export const RUST_ENGINE_FILENAME = IS_WINDOWS ? 'discord_audio_mixer.exe' : 'discord_audio_mixer';
export const RUST_ENGINE_PATH = path.join(ROOT_DIR, 'audio_engine', 'target', 'release', RUST_ENGINE_FILENAME);

// --- DIRECTORY PATHS ---
export const LOCAL_TEMP_DIR = path.join(ROOT_DIR, 'temp');
export const DATA_DIR = path.join(ROOT_DIR, 'data');

// --- YT-DLP UTILITY FUNCTIONS ---
/**
 * Extractor arguments to pass to yt-dlp, overridable via YTDLP_EXTRACTOR_ARGS.
 * @returns {string}
 */
export function resolveYtDlpExtractorArgs() {
  const rawExtractorArgs = process.env.YTDLP_EXTRACTOR_ARGS;
  return (rawExtractorArgs && rawExtractorArgs.trim())
    ? rawExtractorArgs.trim()
    : DEFAULT_YTDLP_EXTRACTOR_ARGS;
}

/**
 * Builds the command line that runs yt-dlp through the Python module, applying
 * the configured proxy, browser cookies, extractor args and user agent.
 * @param {string[]} [additionalArgs=[]] - Arguments appended after the configured ones
 * @returns {{cmd: string, args: string[]}}
 */
export function getYtDlpCommand(additionalArgs = []) {
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
