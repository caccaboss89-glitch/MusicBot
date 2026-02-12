/**
 * src/audio/mixer-utils.js
 * Funzioni di utilità centralizzate per manipolazioni del mixer
 * Elimina duplicazione di safeMixerInvoke() tra playback, preload e crossfade
 */

/**
 * Invoca una funzione sul mixer in modo sicuro con error tracking e context
 * Gestisce automaticamente errori di processo morto e notifica crash recovery
 * @param {object} serverQueue - Oggetto coda del server
 * @param {string} guildId - ID della guild
 * @param {function} fn - Funzione da invocare sul mixer
 * @param {string} context - Contesto dell'operazione (per logging)
 * @returns {object} - { success: boolean, error?: Error }
 */
function safeMixerInvoke(serverQueue, guildId, fn, context = 'unknown') {
    try {
        if (!serverQueue || !serverQueue.mixer) {
            console.warn(`⚠️  [MIXER-INVOKE] Mixer non disponibile (${context}) - guild=${guildId}`);
            try { require('./index').handleMixerCrash(guildId, `no_mixer_${context}`); } catch(e){}
            return { success: false, error: new Error('No mixer') };
        }
        
        if (typeof serverQueue.mixer.isProcessAlive !== 'function' || !serverQueue.mixer.isProcessAlive()) {
            console.warn(`⚠️  [MIXER-INVOKE] Mixer processo morto (${context}) - guild=${guildId}`);
            try { require('./index').handleMixerCrash(guildId, `mixer_dead_${context}`); } catch(e){}
            return { success: false, error: new Error('Mixer process dead') };
        }
        
        try {
            fn();
            return { success: true };
        } catch (e) {
            console.error(`❌ [MIXER-INVOKE] Errore durante invocazione (${context}) - guild=${guildId}:`, e.message);
            console.error('Stack:', e.stack);
            try { require('./index').handleMixerCrash(guildId, `mixer_call_error_${context}`); } catch(ex){}
            return { success: false, error: e };
        }
    } catch (e) {
        console.error(`❌ [MIXER-INVOKE] Errore wrapper (${context}) - guild=${guildId}:`, e.message);
        try { require('./index').handleMixerCrash(guildId, `mixer_exception_${context}`); } catch(ex){}
        return { success: false, error: e };
    }
}

module.exports = {
    safeMixerInvoke
};
