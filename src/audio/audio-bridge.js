/**
 * src/audio/audio-bridge.js
 *
 * Registro di callback per rompere le dipendenze circolari nel modulo audio.
 *
 * Problema: index.js importa playback/SkipManager/PlaybackEngine, che a loro volta
 * hanno bisogno di funzioni definite in index.js (handleMixerCrash, refreshDashboard, ecc.).
 * Questo crea cicli risolti finora con lazy require() dentro le funzioni.
 *
 * Soluzione: ogni modulo registra le proprie funzioni qui al momento del caricamento.
 * Gli altri moduli le invocano tramite bridge.call() senza importare direttamente
 * il modulo target, eliminando il ciclo.
 */

const _registry = Object.create(null);

module.exports = {
    /**
     * Registra una callback con un nome univoco.
     * @param {string} name
     * @param {Function} fn
     */
    register(name, fn) {
        _registry[name] = fn;
    },

    /**
     * Invoca una callback registrata.
     * @param {string} name
     * @param {...any} args
     * @returns {any}
     */
    call(name, ...args) {
        const fn = _registry[name];
        if (!fn) throw new Error(`audio-bridge: '${name}' non registrato`);
        return fn(...args);
    },

    /**
     * Restituisce la callback registrata (senza invocarla), o undefined.
     * @param {string} name
     * @returns {Function|undefined}
     */
    get(name) {
        return _registry[name];
    }
};
