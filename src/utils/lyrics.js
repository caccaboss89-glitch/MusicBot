/**
 * src/utils/lyrics.js
 * Song lyrics retrieval via LRCLIB (https://lrclib.net).
 *
 * Why LRCLIB:
 *  - 100% free, no API key, no stated rate limit
 *  - Direct REST API returning plainLyrics / syncedLyrics
 *  - Legal and designed for music bots
 *
 * Uses native `https` module (no extra dependencies). LRCLIB is
 * directly reachable: does NOT go through the SOCKS proxy used for YouTube.
 * If the title doesn't include the artist, uses YouTube oEmbed on the video link.
 */

import https from 'https';

const LRCLIB_HOST = 'lrclib.net';
const YOUTUBE_HOST = 'www.youtube.com';
const USER_AGENT = 'DiscordMusicBot (https://github.com/discord-music-bot)';
const REQUEST_TIMEOUT_MS = 8000;

// Simple in-memory cache (song url → lyrics) to avoid repeated requests.
const _cache = new Map();
const CACHE_MAX = 200;

/**
 * GET JSON with timeout.
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
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      try { req.destroy(); } catch { /* ignore */ }
      resolve(null);
    });
  });
}

/**
 * Cleans a YouTube title to improve matching on LRCLIB.
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
 * Cleans artist name from typical YouTube channel suffixes.
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
 * Tries to separate "Artist - Title" from a YouTube title.
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
 * Resolves reliable artist and title for lyrics search.
 * Uses local metadata first, then YouTube oEmbed if artist is missing.
 *
 * @param {{title?: string, url?: string, author?: string, uploader?: string}} song
 * @returns {Promise<{artist: string, track: string}>}
 */
async function resolveTrackInfo(song) {
  const fromTitle = splitArtistTrack(song.title || '');
  let track = fromTitle.track;
  let artist = fromTitle.artist || cleanArtist(song.author || song.uploader || '');

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
 * Extracts plain or synced lyrics from an LRCLIB record.
 * @param {any} record
 * @returns {string|null}
 */
function extractLyrics(record) {
  if (!record) return null;
  const lyrics = record.plainLyrics || stripSyncedTimestamps(record.syncedLyrics) || null;
  return lyrics ? lyrics.trim() || null : null;
}

/**
 * Retrieves song lyrics.
 * Strategy: resolve artist/title → exact match /api/get → targeted search.
 * Avoids title-only searches when artist is missing (risk of wrong lyrics).
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
    // Without reliable artist, don't use track_name alone: matches too generic.
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
 * Removes timestamps [mm:ss.xx] from synced LRC lyrics.
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
 * Breaks a long text into chunks <= maxLen characters, respecting line breaks.
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

export { getLyrics, chunkLyrics, cleanQuery, splitArtistTrack, resolveTrackInfo };
