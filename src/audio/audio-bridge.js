/**
 * Registro di callback per rompere le dipendenze circolari nel modulo audio.
 */

const _registry = Object.create(null);

/**
 * Registra una callback con un nome univoco.
 * @param {string} name
 * @param {Function} fn
 */
function register(name, fn) {
  _registry[name] = fn;
}

/**
 * Invoca una callback registrata.
 * @param {string} name
 * @param {...any} args
 * @returns {any}
 */
function call(name, ...args) {
  const fn = _registry[name];
  if (!fn) throw new Error(`audio-bridge: '${name}' non registrato`);
  return fn(...args);
}

/**
 * Restituisce la callback registrata (senza invocarla), o undefined.
 * @param {string} name
 * @returns {Function|undefined}
 */
function get(name) {
  return _registry[name];
}

export { register, call, get };
