/**
 * src/ui/index.js
 * Barrel module for UI functions
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
