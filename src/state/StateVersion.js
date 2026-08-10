/**
 * src/state/StateVersion.js
 *
 * Versioning system for queue state.
 * Prevents race conditions by detecting stale queue state reads.
 *
 * Every critical mutation increments the version.
 * Readers also check the version to detect conflicts.
 */

class QueueStateVersion {
  constructor(guildId) {
    this.guildId = guildId;
    this.version = 0;
    this.lastMutationTime = Date.now();
    this.lastMutationType = 'init';
    this.mutationLog = []; // last 50 events
    this.locks = new Map(); // tracker for critical operations
  }

  /**
     * Increments version and logs mutation type
     * @param {string} mutationType - Mutation type (e.g., 'skip_start', 'deck_change', 'clear_queue')
     * @param {object} details - Additional mutation details
     * @returns {number} - New version
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
     * Reads current version without incrementing
     * @returns {number} - Current version
     */
  getVersion() {
    return this.version;
  }

  /**
     * Checks if a read version is still valid (not stale)
     * @param {number} versionRead - Version that was previously read
     * @param {number} maxAgeMsec - Max age allowed in milliseconds (default: 5s)
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
     * Acquires a lock for a critical operation
     * @param {string} operationId - Unique operation identifier (e.g., 'skip_123')
     * @returns {object} - Lock with release() and isExpired() methods
     */
  acquireLock(operationId, timeoutMs = 30000) {
    // Lazy cleanup: remove expired or released locks
    for (const [lockId, existingLock] of this.locks) {
      if (existingLock.released || existingLock.isExpired()) {
        this.locks.delete(lockId);
      }
    }

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
     * Checks if there's an active lock whose operationId starts with given prefix.
     * Used to detect concurrent skips: acquireLock uses operationId with timestamp,
     * but hasActiveLock searches by prefix (e.g., 'skip_GUILDID').
     * @param {string} operationPrefix - Operation ID prefix to search for
     * @returns {boolean}
     */
  hasActiveLock(operationPrefix) {
    for (const [, lock] of this.locks) {
      if (lock.operationId.startsWith(operationPrefix) && !lock.released && !lock.isExpired()) {
        return true;
      }
    }
    return false;
  }

  /**
     * Gets log of recent mutations for debugging
     * @returns {array}
     */
  getMutationLog() {
    return [...this.mutationLog];
  }

  /**
     * Resets versioning state (used when bot leaves guild)
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
     * Gets the versioning object for a guild
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
     * Cleans up versioning for a guild (when bot leaves)
     * @param {string} guildId
     */
  cleanup(guildId) {
    if (this.versions.has(guildId)) {
      this.versions.get(guildId).reset();
      this.versions.delete(guildId);
    }
  }

  /**
     * Gets versioning info for all guilds (for debugging)
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

export {
  QueueStateVersion,
  StateVersionManager
};

export const stateVersionManager = new StateVersionManager();
