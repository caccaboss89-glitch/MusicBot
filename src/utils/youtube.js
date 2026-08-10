/**
 * Functions to interact with YouTube via `yt-dlp`.
 */

import { spawn } from 'child_process';
import {
  LOCAL_TEMP_DIR,
  VIDEO_DURATION_TIMEOUT_MS,
  VIDEO_INFO_TIMEOUT_MS,
  getYtDlpCommand
} from '../../config/index.js';
import { normalizeYoutubeUrl } from './sanitize.js';

const DURATION_FETCH_CONCURRENCY = 3; // Max concurrent yt-dlp processes for duration fetch

// ─── Global semaphore to limit concurrent yt-dlp processes ──────
const MAX_YTDLP_CONCURRENT = 6; // Max global yt-dlp processes (cross-guild)
let _activeProcesses = 0;
const _waitQueue = [];

function acquireSlot() {
  if (_activeProcesses < MAX_YTDLP_CONCURRENT) {
    _activeProcesses++;
    return Promise.resolve();
  }
  return new Promise(resolve => _waitQueue.push(resolve));
}

function releaseSlot() {
  _activeProcesses--;
  if (_waitQueue.length > 0 && _activeProcesses < MAX_YTDLP_CONCURRENT) {
    _activeProcesses++;
    _waitQueue.shift()();
  }
}

/**
 * Extracts only the duration of a video (fast fallback function)
 * @param {string} videoUrl - YouTube video URL
 * @returns {Promise<number>} - Duration in seconds (0 if fails)
 */
async function getVideoDuration(videoUrl) {
  await acquireSlot();
  try {
    // Normalize here too for robustness (legacy code or restore from disk)
    if (videoUrl && typeof videoUrl === 'string' && videoUrl.startsWith('http')) {
      videoUrl = normalizeYoutubeUrl(videoUrl);
    }
    return await new Promise((resolve) => {
      const ytdlpCmd = getYtDlpCommand([
        '--no-warnings',
        '--no-cache-dir',
        '--skip-download',
        '--force-ipv4',
        '--paths', `home:${LOCAL_TEMP_DIR}`,
        '-J',
        videoUrl
      ]);

      const processSearch = spawn(ytdlpCmd.cmd, ytdlpCmd.args);
      let data = '';
      let errorData = '';

      const killTimer = setTimeout(() => {
        if (!processSearch.killed) {
          console.warn(`⏱️ [DURATION] Timeout for ${videoUrl.substring(0, 50)}...`);
          processSearch.kill();
        }
      }, VIDEO_DURATION_TIMEOUT_MS);

      processSearch.stdout.on('data', chunk => { data += chunk; });
      processSearch.stderr.on('data', chunk => { errorData += chunk; });

      processSearch.on('close', (code) => {
        clearTimeout(killTimer);

        if (code !== 0 && errorData) {
          console.warn(`⚠️ [DURATION] yt-dlp exit code ${code}: ${errorData.substring(0, 200)}`);
        }

        try {
          const info = JSON.parse(data);
          const duration = info.duration || 0;
          resolve(duration);
        } catch (e) {
          console.warn(`⚠️ [DURATION] Parse error: ${e.message}`);
          resolve(0);
        }
      });

      processSearch.on('error', (e) => {
        clearTimeout(killTimer);
        console.error(`❌ [DURATION] Process spawn error: ${e.message}`);
        resolve(0);
      });
    });
  } finally { releaseSlot(); }
}

/**
 * Gets complete information about a video or playlist
 * @param {string} query - URL or search term
 * @returns {Promise<Array>} - Array of song objects
 * @throws {string} - 'TIMEOUT', 'TOO_LARGE'
 */
