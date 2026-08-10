#!/usr/bin/env node
/**
 * Script to version stats.json, playlists.json and data/monthly-stats/ on GitHub.
 * Monthly flow (e.g., July 1): GitHub push (stats+playlists+archive) → local archiving → reset stats.json
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATS_FILE = path.join(PROJECT_ROOT, 'data', 'stats.json');
const PLAYLIST_FILE = path.join(PROJECT_ROOT, 'data', 'playlists.json');
const MONTHLY_STATS_DIR = path.join(PROJECT_ROOT, 'data', 'monthly-stats');
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'MusicBot';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'bot@musicbot.local';
const ROME_TZ = 'Europe/Rome';
const GIT_DATA_FILES = ['data/stats.json', 'data/playlists.json'];

function getRomeCalendarParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ROME_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, parseInt(p.value, 10)])
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** Closed month to archive relative to Rome calendar (e.g., July 1 → June). */
function getClosedMonthArchivePaths(now = new Date()) {
  const { year, month } = getRomeCalendarParts(now);
  let archiveYear = year;
  let archiveMonth = month - 1;
  if (archiveMonth < 1) {
    archiveMonth = 12;
    archiveYear -= 1;
  }
  const lastDay = new Date(Date.UTC(archiveYear, archiveMonth, 0)).getUTCDate();
  const yearMonth = `${archiveYear}-${String(archiveMonth).padStart(2, '0')}`;
  const dateStr = `${yearMonth}-${String(lastDay).padStart(2, '0')}`;
  return { yearMonth, dateStr, backupFileName: `stats-${dateStr}.json` };
}

