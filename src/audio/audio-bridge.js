/**
 * Registry of callbacks to break circular dependencies in audio module.
 */

const _registry = Object.create(null);

/**
 * Registers a callback with a unique name.
 * @param {string} name
 * @param {Function} fn
 */
function register(name, fn) {
  _registry[name] = fn;
}

/**
 * Invokes a registered callback.
 * @param {string} name
 * @param {...any} args
 * @returns {any}
 */
function call(name, ...args) {
  const fn = _registry[name];
  if (!fn) throw new Error(`audio-bridge: '${name}' not registered`);
  return fn(...args);
}

/**
 * Returns registered callback (without invoking), or undefined.
 * @param {string} name
 * @returns {Function|undefined}
 */
function get(name) {
  return _registry[name];
}

export { register, call, get };
