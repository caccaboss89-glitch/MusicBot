/**
 * Utility per richieste HTTP sensibili via proxy SOCKS.
 * Usare solo per endpoint YouTube/bloccati, non per Discord API.
 */

const { SocksProxyAgent } = require('socks-proxy-agent');

const DEFAULT_PROXY = process.platform === 'win32' ? '' : 'socks5://127.0.0.1:5040';

function getYoutubeProxyUrl() {
    const proxyUrl = (process.env.YTDLP_PROXY_URL ?? DEFAULT_PROXY).trim();
    return proxyUrl || null;
}

function getYoutubeSocksAgent() {
    const proxyUrl = getYoutubeProxyUrl();
    if (!proxyUrl) return null;

    // socks-proxy-agent si aspetta schema socks5://; per yt-dlp usiamo socks5h://.
    const normalized = proxyUrl.replace(/^socks5h:\/\//i, 'socks5://');
    return new SocksProxyAgent(normalized);
}

module.exports = {
    getYoutubeProxyUrl,
    getYoutubeSocksAgent
};
