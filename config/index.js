/**
 * Esportazione centralizzata di tutte le configurazioni
 */

const paths = require('./paths');
const constants = require('./constants');

module.exports = {
    ...paths,
    ...constants
};
