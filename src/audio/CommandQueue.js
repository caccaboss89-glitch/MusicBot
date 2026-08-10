/**
 * Command serialization system for Rust mixer.
 * Prevents race conditions by sending 1 command at a time.
 */

import { queue } from '../state/globals.js';
import { stateVersionManager } from '../state/StateVersion.js';

class CommandQueue {
  constructor() {
    this.queues = new Map(); // guildId -> { pending: [], executing: null, stats: {} }
  }

  /**
   * Gets the queue for a guild
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
   * Enqueues a command to execute serially
   * @param {string} guildId
   * @param {string} commandName - Command name (for logging)
   * @param {function} executeFn - Async function that executes the command
   * @param {object} options - { timeout: ms, retries: number, priority: 'normal'|'high' }
   * @returns {Promise<{success: boolean, result?: any, error?: Error}>}
   */
  async enqueue(guildId, commandName, executeFn, options = {}) {
    const {
      timeout = 10000,           // 10s default timeout per command
      retries = 1,               // Default: execute once only
      priority = 'normal'         // 'high' goes to front of queue
    } = options;

    const sq = queue.get(guildId);
    if (!sq || !sq.mixer || !sq.mixer.isProcessAlive()) {
      return { success: false, error: new Error('Mixer not alive') };
    }

    const commandQueue = this._getQueue(guildId);

    // Limit queue size to avoid OOM with dead/slow mixer
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

    // Create a promise that will be resolved when the command completes
    let resolveFunc, rejectFunc;
    const commandPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    commandEntry.promise = commandPromise;
    commandEntry.resolve = resolveFunc;
    commandEntry.reject = rejectFunc;

    // Enqueue
    if (priority === 'high') {
      commandQueue.pending.unshift(commandEntry);
    } else {
      commandQueue.pending.push(commandEntry);
    }

    console.log(`📤 [CMD-QUEUE] Enqueued '${commandName}' (queue size: ${commandQueue.pending.length + (commandQueue.executing ? 1 : 0)})`);

    // Start processor if not already running
    this._processQueue(guildId).catch(e => {
      console.error(`❌ [CMD-QUEUE] Process queue error: ${e.message}`);
    });

    return commandPromise;
  }

  /**
   * Processes the command queue serially
   */
  async _processQueue(guildId) {
    const commandQueue = this._getQueue(guildId);

    // If already executing, exit (will loop back when done)
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

        // Execute with timeout
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

      } catch (e) {
        console.error(`❌ [CMD-QUEUE] '${commandEntry.name}' failed:`, e.message);

        // Retry logic with exponential backoff
        if (commandEntry.retries > 0) {
          commandEntry.retries--;
          commandEntry._retryCount = (commandEntry._retryCount || 0) + 1;
          const backoffMs = Math.min(500 * Math.pow(2, commandEntry._retryCount - 1), 5000);
          await new Promise(r => setTimeout(r, backoffMs));
          commandQueue.pending.unshift(commandEntry);
          console.log(`⏳ [CMD-QUEUE] Retry '${commandEntry.name}' in ${backoffMs}ms (${commandEntry.retries} left)`);

          stateVersion.incrementVersion('command_retry', {
            commandName: commandEntry.name,
            error: e.message
          });
        } else {
          commandEntry.error = e;
          commandEntry.reject(e);
          commandQueue.stats.failureCount++;

          stateVersion.incrementVersion('command_failed', {
            commandName: commandEntry.name,
            error: e.message
          });
        }
      } finally {
        commandQueue.executing = null;
      }
    }
  }

  /**
   * Gets queue statistics for a guild
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
   * Clears the queue and cleans up (when bot leaves a guild)
   */
  cleanup(guildId) {
    if (this.queues.has(guildId)) {
      const commandQueue = this.queues.get(guildId);
      // Reject all pending commands
      commandQueue.pending.forEach(cmd => {
        cmd.reject(new Error('Guild cleanup'));
      });
      this.queues.delete(guildId);
    }
  }

  /**
   * Flushes and rejects all pending commands (e.g. mixer crash).
   * Unlike cleanup(), does NOT delete the queue entry —
   * mixer could be restarted and new commands might arrive.
   */
  flushAndReject(guildId, reason = 'Mixer crashed') {
    const commandQueue = this.queues.get(guildId);
    if (!commandQueue) return;
    const error = new Error(reason);
    const flushedCount = commandQueue.pending.length;
    commandQueue.pending.forEach(cmd => {
      try { cmd.reject(error); } catch { /* ignore */ }
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

export {
  CommandQueue,
  commandQueue
};
