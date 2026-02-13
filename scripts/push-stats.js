#!/usr/bin/env node
/**
 * Script per pushare automaticamente stats.json su GitHub
 * Esegui: node scripts/push-stats.js
 * O aggiungilo a una task ricorrente/bot startup
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STATS_FILE = './data/stats.json';
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'MusicBot Stats';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'bot@musicbot.local';

function pushStats() {
    try {
        if (!fs.existsSync(STATS_FILE)) {
            console.log('❌ Stats file not found:', STATS_FILE);
            return false;
        }

        // Configura git
        execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { stdio: 'pipe' });
        execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { stdio: 'pipe' });

        // Aggiungi il file
        execSync('git add data/stats.json', { stdio: 'pipe' });

        // Controlla se ci sono cambiamenti
        const status = execSync('git status --porcelain data/stats.json', { encoding: 'utf-8' });
        
        if (!status.trim()) {
            console.log('✓ Stats file is up to date on GitHub');
            return true;
        }

        // Fai il commit
        const timestamp = new Date().toISOString();
        execSync(`git commit -m "Auto-update stats.json [${timestamp}]"`, { stdio: 'pipe' });

        // Fai il push
        execSync('git push origin main', { stdio: 'pipe' });
        console.log('✅ Stats pushed to GitHub successfully');
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
