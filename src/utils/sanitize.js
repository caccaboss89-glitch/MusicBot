/**
 * Funzioni di utilità per parsing e sanitizzazione
 */

const fs = require('fs');

/**
 * Parsing sicuro di un intero con valore di default
 * @param {any} value - Valore da parsare
 * @param {number} defaultValue - Valore di default se parsing fallisce
 * @returns {number} - Intero >= 0
 */
function safeParseInt(value, defaultValue = 0) {
    const parsed = parseInt(value);
    return isNaN(parsed) ? defaultValue : Math.max(0, parsed);
}

/**
 * Sanitizza il titolo di una canzone per evitare problemi con markdown Discord
 * @param {string} title - Titolo originale
 * @returns {string} - Titolo sanitizzato
 */
function sanitizeTitle(title) {
    if (!title) return "Titolo Sconosciuto";
    return title.replace(/\[/g, '(').replace(/\]/g, ')');
}

/**
 * Parsing sicuro di un file JSON con creazione se non esiste
 * @param {string} filename - Percorso del file JSON
 * @param {any} defaultData - Dati di default se file non esiste o è corrotto
 * @returns {any} - Dati parsati o default
 */
function safeJSONParse(filename, defaultData) {
    if (!fs.existsSync(filename)) {
        try { 
            fs.writeFileSync(filename, JSON.stringify(defaultData)); 
        } catch(e) {}
        return defaultData;
    }
    try { 
        return JSON.parse(fs.readFileSync(filename, 'utf-8')); 
    } catch (e) { 
        // File corrotto: sovrascrivi con default e restituisci default
        try { fs.writeFileSync(filename, JSON.stringify(defaultData, null, 2)); } catch(err) { /* ignoriamo */ }
        return defaultData; 
    }
}

/**
 * Estrae l'ID video da un URL YouTube
 * @param {string} url - URL YouTube
 * @returns {string|null} - ID video o null
 */
function getYoutubeId(url) {
    if (!url) return null;
    const match = url.match(/^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/);
    return (match && match[1]) ? match[1] : null;
}

/**
 * Confronta due URL per verificare se puntano alla stessa canzone
 * @param {string} url1 - Primo URL
 * @param {string} url2 - Secondo URL
 * @returns {boolean} - true se sono la stessa canzone
 */
function areSameSong(url1, url2) {
    if (url1 === url2) return true;
    const id1 = getYoutubeId(url1);
    const id2 = getYoutubeId(url2);
    if (id1 && id2 && id1.length >= 11 && id2.length >= 11) return id1 === id2;
    return false;
}

module.exports = {
    safeParseInt,
    sanitizeTitle,
    safeJSONParse,
    getYoutubeId,
    areSameSong
};
