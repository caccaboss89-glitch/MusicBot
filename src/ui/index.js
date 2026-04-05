/**
 * src/ui/index.js
 * Barrel module per le funzioni UI
 */

const { createCurrentSongEmbed, createFinishedEmbed } = require('./embeds');
const { generatePlaylistView, generateSearchResultsView, createDashboardComponents } = require('./components');
const { updateDashboard, updateDashboardToFinished, refreshDashboard } = require('./dashboard');

module.exports = {
    createCurrentSongEmbed,
    createFinishedEmbed,
    generatePlaylistView,
    generateSearchResultsView,
    createDashboardComponents,
    updateDashboard,
    updateDashboardToFinished,
    refreshDashboard
};
