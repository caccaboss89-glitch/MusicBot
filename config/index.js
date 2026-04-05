/**
 * Export centralizzato delle configurazioni
 */

const paths = require('./paths');
const constants = require('./constants');

module.exports = {
    ...paths,
    ...constants
};
