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
import { UNKNOWN_TITLE } from '../ui/messages.js';

const DURATION_FETCH_CONCURRENCY = 3;  // Duration lookups started at the same time
const MAX_YTDLP_CONCURRENT = 6;        // Max global yt-dlp processes (cross-guild)
// yt-dlp output is accumulated as a string and then parsed, so this is the
// single biggest allocation the bot makes. 16 MB of --flat-playlist JSON is
// already several times MAX_QUEUE_SIZE worth of songs, so anything larger
// would be turned away by the queue limit anyway.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 8 * 1024;     // Keep only the tail we would ever log
// A process that ignores the kill signal would leave runYtDlp() pending for
// good, and with it the semaphore slot it holds.
const KILL_ESCALATION_MS = 5000;
// Ceiling on the per-request duration backfill. Each lookup is its own yt-dlp
// run, so a playlist with hundreds of entries missing a duration could keep a
// command waiting far longer than its interaction stays valid.
const MAX_DURATION_LOOKUPS = 60;

const FALLBACK_THUMBNAIL = 'https://i.imgur.com/AfFp7pu.png';

// ─── Global semaphore to limit concurrent yt-dlp processes ──────
// IMPORTANT: a task holding a slot must never wait for another slot, or a full
// semaphore deadlocks. Everything that needs one acquires it through withSlot()
// for the duration of a single yt-dlp process, and never nests two of them.
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
  if (_waitQueue.length > 0) {
    // Hand the slot straight over instead of releasing and re-counting it
    _waitQueue.shift()();
    return;
  }
  _activeProcesses--;
}

/**
 * Runs `task` while holding one yt-dlp slot.
 * @param {() => Promise<any>} task
 * @returns {Promise<any>}
 */
async function withSlot(task) {
  await acquireSlot();
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

/**
 * Spawns yt-dlp and resolves its stdout once the process exits.
 * Always drains stderr: an unread pipe fills up and blocks the child process.
 * @param {string[]} args - Arguments for yt-dlp
 * @param {number} timeoutMs - Kill the process after this long
 * @param {string} label - Log prefix
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, timedOut: boolean, tooLarge: boolean}>}
 */
function runYtDlp(args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const { cmd, args: fullArgs } = getYtDlpCommand(args);
    const child = spawn(cmd, fullArgs);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let tooLarge = false;

    // Escalated to SIGKILL if the process is still around: 'close' is the only
    // thing that settles this promise, so a child that survives its kill would
    // hold a semaphore slot for the life of the bot.
    let killEscalation = null;
    const killChild = () => {
      try { child.kill(); } catch { /* already gone */ }
      if (killEscalation) return;
      killEscalation = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, KILL_ESCALATION_MS);
      killEscalation.unref?.();
    };

    const clearTimers = () => {
      clearTimeout(killTimer);
      if (killEscalation) clearTimeout(killEscalation);
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) {
        tooLarge = true;
        killChild();
      }
    });

    // Consumed and capped: we only ever report the tail on failure
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    child.on('error', (e) => {
      clearTimers();
      console.error(`❌ [${label}] Process spawn error: ${e.message}`);
      reject(e);
    });

    child.on('close', (code) => {
      clearTimers();
      resolve({ stdout, stderr, code, timedOut, tooLarge });
    });
  });
}

/**
 * Extracts only the duration of a video (fast fallback function)
 * @param {string} videoUrl - YouTube video URL
 * @returns {Promise<number>} - Duration in seconds (0 if it fails)
 */
async function getVideoDuration(videoUrl) {
  if (typeof videoUrl !== 'string' || !videoUrl.trim()) return 0;
  const url = videoUrl.startsWith('http') ? normalizeYoutubeUrl(videoUrl) : videoUrl;

  return withSlot(async () => {
    let result;
    try {
      result = await runYtDlp([
        '--no-warnings',
        '--no-cache-dir',
        '--skip-download',
        '--force-ipv4',
        '--paths', `home:${LOCAL_TEMP_DIR}`,
        '-J',
        url
      ], VIDEO_DURATION_TIMEOUT_MS, 'DURATION');
    } catch {
      return 0;
    }

    if (result.timedOut) {
      console.warn(`⏱️ [DURATION] Timeout for ${url.substring(0, 50)}...`);
      return 0;
    }
    if (result.code !== 0 && result.stderr) {
      console.warn(`⚠️ [DURATION] yt-dlp exit code ${result.code}: ${result.stderr.substring(0, 200)}`);
    }

    try {
      return JSON.parse(result.stdout).duration || 0;
    } catch (e) {
      console.warn(`⚠️ [DURATION] Parse error: ${e.message}`);
      return 0;
    }
  });
}

