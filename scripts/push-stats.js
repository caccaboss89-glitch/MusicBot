#!/usr/bin/env node
/**
 * Script per pushare stats.json e playlists.json su GitHub
 * Esegui: node scripts/push-stats.js
 * Chiamato automaticamente il 1° del mese dalle 10:00 in poi
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STATS_FILE = './data/stats.json';
const PLAYLIST_FILE = './data/playlists.json';
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'MusicBot';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'bot@musicbot.local';

function pushStats() {
    try {
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
            execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { stdio: 'pipe' });
            execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { stdio: 'pipe' });
        } catch (e) {
            // Potrebbe già essere configurato
        }

        // Controlla se il branch attuale è 'main'
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
        if (currentBranch !== 'main') {
            console.log(`⚠️ Not on main branch (current: ${currentBranch}), skipping push`);
            return false;
        }

        // Aggiungi i file
        execSync('git add data/stats.json data/playlists.json', { stdio: 'pipe' });

        // Controlla lo status dei file
        const status = execSync('git status --porcelain data/stats.json data/playlists.json', { encoding: 'utf-8' });
        
        if (!status.trim()) {
            console.log('ℹ️ Stats and playlists are already up to date on GitHub');
            return true;
        }

        // Log delle modifiche
        console.log('📝 Files to be committed:');
        console.log(status);

        // Fai il commit con timestamp per tracciabilità
        const timestamp = new Date().toISOString();
        const monthYear = new Date().toLocaleString('it-IT', { month: 'long', year: 'numeric' });
        const commitMsg = `Monthly stats update - ${monthYear}\n\nTimestamp: ${timestamp}`;
        
        execSync(`git commit -m "${commitMsg}"`, { stdio: 'pipe' });
        console.log('✅ Commit created successfully');

        // Fai il push
        execSync('git push origin main', { stdio: 'pipe' });
        console.log('✅ Stats and playlists pushed to GitHub successfully');
        return true;

    } catch (e) {
        console.error('❌ Error pushing stats:', e.message);
        console.error('Stack:', e.stack);
        return false;
    }
}

// Esegui se chiamato direttamente
if (require.main === module) {
    const success = pushStats();
    process.exit(success ? 0 : 1);
}

module.exports = { pushStats };
