/**
 * src/state/StateVersion.js
 * 
 * Sistema di versioning per lo stato della coda.
 * Previene race conditions rilevando letture stale del queue state.
 * 
 * Ogni mutazione critica incrementa la versione.
 * Chi legge lo stato legge anche la versione per rilevare conflitti.
 */

class QueueStateVersion {
    constructor(guildId) {
        this.guildId = guildId;
        this.version = 0;
        this.lastMutationTime = Date.now();
        this.lastMutationType = 'init';
        this.mutationLog = []; // ultimi 50 eventi
        this.locks = new Map(); // tracker per operazioni critiche
    }

    /**
     * Incrementa la versione e registra il tipo di mutazione
     * @param {string} mutationType - Tipo di mutazione (e.g., 'skip_start', 'deck_change', 'clear_queue')
     * @param {object} details - Dettagli aggiuntivi della mutazione
     * @returns {number} - Nuova versione
     */
    incrementVersion(mutationType, details = {}) {
        this.version++;
        this.lastMutationTime = Date.now();
        this.lastMutationType = mutationType;

        const logEntry = {
            version: this.version,
            timestamp: new Date().toISOString(),
            type: mutationType,
            details
        };

        this.mutationLog.push(logEntry);
        if (this.mutationLog.length > 50) {
            this.mutationLog.shift();
        }

        return this.version;
    }

    /**
     * Legge la versione corrente senza incrementare
     * @returns {number} - Versione corrente
     */
    getVersion() {
        return this.version;
    }

    /**
     * Verifica se una versione letta è ancora valida (non stale)
     * @param {number} versionRead - Versione che era stata letta prima
     * @param {number} maxAgeMsec - Età massima consentita in millisecondi (default: 5s)
     * @returns {{isValid: boolean, reason?: string}}
     */
    isVersionValid(versionRead, maxAgeMsec = 5000) {
        const timeSinceMutation = Date.now() - this.lastMutationTime;
        
        if (versionRead !== this.version) {
            return {
                isValid: false,
                reason: `Version mismatch: read=${versionRead}, current=${this.version}`,
                timeSinceMutation
            };
        }

        if (timeSinceMutation > maxAgeMsec) {
            return {
                isValid: false,
                reason: `Version too old: ${timeSinceMutation}ms > ${maxAgeMsec}ms`,
                timeSinceMutation
            };
        }

        return { isValid: true, timeSinceMutation };
    }

    /**
     * Acquisisce un lock per un'operazione critica
     * @param {string} operationId - Identificatore univoco dell'operazione (e.g., 'skip_123')
     * @returns {object} - Lock con metodi release() e isExpired()
     */
    acquireLock(operationId, timeoutMs = 30000) {
        const lockId = `${operationId}_${Date.now()}`;
        const lock = {
            id: lockId,
            operationId,
            acquiredAt: Date.now(),
            released: false,
            release: () => {
                lock.released = true;
                this.locks.delete(lockId);
            },
            isExpired: () => Date.now() - lock.acquiredAt > timeoutMs,
            getHeldTime: () => Date.now() - lock.acquiredAt
        };

        this.locks.set(lockId, lock);
        return lock;
    }

    /**
     * Verifica se esiste un lock attivo per un'operazione
     * @param {string} operationId - ID dell'operazione
     * @returns {boolean}
     */
    hasActiveLock(operationId) {
        for (const [, lock] of this.locks) {
            if (lock.operationId === operationId && !lock.released && !lock.isExpired()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Ottiene log delle mutazioni recenti per debugging
     * @returns {array}
     */
    getMutationLog() {
        return [...this.mutationLog];
    }

    /**
     * Resetta lo stato di versioning (usato quando il bot lascia la guild)
     */
    reset() {
        this.version = 0;
        this.lastMutationTime = Date.now();
        this.lastMutationType = 'reset';
        this.mutationLog = [];
        this.locks.clear();
    }
}

// Export singleton manager
class StateVersionManager {
    constructor() {
        this.versions = new Map(); // guildId -> QueueStateVersion
    }

    /**
     * Ottiene il versioning object per una guild
     * @param {string} guildId
     * @returns {QueueStateVersion}
     */
    get(guildId) {
        if (!this.versions.has(guildId)) {
            this.versions.set(guildId, new QueueStateVersion(guildId));
        }
        return this.versions.get(guildId);
    }

    /**
     * Pulisce il versioning per una guild (quando bot lascia)
     * @param {string} guildId
     */
    cleanup(guildId) {
        if (this.versions.has(guildId)) {
            this.versions.get(guildId).reset();
            this.versions.delete(guildId);
        }
    }

    /**
     * Ottiene versioning info per tutte le guild (per debugging)
     * @returns {object}
     */
    getDebugInfo() {
        const info = {};
        for (const [guildId, version] of this.versions) {
            info[guildId] = {
                version: version.getVersion(),
                lastMutation: version.lastMutationType,
                activeLocks: version.locks.size,
                timeSinceLastMutation: Date.now() - version.lastMutationTime
            };
        }
        return info;
    }
}

module.exports = {
    QueueStateVersion,
    StateVersionManager,
    stateVersionManager: new StateVersionManager()
};
