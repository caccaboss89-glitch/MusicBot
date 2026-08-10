/**
 * src/ui/embeds.js
 * Functions for creating Discord embeds
 */

import { EmbedBuilder } from 'discord.js';
import { displayTitle } from '../utils/sanitize.js';
import { getCurrentSong } from '../queue/QueueManager.js';
import {
  NO_SONGS, ADD_SONGS_TO_START, NOW_PLAYING, REQUESTED_BY,
  QUEUE_FINISHED, QUEUE_FINISHED_HINT, LAST_PLAYED, ADD_SONGS_TO_RESTART,
  UNKNOWN_SONG, PLAYBACK_ERROR_TITLE, PLAYBACK_ERROR_WILL_SKIP, PLAYBACK_ERROR_GAVE_UP
} from './messages.js';

/**
 * Creates the current song embed
 * @param {Object} serverQueue - Server queue
 * @returns {EmbedBuilder} Current song embed
 */
function createCurrentSongEmbed(serverQueue) {
  let song = null;

  try {
    if (serverQueue) {
      song = getCurrentSong(serverQueue);
    }
  } catch (e) {
    console.error('[EMBED] Error determining current song:', e);
  }

  if (!song || !song.url) {
    return new EmbedBuilder()
      .setColor(0x555555)
      .setTitle(NO_SONGS)
      .setDescription(ADD_SONGS_TO_START);
  }

  const embed = new EmbedBuilder()
    .setColor(song.isLive ? 0xFF0000 : 0x0099FF)
  // "🎶 Now Playing" as header (author): the TITLE of the embed becomes the song.
  // Discord does NOT interpret markdown in embed titles, so the title is
  // shown RAW (even with ** or other symbols) without breaking and without visible backslashes,
  // and is clickable thanks to setURL().
    .setAuthor({ name: NOW_PLAYING })
    .setTitle(displayTitle(song.title))
    .setURL(song.url)
    .setThumbnail(song.thumbnail)
    .addFields({ name: REQUESTED_BY, value: `<@${song.requester}>`, inline: true });

  // Loading footer (set by SkipManager during loading)
  if (serverQueue && serverQueue.loadingFooter) {
    embed.setFooter({ text: serverQueue.loadingFooter });
  }

  return embed;
}

/**
 * Creates finished queue embed
 * @param {Object|null} lastSong - Last played song
 * @returns {EmbedBuilder} Finished queue embed
 */
function createFinishedEmbed(lastSong) {
  const embed = new EmbedBuilder()
    .setColor(0x555555)
    .setAuthor({ name: QUEUE_FINISHED })
    .setThumbnail(lastSong ? lastSong.thumbnail : null)
    .setFooter({ text: QUEUE_FINISHED_HINT });

  if (lastSong) {
    // Raw and clickable title (see note in createCurrentSongEmbed): no masked link.
    embed.setTitle(displayTitle(lastSong.title)).setURL(lastSong.url).setDescription(LAST_PLAYED);
  } else {
    embed.setTitle(NO_SONGS).setDescription(ADD_SONGS_TO_RESTART);
  }

  return embed;
}

/**
 * Creates the embed warning that a song could not be played
 * @param {Object|null} song - Song that failed to stream
 * @param {boolean} willSkip - true if the next song is being started
 * @returns {EmbedBuilder} Playback error embed
 */
function createPlaybackErrorEmbed(song, willSkip = true) {
  const embed = new EmbedBuilder()
    .setColor(0xE74C3C)
    .setAuthor({ name: PLAYBACK_ERROR_TITLE })
    .setDescription(willSkip ? PLAYBACK_ERROR_WILL_SKIP : PLAYBACK_ERROR_GAVE_UP)
    .setThumbnail(song ? song.thumbnail : null);

  if (song) {
    // Raw and clickable title (see note in createCurrentSongEmbed): no masked link.
    embed.setTitle(displayTitle(song.title)).setURL(song.url);
  } else {
    embed.setTitle(UNKNOWN_SONG);
  }

  return embed;
}

export {
  createCurrentSongEmbed,
  createFinishedEmbed,
  createPlaybackErrorEmbed
};
