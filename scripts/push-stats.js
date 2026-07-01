#!/usr/bin/env node
/**
 * Script per versionare stats.json e playlists.json su GitHub.
 * L'archivio mensile (data/monthly-stats/) resta solo sul server, mai su git.
 * Flusso mensile: push GitHub → archiviazione locale → reset stats.json
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATS_FILE = path.join(PROJECT_ROOT, 'data', 'stats.json');
const PLAYLIST_FILE = path.join(PROJECT_ROOT, 'data', 'playlists.json');
const MONTHLY_STATS_DIR = path.join(PROJECT_ROOT, 'data', 'monthly-stats');
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'MusicBot';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'bot@musicbot.local';
const ROME_TZ = 'Europe/Rome';
const GIT_DATA_PATHS = 'data/stats.json data/playlists.json';

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

/** Mese chiuso da archiviare rispetto al calendario Roma (es. 1 luglio → giugno). */
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

function shouldArchiveMonthlyStats(now = new Date()) {
    return getRomeCalendarParts(now).day === 1;
}

function flushDataToDisk() {
    try {
        require('../src/database/playlists').flushDatabaseSync();
        console.log('💾 Playlist flush su disco completato');
    } catch (e) {
        console.warn('⚠️ Playlist flush fallito:', e.message);
    }
}

/**
 * Commit e push di stats.json + playlists.json su GitHub.
 * @returns {boolean} false solo se push fallisce
 */
function gitPushDataFiles(commitMsg) {
    execSync(`git add --force ${GIT_DATA_PATHS}`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });

    const status = execSync(`git status --porcelain ${GIT_DATA_PATHS}`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });

    if (!status.trim()) {
        console.log('ℹ️ Nessun cambiamento in stats.json / playlists.json da sincronizzare su GitHub');
        return true;
    }

    console.log('📝 Files to be committed:');
    console.log(status);

    execSync(`git commit -m "${commitMsg}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    console.log('✅ Commit created successfully');

    try {
        execSync('git push origin HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
        console.log('✅ stats.json e playlists.json pushati su GitHub');
    } catch (pushErr) {
        console.warn('⚠️ [STATS-PUSH] Push non-fast-forward; eseguo git pull --rebase e ritento...');
        try {
            execSync('git pull --rebase origin main', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
            execSync('git push origin HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
            console.log('✅ Push riuscito dopo rebase');
        } catch (rebaseErr) {
            console.error('❌ [STATS-PUSH] Push fallito:', rebaseErr.message);
            return false;
        }
    }

    return true;
}

/** Copia stats.json in monthly-stats/ (solo disco locale, mai git). */
function archiveMonthlyStats() {
    try {
        const statsContent = fs.readFileSync(STATS_FILE, 'utf-8');
        const statsData = JSON.parse(statsContent);

        try {
            const { computeTopSongs } = require('../src/database/stats');
            computeTopSongs(statsData, 5);
            console.log('🏆 Top songs calcolate per backup locale');
        } catch (e) {
            console.warn('⚠️ Errore nel calcolo top songs:', e.message);
        }

        const { yearMonth, backupFileName } = getClosedMonthArchivePaths();
        const monthDir = path.join(MONTHLY_STATS_DIR, yearMonth);
        if (!fs.existsSync(monthDir)) {
            fs.mkdirSync(monthDir, { recursive: true });
            console.log(`📁 Created directory: ${monthDir}`);
        }

        const backupFilePath = path.join(monthDir, backupFileName);
        fs.writeFileSync(backupFilePath, JSON.stringify(statsData, null, 2), 'utf-8');
        console.log(`📊 Archivio locale: ${backupFilePath}`);

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
        console.log('🧹 stats.json resettato per il nuovo mese');
        return true;
    } catch (e) {
        console.error('❌ Error resetting stats file:', e.message);
        return false;
    }
}

function pushStats(forceArchive = false) {
    try {
        if (!fs.existsSync(STATS_FILE)) {
            console.log('❌ Stats file not found:', STATS_FILE);
            return false;
        }

        if (!fs.existsSync(PLAYLIST_FILE)) {
            console.log('❌ Playlist file not found:', PLAYLIST_FILE);
            return false;
        }

        const shouldArchive = forceArchive || shouldArchiveMonthlyStats();

        try {
            execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
            execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
        } catch (e) {
            console.warn('⚠️ Git config may be already set:', e.message);
        }

        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
        if (currentBranch !== 'main') {
            console.warn(`⚠️ Branch corrente: ${currentBranch} (non 'main'), procederò comunque`);
        }

        flushDataToDisk();

        const monthYear = new Date().toLocaleString('it-IT', { month: 'long', year: 'numeric', timeZone: ROME_TZ });
        const commitMsg = shouldArchive
            ? `Monthly data snapshot - ${monthYear}`
            : `Data update - ${monthYear}`;

        // 1. Push GitHub: stats.json completo + playlists.json
        console.log('📤 Push stats.json e playlists.json su GitHub...');
        if (!gitPushDataFiles(commitMsg)) {
            return false;
        }

        // 2. Archiviazione locale + 3. reset (solo rollover mensile)
        if (shouldArchive) {
            const closed = getClosedMonthArchivePaths();
            console.log(`📦 Archiviazione locale mese chiuso (Roma): ${closed.yearMonth}`);
            const archiveResult = archiveMonthlyStats();
            if (!archiveResult.success) {
                console.error(`❌ Push ok ma archiviazione locale fallita: ${archiveResult.error}`);
                return false;
            }
            if (!resetStatsFile()) {
                console.error('❌ Archiviazione ok ma reset stats.json fallito');
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

if (require.main === module) {
    const forceArchive = process.argv.includes('--force') || process.argv.includes('--archive');
    if (forceArchive) {
        console.log('📦 Force archive mode enabled');
    }
    const success = pushStats(forceArchive);
    process.exit(success ? 0 : 1);
}

module.exports = { pushStats, getRomeCalendarParts, getClosedMonthArchivePaths };
