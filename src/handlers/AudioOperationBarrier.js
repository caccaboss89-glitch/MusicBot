/**
 * Global barrier to serialize critical audio operations.
 * Prevents race condition when user spams skip, pause, etc.
 */

import { queue } from '../state/globals.js';
import { stateVersionManager } from '../state/StateVersion.js';

class AudioOperationBarrier {
  constructor() {
    this.operationQueues = new Map(); // guildId -> { operations: [], executing: null, lastOperationTime: 0 }
  }

  /**
   * Gets the queue for a guild
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
   * Requests exclusive access for an audio operation
   * @param {string} guildId
   * @param {string} operationName - Operation name (skip, pause, loop, etc)
   * @param {function} executeFn - Async function that executes the operation
   * @param {object} options - { timeout: ms, minThrottle: ms }
   * @returns {Promise<{success: boolean, result?: any, throttled?: boolean, error?: Error}>}
   */
  async request(guildId, operationName, executeFn, options = {}) {
    const {
      timeout = 15000,           // 15s default for critical audio operation
      minThrottle = 2000          // Min 2s between operations to prevent spam
    } = options;

    const sq = queue.get(guildId);
    if (!sq) {
      return { success: false, error: new Error('Guild not found') };
    }

    const operationQueue = this._getQueue(guildId);
    const now = Date.now();
    const timeSinceLastOp = now - operationQueue.lastOperationTime;

    // Check global throttle
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

    // Create a promise for this operation
    const operationPromise = new Promise((resolve, reject) => {
      operation.promise = { resolve, reject };
    });

    // Enqueue
    operationQueue.operations.push(operation);
    console.log(`📥 [AUDIO-BARRIER] Enqueued '${operationName}' (queue size: ${operationQueue.operations.length + (operationQueue.executing ? 1 : 0)})`);

    // Start processor
    this._processQueue(guildId).catch(e => {
      console.error(`❌ [AUDIO-BARRIER] Process error: ${e.message}`);
    });

    return operationPromise;
  }

  /**
   * Processes the operations queue in sequence
   */
  async _processQueue(guildId) {
    const operationQueue = this._getQueue(guildId);

    // If already executing, exit (will re-process when done)
    if (operationQueue.executing) {
      return;
    }

    while (operationQueue.operations.length > 0) {
      const operation = operationQueue.operations.shift();
      operationQueue.executing = operation;

      const sq = queue.get(guildId);
      if (!sq) {
        operation.error = new Error('Guild disappeared');
        operation.promise.resolve({ success: false, error: operation.error });
        operationQueue.executing = null;
        continue;
      }

      const stateVersion = stateVersionManager.get(guildId);

      try {
        console.log(`▶️  [AUDIO-BARRIER] Executing '${operation.name}'`);
        const startTime = Date.now();

        // Execute with timeout
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

      } catch (e) {
        console.error(`❌ [AUDIO-BARRIER] '${operation.name}' failed:`, e.message);
        operation.error = e;
        operation.promise.resolve({ success: false, error: e });
        operationQueue.lastOperationTime = Date.now();

        stateVersion.incrementVersion('audio_operation_failed', {
          operationName: operation.name,
          error: e.message
        });

      } finally {
        operationQueue.executing = null;
      }
    }
  }

  /**
   * Checks if an operation is in progress
   */
  isOperationInProgress(guildId) {
    const operationQueue = this._getQueue(guildId);
    return operationQueue.executing !== null || operationQueue.operations.length > 0;
  }

  /**
   * Gets statistics for a guild
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
   * Clears the queue when bot leaves a guild
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

export {
  AudioOperationBarrier,
  audioOperationBarrier
};
