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
 * Sanitizza il titolo per i contesti MASKED LINK `[titolo](url)` (es. liste playlist),
 * dove Discord interpreta il markdown DENTRO l'etichetta del link.
 *
 * Il problema reale visto in produzione: un titolo come "I'M DAT N**" contiene `**`
 * che, dentro `**[...]**` o `[...]`, collide con il markdown bold e ROMPE il link
 * (non più cliccabile, sintassi raw che fuoriesce). In passato si usava l'escape `\*`
 * che però compariva LETTERALMENTE. Soluzione: niente backslash, sostituiamo l'asterisco
 * con un carattere quasi identico (U+2217 ASTERISK OPERATOR) che NON è markdown. Risultato:
 * link sempre cliccabile, titolo visivamente fedele, zero backslash.
 *
 * @param {string} title - Titolo originale
 * @returns {string} - Titolo sicuro per masked link
 */
function sanitizeTitle(title) {
    if (!title) return "Titolo Sconosciuto";
    const cleaned = String(title)
        .replace(/\[/g, '(')   // le quadre romperebbero la sintassi [testo](url)
        .replace(/\]/g, ')')
        .replace(/\*/g, '∗')   // U+2217: evita bold/italic accidentali senza backslash visibili
        .replace(/\r?\n/g, ' ') // niente a capo dentro la descrizione
        .trim();
    return cleaned || "Titolo Sconosciuto";
}

/**
 * Titolo per `EmbedBuilder.setTitle()`. Discord NON interpreta il markdown nei titoli
 * degli embed: possiamo mostrare il titolo COMPLETAMENTE RAW (compresi `**`, `_`, `~`...),
 * cliccabile tramite setURL(). Togliamo solo gli a-capo e rispettiamo il limite di 256.
 *
 * @param {string} title - Titolo originale
 * @returns {string}
 */
function displayTitle(title) {
    if (!title) return "Titolo Sconosciuto";
    const cleaned = String(title).replace(/\r?\n/g, ' ').trim();
    if (!cleaned) return "Titolo Sconosciuto";
    return cleaned.length > 256 ? cleaned.slice(0, 255) + '…' : cleaned;
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
            fs.writeFileSync(filename, JSON.stringify(defaultData, null, 2));
        } catch (e) { }
        return defaultData;
    }
    try {
        return JSON.parse(fs.readFileSync(filename, 'utf-8'));
    } catch (e) {
        // File corrotto: salva backup prima di sovrascrivere
        try {
            fs.copyFileSync(filename, filename + '.corrupted.bak');
            console.warn(`⚠️ [SANITIZE] File corrotto: ${filename} — backup salvato come ${filename}.corrupted.bak`);
        } catch (backupErr) { /* ignore */ }
        try { fs.writeFileSync(filename, JSON.stringify(defaultData, null, 2)); } catch (err) { /* ignoriamo */ }
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
 * Normalizza un URL YouTube (o YouTube Music) alla forma canonica www.youtube.com
 * - Converte music.youtube.com → www.youtube.com
 * - Rimuove parametri di tracking (si, pp, feature, ecc.)
 * - Preserva list= e index= quando presenti (utile per mix/playlist context)
 * - Gestisce youtu.be, /embed/, /shorts/, /v/ ecc.
 * @param {string} url
 * @returns {string}
 */
function normalizeYoutubeUrl(url) {
    if (!url || typeof url !== 'string') return url;
    let u = url.trim();

    // 1. Converti domini music.youtube e m.youtube a www.youtube
    u = u.replace(/^https?:\/\/(?:music|m)\.youtube\.com\//i, 'https://www.youtube.com/');

    // 2. Prova parsing URL per pulizia precisa dei query params
    try {
        const parsed = new URL(u);
        if (parsed.hostname.endsWith('youtube.com') || parsed.hostname === 'youtu.be') {
            const v = parsed.searchParams.get('v');
            const list = parsed.searchParams.get('list');
            const index = parsed.searchParams.get('index');

            let base;
            if (parsed.hostname === 'youtu.be' && parsed.pathname.length > 1) {
                const id = parsed.pathname.slice(1).split(/[?#]/)[0];
                base = `https://www.youtube.com/watch?v=${id}`;
            } else if (v) {
                base = `https://www.youtube.com/watch?v=${v}`;
            } else if (parsed.pathname.includes('/playlist')) {
                // Playlist page: mantieni il path e solo il list param
                const qs = list ? `?list=${list}` : '';
                return `https://www.youtube.com${parsed.pathname}${qs}`;
            } else {
                // Non è un video singolo riconoscibile, restituisci con dominio normalizzato
                return u.replace(/^https?:\/\/[^/]+/, 'https://www.youtube.com');
            }

            const params = new URLSearchParams();
            if (list) params.set('list', list);
            if (index && list) params.set('index', index);
            const qs = params.toString();
            return qs ? `${base}?${qs}` : base;
        }
    } catch (_) {
        // Fallback regex semplice
    }

    // Fallback regex-based (per URL malformati o casi edge)
    const idMatch = u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|playlist\?list=))([a-zA-Z0-9_-]{11,})/);
    if (idMatch && idMatch[1] && idMatch[1].length === 11) {
        // Se c'è list= nel query originale, prova a preservarlo
        const listMatch = u.match(/[?&]list=([A-Za-z0-9_-]+)/);
        if (listMatch) {
            return `https://www.youtube.com/watch?v=${idMatch[1]}&list=${listMatch[1]}`;
        }
        return `https://www.youtube.com/watch?v=${idMatch[1]}`;
    }

    return u;
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
    displayTitle,
    safeJSONParse,
    getYoutubeId,
    areSameSong,
    normalizeYoutubeUrl
};
