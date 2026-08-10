/**
 * src/ui/index.js
 * Barrel module per le funzioni UI
 */

import { createCurrentSongEmbed, createFinishedEmbed, createPlaybackErrorEmbed } from './embeds.js';
import { generatePlaylistView, generateSearchResultsView, createDashboardComponents } from './components.js';
import { updateDashboard, updateDashboardToFinished, refreshDashboard } from './dashboard.js';

export {
  createCurrentSongEmbed,
  createFinishedEmbed,
  createPlaybackErrorEmbed,
  generatePlaylistView,
  generateSearchResultsView,
  createDashboardComponents,
  updateDashboard,
  updateDashboardToFinished,
  refreshDashboard
};
