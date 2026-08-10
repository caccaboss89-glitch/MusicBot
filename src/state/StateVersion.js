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
    this.locks = new Map(); // tracker for critical operations
  }

  /**
     * Increments the version and records what caused the mutation
     * @param {string} mutationType - Mutation type (e.g., 'skip_start', 'deck_change', 'clear_queue')
     * @returns {number} - New version
     */
  incrementVersion(mutationType) {
    this.version++;
    this.lastMutationTime = Date.now();
    this.lastMutationType = mutationType;
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
     * Resets versioning state (used when bot leaves guild)
     */
  reset() {
    this.version = 0;
    this.lastMutationTime = Date.now();
    this.lastMutationType = 'reset';
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

}

export {
  QueueStateVersion,
  StateVersionManager
};

export const stateVersionManager = new StateVersionManager();
