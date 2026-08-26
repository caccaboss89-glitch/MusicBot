/**
 * src/utils/logfiles.js
 *
 * Size limits for the log files the bot writes itself.
 *
 * Nothing here used to have a ceiling: the crash log, the two fatal-error logs
 * and one mixer log per guild all grew forever. On an unbranded NVMe that is a
 * disk-space problem and a wear problem, and neither shows up until the disk is
 * already full. PM2 rotates its own stdout/stderr, so this covers only what the
 * code opens directly.
 *
 * The scheme is deliberately the simplest one that bounds the total: when a file
 * passes its limit it becomes `<name>.1` (replacing the previous `.1`) and a new
 * file starts. Two generations, so the most recent history survives a rotation
 * while the worst case stays at twice the limit per file.
 */

import fs from 'fs';
import path from 'path';

/** Fatal-error and crash logs: small, append-only, read by hand after an incident. */
export const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;

/** Per-guild mixer logs: chattier, so they get more room. */
export const MAX_MIXER_LOG_BYTES = 2 * 1024 * 1024;

/** Temp files older than this are removed by cleanupTempDir(). */
export const TEMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rotates `filePath` if it has grown past `maxBytes`.
 * Never throws: a failure to rotate must not stop the caller from logging.
 * @param {string} filePath
 * @param {number} [maxBytes=DEFAULT_MAX_LOG_BYTES]
 * @returns {boolean} true if the file was rotated
 */
export function rotateIfNeeded(filePath, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  try {
    const { size } = fs.statSync(filePath);
    if (size < maxBytes) return false;
    fs.renameSync(filePath, `${filePath}.1`); // Overwrites the previous generation
    return true;
  } catch {
    // Missing file (nothing to rotate) or a rename we are not allowed to do
    return false;
  }
}

/**
 * Appends a line to a log file, rotating it first when it is too big and
 * creating the directory if needed. Never throws: logging must never be the
 * reason an error handler fails.
 * @param {string} filePath
 * @param {string} text - Written as-is, so the caller owns the trailing newline
 * @param {number} [maxBytes=DEFAULT_MAX_LOG_BYTES]
 */
export function appendCapped(filePath, text, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    rotateIfNeeded(filePath, maxBytes);
    fs.appendFileSync(filePath, text);
  } catch { /* diagnostics only: never let logging break the caller */ }
}

/**
 * Deletes files in a directory that have not been touched for `maxAgeMs`.
 *
 * Age is what makes this safe to run while the bot is working: a log the mixer
 * still writes to, or a file yt-dlp is still filling, has a recent mtime and is
 * never a candidate. Sub-directories are left alone.
 * @param {string} dirPath
 * @param {number} [maxAgeMs=TEMP_MAX_AGE_MS]
 * @returns {number} How many files were removed
 */
export function cleanupOldFiles(dirPath, maxAgeMs = TEMP_MAX_AGE_MS) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0; // Directory does not exist yet: nothing to clean
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dirPath, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs >= cutoff) continue;
      fs.unlinkSync(filePath);
      removed++;
    } catch { /* in use or already gone: it will be picked up next sweep */ }
  }

  if (removed > 0) console.log(`🧹 [TEMP] Removed ${removed} file(s) older than ${Math.round(maxAgeMs / 86400000)} days from ${dirPath}`);
  return removed;
}
