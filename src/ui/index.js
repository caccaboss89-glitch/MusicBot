/**
 * src/ui/index.js
 * Barrel export per il modulo UI
 */

const { createCurrentSongEmbed, createFinishedEmbed } = require('./embeds');
const { generatePlaylistView, generateSearchResultsView, createDashboardComponents } = require('./components');
const { updateDashboard, updateDashboardToFinished, refreshDashboard } = require('./dashboard');

module.exports = {
    // Embed
    createCurrentSongEmbed,
    createFinishedEmbed,
    // Componenti
    generatePlaylistView,
    generateSearchResultsView,
    createDashboardComponents,
    // Dashboard
    updateDashboard,
    updateDashboardToFinished
    ,
    refreshDashboard
};
