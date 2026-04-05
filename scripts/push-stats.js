#!/usr/bin/env node
/**
 * Script per versionare i file dati persistenti su GitHub.
 * Chiamato automaticamente il 1° del mese dalle 10:00 in poi.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Usa percorsi assoluti basati sulla directory dello script per funzionare da qualsiasi directory
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATS_FILE = path.join(PROJECT_ROOT, 'data', 'stats.json');
const PLAYLIST_FILE = path.join(PROJECT_ROOT, 'data', 'playlists.json');
const MONTHLY_STATS_DIR = path.join(PROJECT_ROOT, 'data', 'monthly-stats');
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'MusicBot';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'bot@musicbot.local';

function shouldArchiveMonthlyStats(now = new Date()) {
    return now.getDate() === 1;
}

/**
 * Archiva le statistiche del mese precedente (crea backup in monthly-stats/)
 * NON resetta stats.json — il reset avviene DOPO il push riuscito
 */
function archiveMonthlyStats() {
    try {
        // Leggi le stat correnti
        const statsContent = fs.readFileSync(STATS_FILE, 'utf-8');
        const statsData = JSON.parse(statsContent);

        // Calcola le top 5 canzoni del mese prima di archiviare
        try {
            const { computeTopSongs } = require('../src/database/stats');
            computeTopSongs(statsData, 5);
            console.log('🏆 Top songs calcolate e aggiunte al backup mensile');
        } catch (e) {
            console.warn('⚠️ Errore nel calcolo top songs:', e.message);
        }

        // Calcola la data del mese precedente (primo del mese corrente = ultimo giorno del mese precedente)
        const now = new Date();
        const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastDayOfPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 0);

        const yearMonth = previousMonth.getFullYear() + '-' +
            String(previousMonth.getMonth() + 1).padStart(2, '0');
        const dateStr = lastDayOfPreviousMonth.getFullYear() + '-' +
            String(lastDayOfPreviousMonth.getMonth() + 1).padStart(2, '0') + '-' +
            String(lastDayOfPreviousMonth.getDate()).padStart(2, '0');

        // Crea la cartella monthly-stats/YYYY-MM se non esiste
        const monthDir = path.join(MONTHLY_STATS_DIR, yearMonth);
        if (!fs.existsSync(monthDir)) {
            fs.mkdirSync(monthDir, { recursive: true });
            console.log(`📁 Created directory: ${monthDir}`);
        }

        // Salva le statistiche del mese precedente
        const backupFileName = `stats-${dateStr}.json`;
        const backupFilePath = path.join(monthDir, backupFileName);
        fs.writeFileSync(backupFilePath, JSON.stringify(statsData, null, 2), 'utf-8');
        console.log(`📊 Archived monthly stats to: ${backupFilePath}`);

        // Resetta stats.json SUBITO dopo l'archiviazione (prima del commit/push)
        // Così il commit contiene sia l'archivio che il reset
        const resetOk = resetStatsFile();
        if (!resetOk) {
            return { success: false, error: 'Reset stats file failed after archive' };
        }

        return { success: true };
    } catch (e) {
        console.error('❌ Error archiving monthly stats:', e.message);
        return { success: false, error: e.message };
    }
}

/**
 * Resetta stats.json con struttura vuota per il nuovo mese
 * Chiamato DOPO il push riuscito
 */
function resetStatsFile() {
    try {
        const emptyStats = {
            users: {},
            global: { songsStarted: 0, songsCompleted: 0, songPlays: {} }
        };
        fs.writeFileSync(STATS_FILE, JSON.stringify(emptyStats, null, 2), 'utf-8');
        console.log('🧹 Stats file cleared and reset for new month');
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

        // Configura git con le variabili d'ambiente se disponibili
        try {
            execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
            execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
        } catch (e) {
            console.warn('⚠️ Git config may be already set:', e.message);
        }

        // Controlla se il branch attuale è 'main', ma non blocca il push in caso di branch diverso
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
        if (currentBranch !== 'main') {
            console.warn(`⚠️ Branch corrente: ${currentBranch} (non 'main'), procederò comunque con il commit/push su questo branch`);
        }

        if (shouldArchive) {
            console.log('📦 Archiviazione mensile delle stats in corso...');
            const archiveResult = archiveMonthlyStats();
            if (!archiveResult.success) {
                console.log(`❌ Archiviazione mensile fallita: ${archiveResult.error}, push annullato`);
                return false;
            }
        }

        // Aggiungi tutti i file dati persistenti aggiornati dal bot.
        // Usa --force per aggiungere i file anche se sono nel .gitignore
        execSync('git add --force data/stats.json data/playlists.json data/monthly-stats', { cwd: PROJECT_ROOT, encoding: 'utf-8' });

        // Controlla lo status dei file
        const status = execSync('git status --porcelain data/stats.json data/playlists.json data/monthly-stats', { cwd: PROJECT_ROOT, encoding: 'utf-8' });

        if (!status.trim()) {
            console.log('ℹ️ Nessun file dati persistente da sincronizzare su GitHub');
            return true;
        }

        // Log delle modifiche
        console.log('📝 Files to be committed:');
        console.log(status);

        // Fai il commit con timestamp per tracciabilità
        const timestamp = new Date().toISOString();
        const now = new Date();
        const monthYear = now.toLocaleString('it-IT', { month: 'long', year: 'numeric' });
        const commitMsg = shouldArchive
            ? `Monthly data snapshot - ${monthYear}`
            : `Data update - ${monthYear}`;

        execSync(`git commit -m "${commitMsg}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
        console.log('✅ Commit created successfully');

        // Fai il push sul branch corrente per ridurre errori di branch mismatch
        try {
            execSync('git push origin HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
            console.log('✅ File dati persistenti pushati su GitHub con successo');
        } catch (pushErr) {
            console.warn('⚠️ [STATS-PUSH] Push non-fast-forward; eseguo git pull --rebase e ritento...');
            try {
                execSync('git pull --rebase origin main', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
                execSync('git push origin HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
                console.log('✅ Push riuscito dopo rebase');
            } catch (rebaseErr) {
                console.error('❌ [STATS-PUSH] Ritento push fallito:', rebaseErr.message);
                return false;
            }
        }

        // Se era un archiving mensile, il reset di stats.json è già avvenuto
        // in archiveMonthlyStats() prima del commit (atomicamente)

        return true;

    } catch (e) {
        console.error('❌ Error pushing stats:', e.message);
        if (e.stderr) console.error('Stderr:', e.stderr.toString());
        if (e.stdout) console.error('Stdout:', e.stdout.toString());
        return false;
    }
}

// Esegui se chiamato direttamente
if (require.main === module) {
    const forceArchive = process.argv.includes('--force') || process.argv.includes('--archive');
    if (forceArchive) {
        console.log('📦 Force archive mode enabled');
    }
    const success = pushStats(forceArchive);
    process.exit(success ? 0 : 1);
}

module.exports = { pushStats };
