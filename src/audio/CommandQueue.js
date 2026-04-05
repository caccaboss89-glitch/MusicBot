/**
 * src/audio/CommandQueue.js
 * 
 * Sistema di serializzazione dei comandi verso il mixer Rust.
 * Previene race conditions mandando 1 comando alla volta.
 * 
 * Problema risolto:
 * - Skip + pause simultanei causano mixer desync
 * - Crossfade + skipTo concorrenti generano audio corrupto
 * - Multipli comandi load() sullo stesso deck causano state confusion
 * 
 * Soluzione:
 * - Coda FIFO per guildId
 * - Ogni comando attende il precedente
 * - Timeout per richieste stale
 * - Retry logic per comandi falliti
 */

const { queue } = require('../state/globals');
const { stateVersionManager } = require('../state/StateVersion');

class CommandQueue {
    constructor() {
        this.queues = new Map(); // guildId -> { pending: [], executing: null, stats: {} }
    }

    /**
     * Ottiene la coda per una guild
     */
    _getQueue(guildId) {
        if (!this.queues.has(guildId)) {
            this.queues.set(guildId, {
                pending: [],
                executing: null,
                stats: {
                    totalCommands: 0,
                    successCount: 0,
                    failureCount: 0,
                    avgWaitTimeMs: 0,
                    lastCommandTime: null
                }
            });
        }
        return this.queues.get(guildId);
    }

    /**
     * Enqueues un comando da eseguire in modo seriale
     * @param {string} guildId
     * @param {string} commandName - Nome del comando (per logging)
     * @param {function} executeFn - Funzione asincrona che esegue il comando
     * @param {object} options - { timeout: ms, retries: number, priority: 'normal'|'high' }
     * @returns {Promise<{success: boolean, result?: any, error?: Error}>}
     */
    async enqueue(guildId, commandName, executeFn, options = {}) {
        const {
            timeout = 10000,           // 10s default timeout per comando
            retries = 1,               // Default: esegui una volta sola
            priority = 'normal'         // 'high' va in front della coda
        } = options;

        const sq = queue.get(guildId);
        if (!sq || !sq.mixer || !sq.mixer.isProcessAlive()) {
            return { success: false, error: new Error('Mixer not alive') };
        }

        const commandQueue = this._getQueue(guildId);

        // Limite dimensione coda per evitare OOM con mixer morto/lento
        if (commandQueue.pending.length >= 50) {
            return { success: false, error: new Error('Command queue full (50)') };
        }

        const commandId = `${commandName}_${Date.now()}_${Math.random()}`;
        const commandEntry = {
            id: commandId,
            name: commandName,
            executeFn,
            timeout,
            retries,
            priority,
            enqueuedAt: Date.now(),
            result: null,
            error: null,
            promise: null,
            resolve: null,
            reject: null
        };

        // Crea una promise che sarà risolta quando il comando completa
        let resolveFunc, rejectFunc;
        const commandPromise = new Promise((resolve, reject) => {
            resolveFunc = resolve;
            rejectFunc = reject;
        });
        commandEntry.promise = commandPromise;
        commandEntry.resolve = resolveFunc;
        commandEntry.reject = rejectFunc;

        // Metti in coda
        if (priority === 'high') {
            commandQueue.pending.unshift(commandEntry);
        } else {
            commandQueue.pending.push(commandEntry);
        }

        console.log(`📤 [CMD-QUEUE] Enqueued '${commandName}' (queue size: ${commandQueue.pending.length + (commandQueue.executing ? 1 : 0)})`);

        // Avvia il processor se non è già in esecuzione
        this._processQueue(guildId).catch(err => {
            console.error(`❌ [CMD-QUEUE] Process queue error: ${err}`);
        });

        return commandPromise;
    }