/**
 * Fills in the duration of the songs missing one, a few at a time.
 * Runs OUTSIDE the caller's semaphore slot so the lookups cannot deadlock
 * against the request that produced them.
 *
 * Capped at MAX_DURATION_LOOKUPS: a flat playlist normally comes back with
 * durations already filled in, and when it does not, spawning one yt-dlp run
 * per entry would keep the caller waiting minutes. Songs left without a
 * duration are still queueable — the audio engine has its own ceiling.
 * @param {Array<{url: string, duration: number}>} songs - Mutated in place
 */
async function enrichMissingDurations(songs) {
  const missing = songs.filter(s => !s.duration);
  const pending = missing.slice(0, MAX_DURATION_LOOKUPS);
  if (missing.length > pending.length) {
    console.warn(`⚠️ [DURATION] ${missing.length} songs without duration, looking up only the first ${pending.length}`);
  }
  for (let i = 0; i < pending.length; i += DURATION_FETCH_CONCURRENCY) {
    const batch = pending.slice(i, i + DURATION_FETCH_CONCURRENCY);
    await Promise.all(batch.map(async (song) => {
      const duration = await getVideoDuration(song.url);
      if (duration > 0) song.duration = duration;
    }));
  }
}

/**
 * Maps a yt-dlp entry (playlist/search result) to a queue song.
 * @param {object} entry
 * @returns {{title: string, url: string, thumbnail: string, isLive: boolean, duration: number}}
 */
function toSong(entry) {
  return {
    title: entry.title || UNKNOWN_TITLE,
    url: normalizeYoutubeUrl(entry.webpage_url || entry.url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : '')),
    thumbnail: entry.thumbnails?.[0]?.url || entry.thumbnail || FALLBACK_THUMBNAIL,
    isLive: entry.is_live || false,
    duration: entry.duration || 0
  };
}

/**
 * Gets complete information about a video, playlist or search term.
 * @param {string} query - URL or search term
 * @returns {Promise<Array>} - Array of song objects (empty if nothing usable was found)
 * @throws {Error} - 'TIMEOUT' or 'TOO_LARGE' when yt-dlp had to be killed
 */
async function getVideoInfo(query) {
  if (typeof query !== 'string' || !query.trim()) return [];

  // Normalize URL music.youtube.com / m.youtube.com / tracking params → canonical www.youtube.com.
  // This solves cases where yt-dlp with the ANDROID_MUSIC client on a single video returns "null".
  const target = query.startsWith('http') ? normalizeYoutubeUrl(query.trim()) : query.trim();

  const songs = await withSlot(async () => {
    const result = await runYtDlp([
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
      // Searches/playlists use flat extraction and don't touch formats, so they
      // worked. Here we only need metadata (title, url, duration): the actual
      // download and format choice happen in the Rust engine. By ignoring the
      // format error we still get metadata even for single videos.
      '--ignore-no-formats-error',
      '--compat-options', 'no-youtube-unavailable-videos',
      '--yes-playlist',
      target.startsWith('http') ? target : `ytsearch1:${target}`
    ], VIDEO_INFO_TIMEOUT_MS, 'YT-INFO');

    if (result.timedOut) throw new Error('TIMEOUT');
    if (result.tooLarge) throw new Error('TOO_LARGE');

    if (!result.stdout) {
      console.warn(`[getVideoInfo] No data from yt-dlp for query: ${target.substring(0, 120)}`);
      if (result.stderr) console.warn(`[getVideoInfo] stderr: ${result.stderr.substring(0, 300)}`);
      return [];
    }

    let info;
    try {
      info = JSON.parse(result.stdout);
    } catch (e) {
      console.warn(`[getVideoInfo] Unparsable yt-dlp output for "${target.substring(0, 80)}": ${e.message}`);
      console.warn(`[getVideoInfo] Raw data (first 500 chars): ${result.stdout.substring(0, 500)}`);
      return [];
    }

    if (!info || typeof info !== 'object') {
      console.warn(`[getVideoInfo] yt-dlp returned null/empty for query: ${target.substring(0, 120)}`);
      return [];
    }

    // Playlist or search results
    if (Array.isArray(info.entries) && info.entries.length > 0) {
      return info.entries.map(toSong).filter(s => s.url);
    }

    // Single video
    const song = toSong(info);
    return song.url ? [song] : [];
  });

  await enrichMissingDurations(songs);
  return songs;
}

// getVideoDuration only backfills durations for getVideoInfo: internal on purpose.
export { getVideoInfo };
