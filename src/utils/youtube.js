/**
 * Funzioni per interagire con YouTube tramite `yt-dlp`.
 */

const { spawn } = require('child_process');
const {
    LOCAL_TEMP_DIR,
    YT_DLP_PATH,
    VIDEO_DURATION_TIMEOUT_MS,
    VIDEO_INFO_TIMEOUT_MS,
    USER_AGENT,
    getYtDlpCommand
} = require('../../config');

/**
 * Estrae solo la durata di un video (funzione veloce di ripiego)
 * @param {string} videoUrl - URL del video YouTube
 * @returns {Promise<number>} - Durata in secondi (0 se fallisce)
 */
async function getVideoDuration(videoUrl) {
    return new Promise((resolve) => {
        const ytdlpCmd = getYtDlpCommand([
            '--no-warnings',
            '--no-cache-dir',
            '--skip-download',
            '--force-ipv4',
            '--paths', `home:${LOCAL_TEMP_DIR}`,
            '--user-agent', USER_AGENT,
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
}

/**
 * Ottiene informazioni complete su un video o playlist
 * @param {string} query - URL o termine di ricerca
 * @returns {Promise<Array>} - Array di oggetti canzone
 * @throws {string} - 'TIMEOUT', 'TOO_LARGE'
 */
async function getVideoInfo(query) {
    const baseArgs = [
        '--flat-playlist', 
        '-J', 
        '--no-warnings', 
        '--no-mark-watched', 
        '--no-cache-dir', 
        '--no-part',
        '--force-ipv4',
        '--paths', `home:${LOCAL_TEMP_DIR}`,
        '--skip-download', 
        '--compat-options', 'no-youtube-unavailable-videos',
        '--yes-playlist', 
        '--user-agent', USER_AGENT 
    ];

    if (query.startsWith('http')) baseArgs.push(query); else baseArgs.push(`ytsearch1:${query}`);
    
    const ytdlpCmd = getYtDlpCommand(baseArgs);
    
    return new Promise((resolve, reject) => {
        const processSearch = spawn(ytdlpCmd.cmd, ytdlpCmd.args);
        let data = '';
        let errorData = '';
        
        const killTimer = setTimeout(() => {
            if (!processSearch.killed) { processSearch.kill(); reject('TIMEOUT'); }
        }, VIDEO_INFO_TIMEOUT_MS); 
        
        processSearch.stdout.on('data', chunk => { 
            data += chunk; 
            if (data.length > 50 * 1024 * 1024) { 
                processSearch.kill(); 
                reject('TOO_LARGE'); 
            } 
        });
        processSearch.stderr.on('data', chunk => { errorData += chunk.toString(); });

        processSearch.on('close', async () => {
            clearTimeout(killTimer);
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
                    
                    // Se la durata è mancante, recuperala con una query veloce
                    results = await Promise.all(results.map(async (song) => {
                        if (!song.duration || song.duration === 0) {
                            try {
                                const dur = await getVideoDuration(song.url);
                                if (dur && dur > 0) song.duration = dur;
                            } catch (e) {
                                // Mantieni duration: 0 se fallisce
                            }
                        }
                        return song;
                    }));
                    
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
}

module.exports = {
    getVideoDuration,
    getVideoInfo
};
