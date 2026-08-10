/**
 * Utility for sensitive HTTP requests via SOCKS proxy.
 * Use only for YouTube/blocked endpoints, not for Discord API.
 */

import { SocksProxyAgent } from 'socks-proxy-agent.js';

const DEFAULT_PROXY = process.platform === 'win32' ? '' : 'socks5://127.0.0.1:5040';

function isEnvDisabled(value) {
  if (!value || !String(value).trim()) return true;
  const v = String(value).trim().toLowerCase();
  return v === 'none' || v === 'off' || v === 'false' || v === '0' || v === 'no';
}

function getYoutubeProxyUrl() {
  const raw = process.env.YTDLP_PROXY_URL !== undefined
    ? process.env.YTDLP_PROXY_URL
    : DEFAULT_PROXY;
  const proxyUrl = String(raw).trim();
  if (isEnvDisabled(proxyUrl)) return null;
  return proxyUrl || null;
}

function getYoutubeSocksAgent() {
  const proxyUrl = getYoutubeProxyUrl();
  if (!proxyUrl) return null;

  // socks-proxy-agent uses socks5:// schema; yt-dlp requires socks5h://.
  const normalized = proxyUrl.replace(/^socks5h:\/\//i, 'socks5://');
  return new SocksProxyAgent(normalized);
}

export {
  getYoutubeProxyUrl,
  getYoutubeSocksAgent
};
