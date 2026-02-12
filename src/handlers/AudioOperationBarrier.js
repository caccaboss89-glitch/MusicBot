/**
 * src/handlers/AudioOperationBarrier.js
 * 
 * Barrier globale per serializzare le operazioni audio critiche.
 * Previene race conditions quando utente spamma skip, pause, etc.
 * 
 * Problema risolto:
 * - Skip + pause rapid-fire causano desync
 * - Crossfade durante skip causa audio corrupto
 * - Loop toggle mentre skip in progress causa state confusion
 * 
 * Soluzione:
 * - Una coda per guildId
 * - Operazioni eseguite in sequenza (NON in parallelo)
 * - Timeout per richieste stale
 * - Min throttle di 2s tra operazioni per prevenire spam utente
 */

const { queue } = require('../state/globals');
const { stateVersionManager } = require('../state/StateVersion');

class AudioOperationBarrier {
    constructor() {
        this.operationQueues = new Map(); // guildId -> { operations: [], executing: null, lastOperationTime: 0 }
    }

    /**
     * Ottiene la coda per una guild
     */
    _getQueue(guildId) {
        if (!this.operationQueues.has(guildId)) {
            this.operationQueues.set(guildId, {
                operations: [],
                executing: null,
                lastOperationTime: 0,
                stats: {
                    totalOps: 0,
                    successOps: 0,
                    throttledOps: 0
                }
            });
        }
        return this.operationQueues.get(guildId);
    }

    /**
     * Richiede l'accesso esclusivo per un'operazione audio
     * @param {string} guildId
     * @param {string} operationName - Nome dell'operazione (skip, pause, loop, etc)
     * @param {function} executeFn - Async function che esegue l'operazione
     * @param {object} options - { timeout: ms, minThrottle: ms }
     * @returns {Promise<{success: boolean, result?: any, throttled?: boolean, error?: Error}>}
     */
    async request(guildId, operationName, executeFn, options = {}) {
        const {
            timeout = 15000,           // 15s default per operazione audio critica
            minThrottle = 2000          // Min 2s tra operazioni per prevenire spam
        } = options;

        const sq = queue.get(guildId);
        if (!sq) {
            return { success: false, error: new Error('Guild not found') };
        }

        const operationQueue = this._getQueue(guildId);
        const now = Date.now();
        const timeSinceLastOp = now - operationQueue.lastOperationTime;

        // Controlla throttle globale
        if (timeSinceLastOp < minThrottle) {
            operationQueue.stats.throttledOps++;
            console.warn(`⏳ [AUDIO-BARRIER] '${operationName}' throttled (${minThrottle - timeSinceLastOp}ms left)`);
            return {
                success: false,
                throttled: true,
                error: new Error(`Operation throttled. Wait ${minThrottle - timeSinceLastOp}ms`)
            };
        }

        const operationId = `${operationName}_${guildId}_${now}`;
        const operation = {
            id: operationId,
            name: operationName,
            executeFn,
            timeout,
            enqueuedAt: now,
            result: null,
            error: null,
            promise: null
        };

        // Crea una promise per questa operazione
        const operationPromise = new Promise((resolve, reject) => {
            operation.promise = { resolve, reject };
        });

        // Metti in coda
        operationQueue.operations.push(operation);
        console.log(`📥 [AUDIO-BARRIER] Enqueued '${operationName}' (queue size: ${operationQueue.operations.length + (operationQueue.executing ? 1 : 0)})`);

        // Avvia il processor
        this._processQueue(guildId).catch(err => {
            console.error(`❌ [AUDIO-BARRIER] Process error: ${err}`);
        });

        return operationPromise;
    }

    /**
     * Processa la coda delle operazioni in sequenza
     */
    async _processQueue(guildId) {
        const operationQueue = this._getQueue(guildId);

        // Se già in esecuzione, esci (riprocesserà quando finisce)
        if (operationQueue.executing) {
            return;
        }

        while (operationQueue.operations.length > 0) {
            const operation = operationQueue.operations.shift();
            operationQueue.executing = operation;

            const sq = queue.get(guildId);
            if (!sq) {
                operation.error = new Error('Guild disappeared');
                operation.promise.reject(operation.error);
                operationQueue.executing = null;
                continue;
            }

            const stateVersion = stateVersionManager.get(guildId);

            try {
                console.log(`▶️  [AUDIO-BARRIER] Executing '${operation.name}'`);
                const startTime = Date.now();

                // Esegui con timeout
                const result = await Promise.race([
                    operation.executeFn(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Operation timeout (${operation.timeout}ms)`)), operation.timeout)
                    )
                ]);

                const executionTime = Date.now() - startTime;
                operation.result = result;
                operation.promise.resolve({ success: true, result });

                operationQueue.lastOperationTime = Date.now();
                operationQueue.stats.totalOps++;
                operationQueue.stats.successOps++;

                console.log(`✅ [AUDIO-BARRIER] '${operation.name}' completed (${executionTime}ms)`);

                stateVersion.incrementVersion('audio_operation', {
                    operationName: operation.name,
                    executionTimeMs: executionTime
                });

            } catch (error) {
                console.error(`❌ [AUDIO-BARRIER] '${operation.name}' failed:`, error.message);
                operation.error = error;
                operation.promise.reject(error);
                operationQueue.lastOperationTime = Date.now();

                stateVersion.incrementVersion('audio_operation_failed', {
                    operationName: operation.name,
                    error: error.message
                });

            } finally {
                operationQueue.executing = null;
            }
        }
    }

    /**
     * Verifica se c'è un'operazione in corso
     */
    isOperationInProgress(guildId) {
        const operationQueue = this._getQueue(guildId);
        return operationQueue.executing !== null || operationQueue.operations.length > 0;
    }

    /**
     * Ottiene statistiche per una guild
     */
    getStats(guildId) {
        const operationQueue = this._getQueue(guildId);
        return {
            ...operationQueue.stats,
            queueSize: operationQueue.operations.length,
            isProcessing: operationQueue.executing !== null,
            msUntilNextOp: Math.max(0, 2000 - (Date.now() - operationQueue.lastOperationTime))
        };
    }

    /**
     * Pulisce la coda quando bot lascia una guild
     */
    cleanup(guildId) {
        if (this.operationQueues.has(guildId)) {
            const operationQueue = this.operationQueues.get(guildId);
            operationQueue.operations.forEach(op => {
                op.promise.reject(new Error('Guild cleanup'));
            });
            this.operationQueues.delete(guildId);
        }
    }

    /**
     * Debug info
     */
    getDebugInfo() {
        const info = {};
        for (const [guildId, oq] of this.operationQueues) {
            info[guildId] = {
                stats: oq.stats,
                queueSize: oq.operations.length,
                isProcessing: oq.executing !== null,
                executingOperation: oq.executing?.name || null
            };
        }
        return info;
    }
}

// Singleton instance
const audioOperationBarrier = new AudioOperationBarrier();

module.exports = {
    AudioOperationBarrier,
    audioOperationBarrier
};
