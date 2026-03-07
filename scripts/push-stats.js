#!/usr/bin/env node
/**
 * Script per pushare stats.json e playlists.json su GitHub
 * Esegui: node scripts/push-stats.js
 * Chiamato automaticamente il 1° del mese dalle 10:00 in poi
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

/**
 * Archiva le statistiche del mese precedente e resetta stats.json
 */
function archiveMonthlyStats() {
    try {
        // Leggi le stat correnti
        const statsContent = fs.readFileSync(STATS_FILE, 'utf-8');
        const statsData = JSON.parse(statsContent);

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

        // Resetta stats.json con struttura vuota
        const emptyStats = { users: {} };
        fs.writeFileSync(STATS_FILE, JSON.stringify(emptyStats, null, 2), 'utf-8');
        console.log('🧹 Stats file cleared and reset for new month');

        return true;
    } catch (e) {
        console.error('❌ Error archiving monthly stats:', e.message);
        return false;
    }
}

function pushStats(forceArchive = false) {
    try {
        // Cambia directory alla radice del progetto per git
        process.chdir(PROJECT_ROOT);
        
        if (!fs.existsSync(STATS_FILE)) {
            console.log('❌ Stats file not found:', STATS_FILE);
            return false;
        }

        if (!fs.existsSync(PLAYLIST_FILE)) {
            console.log('❌ Playlist file not found:', PLAYLIST_FILE);
            return false;
        }

        // Configura git con le variabili d'ambiente se disponibili
        try {
            execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { encoding: 'utf-8' });
            execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { encoding: 'utf-8' });
        } catch (e) {
            console.warn('⚠️ Git config may be already set:', e.message);
        }

        // Controlla se il branch attuale è 'main'
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
        if (currentBranch !== 'main') {
            console.log(`⚠️ Not on main branch (current: ${currentBranch}), skipping push`);
            return false;
        }

        // Aggiungi i file
        execSync('git add data/stats.json data/playlists.json', { encoding: 'utf-8' });

        // Controlla lo status dei file
        const status = execSync('git status --porcelain data/stats.json data/playlists.json', { encoding: 'utf-8' });
        
        if (!status.trim()) {
            console.log('ℹ️ Stats and playlists are already up to date on GitHub');
            // Se forceArchive è true, esegui comunque l'archivio
            if (forceArchive) {
                console.log('📦 Force archiving stats...');
                archiveMonthlyStats();
            }
            return true;
        }

        // Log delle modifiche
        console.log('📝 Files to be committed:');
        console.log(status);

        // Fai il commit con timestamp per tracciabilità
        const timestamp = new Date().toISOString();
        const monthYear = new Date().toLocaleString('it-IT', { month: 'long', year: 'numeric' });
        const commitMsg = `Monthly stats update - ${monthYear}`;
        
        execSync(`git commit -m "${commitMsg}"`, { encoding: 'utf-8' });
        console.log('✅ Commit created successfully');

        // Fai il push
        execSync('git push origin main', { encoding: 'utf-8' });
        console.log('✅ Stats and playlists pushed to GitHub successfully');

        // Dopo il push riuscito, archiva le stats mensuali e resetta il file
        const archiveSuccess = archiveMonthlyStats();
        if (!archiveSuccess) {
            console.warn('⚠️ Archiving stats completed with warnings, but push was successful');
        }

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
