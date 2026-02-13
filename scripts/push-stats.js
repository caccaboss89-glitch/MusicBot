#!/usr/bin/env node
/**
 * Script per pushare stats.json su GitHub
 * Esegui: node scripts/push-stats.js
 * Chiamato automaticamente il 1° del mese alle 10:00 Roma time
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STATS_FILE = './data/stats.json';
const PLAYLIST_FILE = './data/playlists.json';
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'MusicBot Stats Auto-Pusher';
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

        // Configura git
        try {
            execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { stdio: 'pipe' });
            execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { stdio: 'pipe' });
        } catch (e) {
            // Potrebbe già essere configurato
        }

        // Aggiungi i file
        execSync('git add data/stats.json data/playlists.json', { stdio: 'pipe' });

        // Controlla se ci sono cambiamenti
        const status = execSync('git status --porcelain data/stats.json data/playlists.json', { encoding: 'utf-8' });
        
        if (!status.trim()) {
            console.log('✓ Stats file is already up to date on GitHub');
            return true;
        }

        // Fai il commit
        const timestamp = new Date().toISOString();
        const monthYear = new Date().toLocaleString('it-IT', { month: 'long', year: 'numeric' });
        execSync(`git commit -m "Monthly stats update - ${monthYear} [${timestamp}]"`, { stdio: 'pipe' });

        // Fai il push
        execSync('git push origin main', { stdio: 'pipe' });
        console.log('✅ Stats and playlist backup pushed to GitHub successfully');
        return true;

    } catch (e) {
        console.error('❌ Error pushing stats:', e.message);
        return false;
    }
}

// Esegui se chiamato direttamente
if (require.main === module) {
    pushStats();
}

module.exports = { pushStats };
