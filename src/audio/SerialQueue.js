/**
 * src/audio/SerialQueue.js
 *
 * Per-guild serial execution queue.
 *
 * Two instances cover every place the bot must not run audio work concurrently:
 *  - `commandQueue`         serializes commands sent to the Rust mixer
 *  - `audioOperationBarrier` serializes user-triggered audio operations (skip, replay, …)
 *
 * They differ only in configuration (throttle, retries, priority, guard), so the
 * mechanics — one operation at a time, timeout, stats, cleanup — live here once.
 *
 * CONTRACT: `run()` ALWAYS resolves with a result object and never rejects, so
 * callers have a single shape to handle:
 *   { success: true, result }
 *   { success: false, error: Error, throttled?: true }
 */

import { queue } from '../state/globals.js';
import { stateVersionManager } from '../state/StateVersion.js';

const MAX_PENDING = 50; // Bounds memory if the mixer stops draining the queue

/**
 * Races a promise against a timeout, always clearing the timer afterwards.
 * @param {Promise<any>|any} value - Result (or promise) of the operation
 * @param {number} ms - Timeout in milliseconds
 * @param {string} label - Included in the timeout error message
 * @returns {Promise<any>}
 */
async function withTimeout(value, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class SerialQueue {
  /**
   * @param {object} config
   * @param {string} config.label - Log prefix (e.g. 'CMD-QUEUE')
   * @param {number} config.defaultTimeout - Default per-operation timeout in ms
   * @param {number} [config.defaultRetries=0] - Default retry count on failure
   * @param {number} [config.defaultMinThrottle=0] - Minimum ms between two operations
   * @param {(guildId: string) => Error|null} [config.guard] - Pre-flight check run at enqueue time
   */
  constructor({ label, defaultTimeout, defaultRetries = 0, defaultMinThrottle = 0, guard = null }) {
    this.label = label;
    this.defaultTimeout = defaultTimeout;
    this.defaultRetries = defaultRetries;
    this.defaultMinThrottle = defaultMinThrottle;
    this.guard = guard;
    this.queues = new Map(); // guildId -> { pending: [], executing: null, lastRunTime: number }
  }

  _getQueue(guildId) {
    if (!this.queues.has(guildId)) {
      this.queues.set(guildId, { pending: [], executing: null, lastRunTime: 0 });
    }
    return this.queues.get(guildId);
  }

  /**
   * Enqueues an operation and resolves once it has run (or definitively failed).
   * @param {string} guildId
   * @param {string} name - Operation name (for logging)
   * @param {function} executeFn - Function performing the operation (may be async)
   * @param {object} [options] - { timeout, retries, priority: 'normal'|'high', minThrottle }
   * @returns {Promise<{success: boolean, result?: any, error?: Error, throttled?: boolean}>}
   */
  run(guildId, name, executeFn, options = {}) {
    const {
      timeout = this.defaultTimeout,
      retries = this.defaultRetries,
      priority = 'normal',
      minThrottle = this.defaultMinThrottle
    } = options;

    const guardError = this.guard ? this.guard(guildId) : null;
    if (guardError) return Promise.resolve({ success: false, error: guardError });

    const q = this._getQueue(guildId);

    if (minThrottle > 0) {
      const waitLeft = minThrottle - (Date.now() - q.lastRunTime);
      if (waitLeft > 0) {
        console.warn(`⏳ [${this.label}] '${name}' throttled (${waitLeft}ms left)`);
        return Promise.resolve({
          success: false,
          throttled: true,
          error: new Error(`Operation throttled, wait ${waitLeft}ms`)
        });
      }
    }

    if (q.pending.length >= MAX_PENDING) {
      return Promise.resolve({ success: false, error: new Error(`Queue full (${MAX_PENDING})`) });
    }

    let settle;
    const promise = new Promise(resolve => { settle = resolve; });
    const entry = { name, executeFn, timeout, retries, settle, attempt: 0 };

    if (priority === 'high') q.pending.unshift(entry);
    else q.pending.push(entry);

    console.log(`📤 [${this.label}] Enqueued '${name}' (queue size: ${q.pending.length + (q.executing ? 1 : 0)})`);

    this._drain(guildId);
    return promise;
  }

  /**
   * Runs queued operations one at a time. Re-entrant calls return immediately:
   * the loop already running picks up whatever was just enqueued.
   */
  async _drain(guildId) {
    const q = this._getQueue(guildId);
    if (q.executing) return;

    while (q.pending.length > 0) {
      const entry = q.pending.shift();
      q.executing = entry;

      const guardError = this.guard ? this.guard(guildId) : null;
      if (guardError) {
        entry.settle({ success: false, error: guardError });
        q.executing = null;
        continue;
      }

      const stateVersion = stateVersionManager.get(guildId);
      const startTime = Date.now();

      try {
        console.log(`▶️  [${this.label}] Executing '${entry.name}'`);
        const result = await withTimeout(entry.executeFn(), entry.timeout, entry.name);
        const executionTimeMs = Date.now() - startTime;

        console.log(`✅ [${this.label}] '${entry.name}' completed (${executionTimeMs}ms)`);
        stateVersion.incrementVersion('serial_operation');

        q.lastRunTime = Date.now();
        entry.settle({ success: true, result });
      } catch (e) {
        console.error(`❌ [${this.label}] '${entry.name}' failed:`, e.message);
        q.lastRunTime = Date.now();

        if (entry.retries > 0) {
          entry.retries--;
          entry.attempt++;
          const backoffMs = Math.min(500 * Math.pow(2, entry.attempt - 1), 5000);
          console.log(`⏳ [${this.label}] Retry '${entry.name}' in ${backoffMs}ms (${entry.retries} left)`);
          stateVersion.incrementVersion('serial_operation_retry');
          await new Promise(r => setTimeout(r, backoffMs));
          q.pending.unshift(entry);
        } else {
          stateVersion.incrementVersion('serial_operation_failed');
          entry.settle({ success: false, error: e });
        }
      } finally {
        q.executing = null;
      }
    }
  }

  /**
   * Drops every pending operation without deleting the queue entry.
   * Used when the mixer crashes: it may restart and take new commands.
   * @param {string} guildId
   * @param {string} reason - Reported to the waiting callers
   */
  flushPending(guildId, reason) {
    const q = this.queues.get(guildId);
    if (!q || q.pending.length === 0) return;
    const flushed = q.pending;
    q.pending = [];
    const error = new Error(reason);
    flushed.forEach(entry => entry.settle({ success: false, error }));
    console.log(`🧹 [${this.label}] Flushed ${flushed.length} pending operations for guild=${guildId} (${reason})`);
  }

  /**
   * Drops pending operations and forgets the guild (bot left the server).
   * @param {string} guildId
   */
  cleanup(guildId) {
    this.flushPending(guildId, 'Guild cleanup');
    this.queues.delete(guildId);
  }
}

// Commands sent to the Rust mixer: retried once, refused outright if the mixer is gone.
const commandQueue = new SerialQueue({
  label: 'CMD-QUEUE',
  defaultTimeout: 10000,
  defaultRetries: 1,
  guard: (guildId) => {
    const sq = queue.get(guildId);
    return (sq && sq.mixer && sq.mixer.isProcessAlive())
      ? null
      : new Error('Mixer not alive');
  }
});

// User-triggered audio operations: never retried, throttled to curb button spam.
const audioOperationBarrier = new SerialQueue({
  label: 'AUDIO-BARRIER',
  defaultTimeout: 15000,
  defaultRetries: 0,
  defaultMinThrottle: 2000,
  guard: (guildId) => queue.has(guildId) ? null : new Error('Guild not found')
});

export { SerialQueue, commandQueue, audioOperationBarrier };