/** Italian label for closed month (e.g., July 1 → "June 2026"). */
function getClosedMonthLabel(now = new Date()) {
  const { yearMonth } = getClosedMonthArchivePaths(now);
  const [year, month] = yearMonth.split('-').map(Number);
  const labelDate = new Date(Date.UTC(year, month - 1, 15, 12, 0, 0));
  return labelDate.toLocaleString('it-IT', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function getGitDataPaths() {
  const paths = [...GIT_DATA_FILES];
  if (fs.existsSync(MONTHLY_STATS_DIR)) {
    paths.push('data/monthly-stats');
  }
  return paths;
}

function shouldArchiveMonthlyStats(now = new Date()) {
  return getRomeCalendarParts(now).day === 1;
}

async function flushDataToDisk() {
  try {
    const playlistsModule = await import('../src/database/playlists.js');
    playlistsModule.flushDatabaseSync();
    console.log('💾 Playlist flush to disk completed');
  } catch (e) {
    console.warn('⚠️ Playlist flush failed:', e.message);
  }
}

/**
 * Commits and pushes stats.json, playlists.json and monthly-stats/ to GitHub.
 * @returns {boolean} false only if push fails
 */
function gitPushDataFiles(commitMsg) {
  const gitPaths = getGitDataPaths();
  const gitPathsArg = gitPaths.join(' ');
  execSync(`git add --force ${gitPathsArg}`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });

  const status = execSync(`git status --porcelain ${gitPathsArg}`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });

  if (!status.trim()) {
    console.log('ℹ️ No changes in stats.json / playlists.json / monthly-stats to sync to GitHub');
    return true;
  }

  console.log('📝 Files to be committed:');
  console.log(status);

  execSync(`git commit -m "${commitMsg}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  console.log('✅ Commit created successfully');

  try {
    execSync('git push origin HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    console.log('✅ stats.json, playlists.json and monthly-stats pushed to GitHub');
  } catch {
    console.warn('⚠️ [STATS-PUSH] Non-fast-forward push; executing git pull --rebase and retrying...');
    try {
      execSync('git pull --rebase origin main', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
      execSync('git push origin HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
      console.log('✅ Push successful after rebase');
    } catch (e) {
      console.error('❌ [STATS-PUSH] Push failed:', e.message);
      return false;
    }
  }

  return true;
}

/**
 * True when the closed month has already been archived.
 * The rollover is allowed for the whole 1st of the month, so without this check
 * a second run of the day would archive the freshly reset stats.json over the
 * real snapshot and reset the new month's data again.
 */
function isClosedMonthAlreadyArchived(now = new Date()) {
  const { yearMonth, backupFileName } = getClosedMonthArchivePaths(now);
  const backupFilePath = path.join(MONTHLY_STATS_DIR, yearMonth, backupFileName);
  return fs.existsSync(backupFilePath);
}

/** Copies stats.json to monthly-stats/ (local; GitHub push happens before rollover). */
async function archiveMonthlyStats() {
  try {
    const statsContent = fs.readFileSync(STATS_FILE, 'utf-8');
    const statsData = JSON.parse(statsContent);

    try {
      const statsModule = await import('../src/database/stats.js');
      statsModule.computeTopSongs(statsData, 5);
      console.log('🏆 Top songs calculated for local backup');
    } catch (e) {
      console.warn('⚠️ Error calculating top songs:', e.message);
    }

    const { yearMonth, backupFileName } = getClosedMonthArchivePaths();
    const monthDir = path.join(MONTHLY_STATS_DIR, yearMonth);
    if (!fs.existsSync(monthDir)) {
      fs.mkdirSync(monthDir, { recursive: true });
      console.log(`📁 Created directory: ${monthDir}`);
    }

    const backupFilePath = path.join(monthDir, backupFileName);
    fs.writeFileSync(backupFilePath, JSON.stringify(statsData, null, 2), 'utf-8');
    console.log(`📊 Local archive: ${backupFilePath}`);

    return { success: true, backupFilePath };
  } catch (e) {
    console.error('❌ Error archiving monthly stats:', e.message);
    return { success: false, error: e.message };
  }
}

function resetStatsFile() {
  try {
    const emptyStats = {
      users: {},
      global: { songsStarted: 0, songsCompleted: 0, songPlays: {} }
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(emptyStats, null, 2), 'utf-8');
    console.log('🧹 stats.json reset for new month');
    return true;
  } catch (e) {
    console.error('❌ Error resetting stats file:', e.message);
    return false;
  }
}

async function pushStats(forceArchive = false) {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      console.log('❌ Stats file not found:', STATS_FILE);
      return false;
    }

    if (!fs.existsSync(PLAYLIST_FILE)) {
      console.log('❌ Playlist file not found:', PLAYLIST_FILE);
      return false;
    }

    // The closed month is archived (and stats.json reset) exactly once: any later
    // run of the same day only syncs the new month's data to GitHub.
    const alreadyArchived = isClosedMonthAlreadyArchived();
    const shouldArchive = (forceArchive || shouldArchiveMonthlyStats()) && !alreadyArchived;
    if (alreadyArchived && (forceArchive || shouldArchiveMonthlyStats())) {
      const { yearMonth } = getClosedMonthArchivePaths();
      console.log(`ℹ️ Closed month ${yearMonth} already archived, skipping archiving and reset`);
    }

    try {
      execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
      execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    } catch (e) {
      console.warn('⚠️ Git config may be already set:', e.message);
    }

    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    if (currentBranch !== 'main') {
      console.warn(`⚠️ Current branch: ${currentBranch} (not 'main'), will proceed anyway`);
    }

    await flushDataToDisk();

    const monthYear = new Date().toLocaleString('it-IT', { month: 'long', year: 'numeric', timeZone: ROME_TZ });
    const closedMonthLabel = getClosedMonthLabel();
    const commitMsg = shouldArchive
      ? `Monthly data snapshot - ${closedMonthLabel}`
      : `Data update - ${monthYear}`;

    // 1. GitHub Push: stats.json + playlists.json + monthly-stats/ (before local archiving)
    console.log('📤 Pushing stats.json, playlists.json and monthly-stats to GitHub...');
    if (!gitPushDataFiles(commitMsg)) {
      return false;
    }

    // 2. Local archiving + 3. reset (only monthly rollover)
    if (shouldArchive) {
      const closed = getClosedMonthArchivePaths();
      console.log(`📦 Local archiving of closed month (Rome): ${closed.yearMonth}`);
      const archiveResult = await archiveMonthlyStats();
      if (!archiveResult.success) {
        console.error(`❌ Push ok but local archiving failed: ${archiveResult.error}`);
        return false;
      }
      if (!resetStatsFile()) {
        console.error('❌ Archiving ok but stats.json reset failed');
        return false;
      }
    }

    return true;

  } catch (e) {
    console.error('❌ Error pushing stats:', e.message);
    if (e.stderr) console.error('Stderr:', e.stderr.toString());
    if (e.stdout) console.error('Stdout:', e.stdout.toString());
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const forceArchive = process.argv.includes('--force') || process.argv.includes('--archive');
  if (forceArchive) {
    console.log('📦 Force archive mode enabled (skipped if the closed month is already archived)');
  }
  const success = await pushStats(forceArchive);
  process.exit(success ? 0 : 1);
}

export { pushStats, getRomeCalendarParts, getClosedMonthArchivePaths, getClosedMonthLabel };
