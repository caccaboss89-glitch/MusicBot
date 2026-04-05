/**
 * Funzioni per interagire con YouTube tramite `yt-dlp`.
 */

const { spawn } = require('child_process');
const {
    LOCAL_TEMP_DIR,
    VIDEO_DURATION_TIMEOUT_MS,
    VIDEO_INFO_TIMEOUT_MS,
    getYtDlpCommand
} = require('../../config');

const DURATION_FETCH_CONCURRENCY = 3; // Max processi yt-dlp paralleli per fetch durata

// ─── Semaforo globale per limitare processi yt-dlp concorrenti ──────
const MAX_YTDLP_CONCURRENT = 6; // Max processi yt-dlp globali (cross-guild)
let _activeProcesses = 0;
const _waitQueue = [];

function acquireSlot() {
    if (_activeProcesses < MAX_YTDLP_CONCURRENT) {
        _activeProcesses++;
        return Promise.resolve();
    }
    return new Promise(resolve => _waitQueue.push(resolve));
}

function releaseSlot() {
    _activeProcesses--;
    if (_waitQueue.length > 0 && _activeProcesses < MAX_YTDLP_CONCURRENT) {
        _activeProcesses++;
        _waitQueue.shift()();
    }
}

/**
 * Estrae solo la durata di un video (funzione veloce di ripiego)
 * @param {string} videoUrl - URL del video YouTube
 * @returns {Promise<number>} - Durata in secondi (0 se fallisce)
 */
async function getVideoDuration(videoUrl) {
    await acquireSlot();
    try {
        return await new Promise((resolve) => {
            const ytdlpCmd = getYtDlpCommand([
                '--no-warnings',
                '--no-cache-dir',
                '--skip-download',
                '--force-ipv4',
                '--paths', `home:${LOCAL_TEMP_DIR}`,
                '-J',
                videoUrl
            ]);

            const processSearch = spawn(ytdlpCmd.cmd, ytdlpCmd.args);
            let data = '';
            let errorData = '';

            const killTimer = setTimeout(() => {
                if (!processSearch.killed) {
                    console.warn(`⏱️ [DURATION] Timeout per ${videoUrl.substring(0, 50)}...`);
                    processSearch.kill();
                }
            }, VIDEO_DURATION_TIMEOUT_MS);

            processSearch.stdout.on('data', chunk => { data += chunk; });
            processSearch.stderr.on('data', chunk => { errorData += chunk; });

            processSearch.on('close', (code) => {
                clearTimeout(killTimer);

                if (code !== 0 && errorData) {
                    console.warn(`⚠️ [DURATION] codice di uscita yt-dlp ${code}: ${errorData.substring(0, 200)}`);
                }

                try {
                    const info = JSON.parse(data);
                    const duration = info.duration || 0;
                    resolve(duration);
                } catch (e) {
                    console.warn(`⚠️ [DURATION] Errore di parsing: ${e.message}`);
                    resolve(0);
                }
            });

            processSearch.on('error', (e) => {
                clearTimeout(killTimer);
                console.error(`❌ [DURATION] Errore spawn processo: ${e.message}`);
                resolve(0);
            });
        });
    } finally { releaseSlot(); }
}

/**
 * Ottiene informazioni complete su un video o playlist
 * @param {string} query - URL o termine di ricerca
 * @returns {Promise<Array>} - Array di oggetti canzone
 * @throws {string} - 'TIMEOUT', 'TOO_LARGE'
 */
async function getVideoInfo(query) {
    await acquireSlot();
    try {
        const baseArgs = [
            '--flat-playlist',
            '-J',
            '--no-warnings',
            '--mark-watched',
            '--no-cache-dir',
            '--no-part',
            '--force-ipv4',
            '--paths', `home:${LOCAL_TEMP_DIR}`,
            '--skip-download',
            '--compat-options', 'no-youtube-unavailable-videos',
            '--yes-playlist'
        ];

        if (query.startsWith('http')) baseArgs.push(query); else baseArgs.push(`ytsearch1:${query}`);

        const ytdlpCmd = getYtDlpCommand(baseArgs);

        return new Promise((resolve, reject) => {
            const processSearch = spawn(ytdlpCmd.cmd, ytdlpCmd.args);
            let data = '';
            let errorData = '';
            let settled = false;

            const killTimer = setTimeout(() => {
                if (!processSearch.killed) { processSearch.kill(); if (!settled) { settled = true; reject(new Error('TIMEOUT')); } }
            }, VIDEO_INFO_TIMEOUT_MS);

            processSearch.stdout.on('data', chunk => {
                data += chunk;
                if (data.length > 50 * 1024 * 1024) {
                    processSearch.kill();
                    if (!settled) { settled = true; reject(new Error('TOO_LARGE')); }
                }
            });
            processSearch.stderr.on('data', chunk => {
                errorData += chunk.toString();
            });

            processSearch.on('error', (e) => {
                clearTimeout(killTimer);
                if (!settled) { settled = true; reject(e.message || 'SPAWN_ERROR'); }
            });

            processSearch.on('close', async () => {
                clearTimeout(killTimer);
                if (settled) return;
                if (!data) return resolve([]);
                try {
                    const info = JSON.parse(data);
                    if (info.entries) {
                        let results = info.entries.map(entry => ({
                            title: entry.title || "Titolo Sconosciuto",
                            url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
                            thumbnail: entry.thumbnails ? entry.thumbnails[0].url : 'https://i.imgur.com/AfFp7pu.png',
                            isLive: entry.is_live || false,
                            duration: entry.duration || 0
                        }));

                        // Se la durata è mancante, recuperala con una query veloce (max N alla volta)
                        const needsDuration = results.filter(s => !s.duration || s.duration === 0);
                        for (let i = 0; i < needsDuration.length; i += DURATION_FETCH_CONCURRENCY) {
                            const batch = needsDuration.slice(i, i + DURATION_FETCH_CONCURRENCY);
                            await Promise.all(batch.map(async (song) => {
                                try {
                                    const dur = await getVideoDuration(song.url);
                                    if (dur && dur > 0) song.duration = dur;
                                } catch (e) {
                                    // Mantieni duration: 0 se fallisce
                                }
                            }));
                        }

                        return resolve(results);
                    }
                    let result = {
                        title: info.title || "Titolo Sconosciuto",
                        url: info.webpage_url || info.url,
                        thumbnail: info.thumbnail || 'https://i.imgur.com/AfFp7pu.png',
                        isLive: info.is_live || false,
                        duration: info.duration || 0
                    };

                    // Se la durata è mancante per single video
                    if (!result.duration || result.duration === 0) {
                        try {
                            const dur = await getVideoDuration(result.url);
                            if (dur && dur > 0) result.duration = dur;
                        } catch (e) {
                            // Mantieni duration: 0 se fallisce
                        }
                    }

                    return resolve([result]);
                } catch (e) { resolve([]); }
            });
        });
    } finally { releaseSlot(); }
}

module.exports = {
    getVideoDuration,
    getVideoInfo
};
