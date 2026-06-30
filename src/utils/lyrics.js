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
 * Se il titolo non include l'artista, usa YouTube oEmbed sul link del video.
 */

const https = require('https');

const LRCLIB_HOST = 'lrclib.net';
const YOUTUBE_HOST = 'www.youtube.com';
const USER_AGENT = 'DiscordMusicBot (https://github.com/discord-music-bot)';
const REQUEST_TIMEOUT_MS = 8000;

// Cache in-memory semplice (url canzone → testo) per evitare richieste ripetute.
const _cache = new Map();
const CACHE_MAX = 200;

/**
 * GET JSON con timeout.
 * @param {string} host
 * @param {string} path
 * @returns {Promise<any|null>}
 */
function _getJson(host, path) {
    return new Promise((resolve) => {
        const req = https.get(
            {
                host,
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
 * @param {string} str
 * @returns {string}
 */
function cleanQuery(str) {
    if (!str) return '';
    return String(str)
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, ' ')
        .replace(/\b(official|video|audio|lyrics?|lyric|visualizer|hd|4k|mv|m\/v|remaster(?:ed)?)\b/gi, ' ')
        .replace(/[|•·]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Pulisce il nome artista da suffissi tipici dei canali YouTube.
 * @param {string} str
 * @returns {string}
 */
function cleanArtist(str) {
    if (!str) return '';
    return String(str)
        .replace(/\s*-\s*Topic\s*$/i, '')
        .replace(/\s*VEVO\s*$/i, '')
        .replace(/\s*Official\s*$/i, '')
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
    const m = cleaned.split(/\s[-–—]\s/);
    if (m.length >= 2) {
        return { artist: m[0].trim(), track: m.slice(1).join(' ').trim() };
    }
    return { artist: '', track: cleaned };
}

/**
 * Risolve artista e titolo affidabili per la ricerca lyrics.
 * Usa metadati locali, poi oEmbed YouTube se l'artista manca.
 *
 * @param {{title?: string, url?: string, author?: string, uploader?: string}} song
 * @returns {Promise<{artist: string, track: string}>}
 */
async function resolveTrackInfo(song) {
    let artist = '';
    let track = '';

    const fromTitle = splitArtistTrack(song.title || '');
    if (fromTitle.artist) {
        artist = fromTitle.artist;
        track = fromTitle.track;
    } else {
        track = fromTitle.track;
        artist = cleanArtist(song.author || song.uploader || '');
    }

    const needsOembed = song.url && (
        !artist ||
        artist.length < 3 ||
        artist.toLowerCase() === 'various artists'
    );

    if (needsOembed) {
        const path = `/oembed?url=${encodeURIComponent(song.url)}&format=json`;
        const oembed = await _getJson(YOUTUBE_HOST, path);
        if (oembed) {
            const oembedTitle = cleanQuery(oembed.title || '');
            const oembedArtist = cleanArtist(oembed.author_name || '');
            const fromOembedTitle = splitArtistTrack(oembed.title || '');

            if (fromOembedTitle.artist) {
                artist = fromOembedTitle.artist;
                track = fromOembedTitle.track;
            } else {
                if (oembedArtist) artist = oembedArtist;
                if (oembedTitle) track = oembedTitle;
            }
        }
    }

    return { artist: cleanArtist(artist), track: cleanQuery(track) };
}

/**
 * Estrae testo plain o synced da un record LRCLIB.
 * @param {any} record
 * @returns {string|null}
 */
function extractLyrics(record) {
    if (!record) return null;
    let lyrics = record.plainLyrics || stripSyncedTimestamps(record.syncedLyrics) || null;
    return lyrics ? lyrics.trim() || null : null;
}

/**
 * Recupera il testo di una canzone.
 * Strategia: risolvi artista/titolo → match preciso /api/get → ricerca mirata.
 * Evita ricerche solo per titolo quando manca l'artista (rischio testo sbagliato).
 *
 * @param {{title: string, url?: string, duration?: number}} song
 * @returns {Promise<string|null>}
 */
async function getLyrics(song) {
    if (!song || !song.title) return null;

    const cacheKey = song.url || song.title;
    if (_cache.has(cacheKey)) return _cache.get(cacheKey);

    const { artist, track } = await resolveTrackInfo(song);
    if (!track) return null;

    let lyrics = null;

    if (artist) {
        const exact = await _getJson(
            LRCLIB_HOST,
            `/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}`
        );
        lyrics = extractLyrics(exact);
        if (lyrics) {
            _setCache(cacheKey, lyrics);
            return lyrics;
        }

        const searchPaths = [
            `/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`,
            `/api/search?q=${encodeURIComponent(`${artist} ${track}`)}`
        ];
        for (const path of searchPaths) {
            const results = await _getJson(LRCLIB_HOST, path);
            if (!Array.isArray(results) || results.length === 0) continue;
            const best = results.find(r => r && r.plainLyrics) || results.find(r => r && r.syncedLyrics) || results[0];
            lyrics = extractLyrics(best);
            if (lyrics) break;
        }
    } else {
        // Senza artista affidabile non usiamo track_name da solo: match troppo generici.
        const results = await _getJson(LRCLIB_HOST, `/api/search?q=${encodeURIComponent(track)}`);
        if (Array.isArray(results) && results.length > 0) {
            const best = results.find(r => r && r.plainLyrics) || results.find(r => r && r.syncedLyrics) || results[0];
            lyrics = extractLyrics(best);
        }
    }

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

module.exports = { getLyrics, chunkLyrics, cleanQuery, splitArtistTrack, resolveTrackInfo };
