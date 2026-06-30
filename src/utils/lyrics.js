/**
 * src/utils/lyrics.js
 * Recupero testi canzoni tramite LRCLIB (https://lrclib.net).
 *
 * Perché LRCLIB:
 *  - 100% gratuito, nessuna API key, nessun rate limit dichiarato
 *  - API REST diretta che restituisce plainLyrics / syncedLyrics
 *  - Legale e pensata proprio per i music bot (vedi guide.txt.temp)
 *
 * Usa il modulo nativo `https` (nessuna dipendenza extra). LRCLIB è
 * raggiungibile direttamente: NON passa dal proxy SOCKS usato per YouTube.
 */

const https = require('https');

const LRCLIB_HOST = 'lrclib.net';
const USER_AGENT = 'DiscordMusicBot (https://github.com/discord-music-bot)';
const REQUEST_TIMEOUT_MS = 8000;

// Cache in-memory semplice (url canzone → testo) per evitare richieste ripetute.
const _cache = new Map();
const CACHE_MAX = 200;

/**
 * GET JSON da LRCLIB con timeout.
 * @param {string} path - path completo con query string
 * @returns {Promise<any|null>}
 */
function _getJson(path) {
    return new Promise((resolve) => {
        const req = https.get(
            {
                host: LRCLIB_HOST,
                path,
                headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
            },
            (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    res.resume();
                    return resolve(null);
                }
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                });
            }
        );
        req.on('error', () => resolve(null));
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            try { req.destroy(); } catch (e) { /* ignore */ }
            resolve(null);
        });
    });
}

/**
 * Pulisce un titolo YouTube per migliorare il match su LRCLIB.
 * Rimuove "(Official Video)", "[Lyrics]", "feat.", tag come HD/4K/Audio, ecc.
 * @param {string} str
 * @returns {string}
 */
function cleanQuery(str) {
    if (!str) return '';
    return String(str)
        .replace(/\([^)]*\)/g, ' ')              // (Official Video), (Audio)...
        .replace(/\[[^\]]*\]/g, ' ')             // [Lyrics], [4K]...
        .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, ' ') // feat. X...
        .replace(/\b(official|video|audio|lyrics?|lyric|visualizer|hd|4k|mv|m\/v|remaster(?:ed)?)\b/gi, ' ')
        .replace(/[|•·]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Prova a separare "Artista - Titolo" da un titolo YouTube.
 * @param {string} fullTitle
 * @returns {{artist: string, track: string}}
 */
function splitArtistTrack(fullTitle) {
    const cleaned = cleanQuery(fullTitle);
    // Separatori comuni: " - ", " – ", " — "
    const m = cleaned.split(/\s[-–—]\s/);
    if (m.length >= 2) {
        return { artist: m[0].trim(), track: m.slice(1).join(' ').trim() };
    }
    return { artist: '', track: cleaned };
}

/**
 * Recupera il testo di una canzone.
 * Strategia: prima /api/search con artista+traccia, poi solo traccia.
 * Restituisce plainLyrics (preferito) o, in mancanza, syncedLyrics ripulito.
 *
 * @param {{title: string, duration?: number}} song
 * @returns {Promise<string|null>}
 */
async function getLyrics(song) {
    if (!song || !song.title) return null;

    const cacheKey = song.url || song.title;
    if (_cache.has(cacheKey)) return _cache.get(cacheKey);

    const { artist, track } = splitArtistTrack(song.title);
    if (!track) return null;

    const attempts = [];
    if (artist) {
        attempts.push(`/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`);
    }
    attempts.push(`/api/search?q=${encodeURIComponent(track + (artist ? ' ' + artist : ''))}`);
    attempts.push(`/api/search?track_name=${encodeURIComponent(track)}`);

    let best = null;
    for (const path of attempts) {
        const results = await _getJson(path);
        if (Array.isArray(results) && results.length > 0) {
            // Preferisci un risultato con plainLyrics
            best = results.find(r => r && r.plainLyrics) || results.find(r => r && r.syncedLyrics) || results[0];
            if (best) break;
        }
    }

    if (!best) {
        _setCache(cacheKey, null);
        return null;
    }

    let lyrics = best.plainLyrics || stripSyncedTimestamps(best.syncedLyrics) || null;
    if (lyrics) lyrics = lyrics.trim() || null;

    _setCache(cacheKey, lyrics);
    return lyrics;
}

/**
 * Rimuove i timestamp [mm:ss.xx] dai testi sincronizzati LRC.
 * @param {string|null} synced
 * @returns {string|null}
 */
function stripSyncedTimestamps(synced) {
    if (!synced) return null;
    return synced.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim() || null;
}

function _setCache(key, value) {
    if (_cache.size >= CACHE_MAX) {
        const firstKey = _cache.keys().next().value;
        _cache.delete(firstKey);
    }
    _cache.set(key, value);
}

/**
 * Spezza un testo lungo in chunk <= maxLen caratteri, rispettando le righe.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
function chunkLyrics(text, maxLen = 1900) {
    const chunks = [];
    let current = '';
    for (const line of String(text).split('\n')) {
        if ((current + line + '\n').length > maxLen) {
            if (current) chunks.push(current);
            // Se una singola riga è enorme, spezzala duramente
            if (line.length > maxLen) {
                for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
                current = '';
            } else {
                current = line + '\n';
            }
        } else {
            current += line + '\n';
        }
    }
    if (current.trim()) chunks.push(current);
    return chunks.length > 0 ? chunks : [String(text)];
}

module.exports = { getLyrics, chunkLyrics, cleanQuery, splitArtistTrack };