async function getVideoInfo(query) {
  await acquireSlot();
  try {
    // Normalize URL music.youtube.com / m.youtube.com / tracking params → canonical www.youtube.com.
    // This solves cases where yt-dlp with ANDROID_MUSIC client on a single video returns "null".
    if (query && typeof query === 'string' && query.startsWith('http')) {
      query = normalizeYoutubeUrl(query);
    }

    const baseArgs = [
      '--flat-playlist',
      '-J',
      '--no-warnings',
      '--mark-watched',
      '--no-cache-dir',
      '--no-part',
      '--force-ipv4',
      '--paths', `home:${LOCAL_TEMP_DIR}`,
      '--skip-download',
      // ⚠️ CRITICAL (single video link fix): for a single video yt-dlp performs
      // format selection; with the ANDROID_MUSIC client this often fails
      // ("Requested format is not available") and output becomes null → "No results".
      // Searches/playlists use flat extraction and don't touch formats, so
      // worked. Here we only need metadata (title, url, duration): actual download
      // and format choice happen in Rust engine. By ignoring format error we still
      // get metadata even for single videos.
      '--ignore-no-formats-error',
      '--compat-options', 'no-youtube-unavailable-videos',
      '--yes-playlist'
    ];

    if (query.startsWith('http')) baseArgs.push(query); else baseArgs.push(`ytsearch1:${query}`);

    const ytdlpCmd = getYtDlpCommand(baseArgs);

    return new Promise((resolve, reject) => {
      const processSearch = spawn(ytdlpCmd.cmd, ytdlpCmd.args);
      let data = '';
      let settled = false;

      const killTimer = setTimeout(() => {
        if (!processSearch.killed) { processSearch.kill(); if (!settled) { settled = true; reject(new Error('TIMEOUT')); } }
      }, VIDEO_INFO_TIMEOUT_MS);

      processSearch.stdout.on('data', chunk => {
        data += chunk;
        if (data.length > 50 * 1024 * 1024) {
          processSearch.kill();
          if (!settled) { settled = true; reject(new Error('TOO_LARGE')); }
        }
      });

      processSearch.on('error', (e) => {
        clearTimeout(killTimer);
        if (!settled) { settled = true; reject(e.message || 'SPAWN_ERROR'); }
      });

      processSearch.on('close', async () => {
        clearTimeout(killTimer);
        if (settled) return;
        if (!data) {
          console.warn(`[getVideoInfo] No data from yt-dlp for query: ${query.substring(0, 120)}`);
          return resolve([]);
        }
        try {
          const info = JSON.parse(data);
          if (!info || typeof info !== 'object') {
            console.warn(`[getVideoInfo] yt-dlp returned null/empty for query: ${query.substring(0, 120)}`);
            return resolve([]);
          }
          if (info.entries && info.entries.length > 0) {
            const results = info.entries.map(entry => ({
              title: entry.title || 'Titolo Sconosciuto',
              url: normalizeYoutubeUrl(entry.url || `https://www.youtube.com/watch?v=${entry.id}`),
              thumbnail: entry.thumbnails ? entry.thumbnails[0].url : 'https://i.imgur.com/AfFp7pu.png',
              isLive: entry.is_live || false,
              duration: entry.duration || 0
            }));

            // If duration is missing, fetch it with a quick query (max N at a time)
            const needsDuration = results.filter(s => !s.duration || s.duration === 0);
            for (let i = 0; i < needsDuration.length; i += DURATION_FETCH_CONCURRENCY) {
              const batch = needsDuration.slice(i, i + DURATION_FETCH_CONCURRENCY);
              await Promise.all(batch.map(async (song) => {
                try {
                  const dur = await getVideoDuration(song.url);
                  if (dur && dur > 0) song.duration = dur;
                } catch (e) {
                  // Keep duration: 0 if fails
                }
              }));
            }

            return resolve(results);
          }
          let result = {
            title: info.title || 'Titolo Sconosciuto',
            url: normalizeYoutubeUrl(info.webpage_url || info.url),
            thumbnail: info.thumbnail || 'https://i.imgur.com/AfFp7pu.png',
            isLive: info.is_live || false,
            duration: info.duration || 0
          };

          // Fallback: if root doesn't have useful video info but has entries with 1 element (e.g. unexpanded list but main video present)
          const hasUsableVideo = result.url || (result.title && result.title !== 'Unknown Title');
          if (!hasUsableVideo && Array.isArray(info.entries) && info.entries.length > 0) {
            const first = info.entries[0];
            result = {
              title: first.title || result.title,
              url: normalizeYoutubeUrl(first.url || (first.id ? `https://www.youtube.com/watch?v=${first.id}` : result.url)),
              thumbnail: (first.thumbnails && first.thumbnails[0] ? first.thumbnails[0].url : result.thumbnail),
              isLive: first.is_live || result.isLive,
              duration: first.duration || result.duration
            };
          }

          // If duration is missing for single video
          if (!result.duration || result.duration === 0) {
            try {
              const dur = await getVideoDuration(result.url);
              if (dur && dur > 0) result.duration = dur;
            } catch (e) {
              // Keep duration: 0 if fails
            }
          }

          return resolve([result]);
        } catch (e) {
          console.warn(`[getVideoInfo] Error processing yt-dlp output for "${query.substring(0, 80)}": ${e.message}`);
          console.warn(`[getVideoInfo] Raw data (first 500 chars): ${data ? data.substring(0, 500) : '(empty)'}`);
          resolve([]);
        }
      });
    });
  } finally { releaseSlot(); }
}

export {
  getVideoDuration,
  getVideoInfo
};