    /**
     * Processa la coda degli comandi in modo seriale
     */
    async _processQueue(guildId) {
        const commandQueue = this._getQueue(guildId);

        // Se già in esecuzione, esci (tornerà in loop quando finisce)
        if (commandQueue.executing) {
            return;
        }

        while (commandQueue.pending.length > 0) {
            const commandEntry = commandQueue.pending.shift();
            commandQueue.executing = commandEntry;

            const sq = queue.get(guildId);
            if (!sq || !sq.mixer || !sq.mixer.isProcessAlive()) {
                commandEntry.error = new Error('Mixer died during execution');
                commandEntry.reject(commandEntry.error);
                commandQueue.executing = null;
                commandQueue.stats.failureCount++;
                continue;
            }

            const stateVersion = stateVersionManager.get(guildId);

            try {
                console.log(`▶️  [CMD-QUEUE] Executing '${commandEntry.name}'`);
                const startTime = Date.now();

                // Esegui con timeout
                const result = await Promise.race([
                    commandEntry.executeFn(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Command timeout')), commandEntry.timeout)
                    )
                ]);

                const executionTime = Date.now() - startTime;
                commandEntry.result = result;
                commandEntry.resolve({ success: true, result });

                commandQueue.stats.successCount++;
                commandQueue.stats.lastCommandTime = new Date().toISOString();
                commandQueue.stats.avgWaitTimeMs =
                    (commandQueue.stats.avgWaitTimeMs * (commandQueue.stats.totalCommands) + executionTime) /
                    (commandQueue.stats.totalCommands + 1);
                commandQueue.stats.totalCommands++;

                console.log(`✅ [CMD-QUEUE] '${commandEntry.name}' completed (${executionTime}ms)`);

                stateVersion.incrementVersion('command_executed', {
                    commandName: commandEntry.name,
                    executionTimeMs: executionTime
                });

            } catch (error) {
                console.error(`❌ [CMD-QUEUE] '${commandEntry.name}' failed:`, error.message);

                // Retry logic con backoff esponenziale
                if (commandEntry.retries > 0) {
                    commandEntry.retries--;
                    commandEntry._retryCount = (commandEntry._retryCount || 0) + 1;
                    const backoffMs = Math.min(500 * Math.pow(2, commandEntry._retryCount - 1), 5000);
                    await new Promise(r => setTimeout(r, backoffMs));
                    commandQueue.pending.unshift(commandEntry);
                    console.log(`⏳ [CMD-QUEUE] Retry '${commandEntry.name}' in ${backoffMs}ms (${commandEntry.retries} left)`);

                    stateVersion.incrementVersion('command_retry', {
                        commandName: commandEntry.name,
                        error: error.message
                    });
                } else {
                    commandEntry.error = error;
                    commandEntry.reject(error);
                    commandQueue.stats.failureCount++;

                    stateVersion.incrementVersion('command_failed', {
                        commandName: commandEntry.name,
                        error: error.message
                    });
                }
            } finally {
                commandQueue.executing = null;
            }
        }
    }

    /**
     * Ottiene statistiche della coda per una guild
     */
    getStats(guildId) {
        const commandQueue = this._getQueue(guildId);
        return {
            ...commandQueue.stats,
            queueSize: commandQueue.pending.length,
            isProcessing: commandQueue.executing !== null
        };
    }

    /**
     * Cancella la coda e pulisce (quando bot lascia la guild)
     */
    cleanup(guildId) {
        if (this.queues.has(guildId)) {
            const commandQueue = this.queues.get(guildId);
            // Reject tutti i comandi in attesa
            commandQueue.pending.forEach(cmd => {
                cmd.reject(new Error('Guild cleanup'));
            });
            this.queues.delete(guildId);
        }
    }

    /**
     * Svuota e rigetta tutti i comandi pendenti (es. crash mixer).
     * A differenza di cleanup(), NON elimina la queue entry —
     * il mixer potrebbe essere riavviato e nuovi comandi potrebbero arrivare.
     */
    flushAndReject(guildId, reason = 'Mixer crashed') {
        const commandQueue = this.queues.get(guildId);
        if (!commandQueue) return;
        const error = new Error(reason);
        const flushedCount = commandQueue.pending.length;
        commandQueue.pending.forEach(cmd => {
            try { cmd.reject(error); } catch (e) { /* ignora */ }
        });
        commandQueue.pending = [];
        if (flushedCount > 0) {
            console.log(`🧹 [CMD-QUEUE] Flushed ${flushedCount} pending commands for guild=${guildId} (${reason})`);
        }
    }

    /**
     * Debug info
     */
    getDebugInfo() {
        const info = {};
        for (const [guildId, cq] of this.queues) {
            info[guildId] = {
                stats: cq.stats,
                queueSize: cq.pending.length,
                isProcessing: cq.executing !== null,
                executingCommand: cq.executing?.name || null
            };
        }
        return info;
    }
}

// Singleton instance
const commandQueue = new CommandQueue();

module.exports = {
    CommandQueue,
    commandQueue
};
