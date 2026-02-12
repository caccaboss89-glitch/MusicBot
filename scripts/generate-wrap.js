#!/usr/bin/env node
/**
 * Script per copiare stats.json nel branch wrap-data
 * GitHub Actions lo chiama ogni 1° del mese alle 10:00
 * Esegui: node scripts/generate-wrap.js
 */

const fs = require('fs');
const path = require('path');

const STATS_SOURCE = process.env.STATS_FILE || './data/stats.json';
const WRAP_DIR = './wrap';

// Assicura che la directory esista
if (!fs.existsSync(WRAP_DIR)) {
    fs.mkdirSync(WRAP_DIR, { recursive: true });
}

// Main
function main() {
    console.log('📊 Aggiornamento dati mensili...');

    try {
        if (!fs.existsSync(STATS_SOURCE)) {
            console.error('❌ File stats.json non trovato:', STATS_SOURCE);
            process.exit(1);
        }

        // Copia stats.json a wrap/stats.json
        const destFile = path.join(WRAP_DIR, 'stats.json');
        fs.copyFileSync(STATS_SOURCE, destFile);
        console.log(`✅ Stats copiati: ${destFile}`);

        // Leggi per verificare
        const stats = JSON.parse(fs.readFileSync(destFile, 'utf-8'));
        const userCount = Object.keys(stats.users).length;
        const songsStarted = stats.global?.songsStarted || 0;
        const songsCompleted = stats.global?.songsCompleted || 0;

        console.log(`✅ Dati aggiornati:`);
        console.log(`   - ${userCount} utenti`);
        console.log(`   - ${songsStarted} canzoni avviate`);
        console.log(`   - ${songsCompleted} canzoni completate`);

    } catch (e) {
        console.error('❌ Errore:', e.message);
        process.exit(1);
    }
}

main();
