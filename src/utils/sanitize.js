/**
 * Utility functions for parsing and sanitization
 */

import fs from 'fs';

/**
 * Safe integer parsing with default value
 * @param {any} value - Value to parse
 * @param {number} defaultValue - Default value if parsing fails
 * @returns {number} - Integer >= 0
 */
export function safeParseInt(value, defaultValue = 0) {
  const parsed = parseInt(value);
  return isNaN(parsed) ? defaultValue : Math.max(0, parsed);
}

/**
 * Sanitizes the title for MASKED LINK contexts `[title](url)` (e.g., playlist lists),
 * where Discord interprets markdown INSIDE the link label.
 *
 * The real problem seen in production: a title like "I'M DAT N**" contains `**`
 * which, inside `**[...]**` or `[...]`, collides with bold markdown and BREAKS the link
 * (no longer clickable, raw syntax leaks out). In the past we used the escape `\*`
 * but it appeared LITERALLY. Solution: no backslash, replace the asterisk
 * with an almost identical character (U+2217 ASTERISK OPERATOR) that is NOT markdown. Result:
 * link always clickable, title visually faithful, zero backslash.
 *
 * @param {string} title - Original title
 * @returns {string} - Safe title for masked link
 */
export function sanitizeTitle(title) {
  if (!title) return 'Unknown Title';
  const cleaned = String(title)
    .replace(/\[/g, '(')   // brackets would break [text](url) syntax
    .replace(/\]/g, ')')
    .replace(/\*/g, '∗')   // U+2217: avoids accidental bold/italic without visible backslash
    .replace(/\r?\n/g, ' ') // no line breaks in description
    .trim();
  return cleaned || 'Unknown Title';
}

/**
 * Title for `EmbedBuilder.setTitle()`. Discord does NOT interpret markdown in embed titles:
 * we can show the title COMPLETELY RAW (including `**`, `_`, `~`...),
 * clickable via setURL(). We only remove line breaks and respect the 256 limit.
 *
 * @param {string} title - Original title
 * @returns {string}
 */
export function displayTitle(title) {
  if (!title) return 'Unknown Title';
  const cleaned = String(title).replace(/\r?\n/g, ' ').trim();
  if (!cleaned) return 'Unknown Title';
  return cleaned.length > 256 ? cleaned.slice(0, 255) + '…' : cleaned;
}

/**
 * Safe JSON file parsing with creation if doesn't exist
 * @param {string} filename - Path to JSON file
 * @param {any} defaultData - Default data if file doesn't exist or is corrupted
 * @returns {any} - Parsed data or default
 */
export function safeJSONParse(filename, defaultData) {
  if (!fs.existsSync(filename)) {
    try {
      fs.writeFileSync(filename, JSON.stringify(defaultData, null, 2));
    } catch { }
    return defaultData;
  }
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf-8'));
  } catch {
    // Corrupted file: save backup before overwriting
    try {
      fs.copyFileSync(filename, filename + '.corrupted.bak');
      console.warn(`⚠️ [SANITIZE] Corrupted file: ${filename} — backup saved as ${filename}.corrupted.bak`);
    } catch { /* ignore */ }
    try { fs.writeFileSync(filename, JSON.stringify(defaultData, null, 2)); } catch { /* ignore */ }
    return defaultData;
  }
}

/**
 * Extracts video ID from a YouTube URL
 * @param {string} url - YouTube URL
 * @returns {string|null} - Video ID or null
 */
export function getYoutubeId(url) {
  if (!url) return null;
  const match = url.match(/^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/);
  return (match && match[1]) ? match[1] : null;
}

/**
 * Normalize a YouTube (or YouTube Music) URL to canonical www.youtube.com form
 * - Converts music.youtube.com → www.youtube.com
 * - Removes tracking parameters (si, pp, feature, etc.)
 * - Preserves list= and index= when present (useful for mix/playlist context)
 * - Handles youtu.be, /embed/, /shorts/, /v/ etc.
 * @param {string} url
 * @returns {string}
 */
export function normalizeYoutubeUrl(url) {
  if (!url || typeof url !== 'string') return url;
  let u = url.trim();

  // 1. Convert music.youtube and m.youtube domains to www.youtube
  u = u.replace(/^https?:\/\/(?:music|m)\.youtube\.com\//i, 'https://www.youtube.com/');

  // 2. Try URL parsing for precise query param cleanup
  try {
    const parsed = new URL(u);
    if (parsed.hostname.endsWith('youtube.com') || parsed.hostname === 'youtu.be') {
      const v = parsed.searchParams.get('v');
      const list = parsed.searchParams.get('list');
      const index = parsed.searchParams.get('index');

      if (parsed.hostname === 'youtu.be' && parsed.pathname.length > 1) {
        const id = parsed.pathname.slice(1).split(/[?#]/)[0];
        const outUrl = new URL('https://www.youtube.com/watch');
        outUrl.searchParams.set('v', id);
        if (list) outUrl.searchParams.set('list', list);
        if (index && list) outUrl.searchParams.set('index', index);
        return outUrl.toString();
      }

      if (parsed.pathname.includes('/playlist')) {
        const qs = list ? `?list=${list}` : '';
        return `https://www.youtube.com${parsed.pathname}${qs}`;
      }

      if (v) {
        const outUrl = new URL('https://www.youtube.com/watch');
        outUrl.searchParams.set('v', v);
        if (list) outUrl.searchParams.set('list', list);
        if (index && list) outUrl.searchParams.set('index', index);
        return outUrl.toString();
      }

      if (list) {
        return `https://www.youtube.com/playlist?list=${list}`;
      }

      // Not a recognizable single video, return with normalized domain
      return u.replace(/^https?:\/\/[^/]+/, 'https://www.youtube.com');
    }
  } catch {
    // Simple regex fallback
  }

  // Regex-based fallback (for malformed URLs or edge cases)
  const idMatch = u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|playlist\?list=))([a-zA-Z0-9_-]{11,})/);
  if (idMatch && idMatch[1] && idMatch[1].length === 11) {
    // If there is list= in the original query, try to preserve it
    const listMatch = u.match(/[?&]list=([A-Za-z0-9_-]+)/);
    if (listMatch) {
      return `https://www.youtube.com/watch?v=${idMatch[1]}&list=${listMatch[1]}`;
    }
    return `https://www.youtube.com/watch?v=${idMatch[1]}`;
  }

  return u;
}

/**
 * Compares two URLs to check if they point to the same song
 * @param {string} url1 - First URL
 * @param {string} url2 - Second URL
 * @returns {boolean} - true if they are the same song
 */
export function areSameSong(url1, url2) {
  if (url1 === url2) return true;
  const id1 = getYoutubeId(url1);
  const id2 = getYoutubeId(url2);
  if (id1 && id2 && id1.length >= 11 && id2.length >= 11) return id1 === id2;
  return false;
}
