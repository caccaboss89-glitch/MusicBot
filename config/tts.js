/**
 * Spoken announcement of the song title.
 *
 * The bot cannot speak with a voice of its own while music is playing: the
 * announcement is made by the separate TTSBot (F:\Programmi\Bots\DiscordTTSBot),
 * which exposes a loopback-only HTTP endpoint on the same machine. Both bots run
 * side by side under PM2 on the mini server, so the call never leaves localhost.
 */

import { isEnvDisabled } from './paths.js';

// Matches ANNOUNCE_HOST/ANNOUNCE_PATH and the default ANNOUNCE_PORT of the TTSBot.
export const DEFAULT_TTS_ANNOUNCE_URL = 'http://127.0.0.1:8477/announce';

// Waited after the start of a song before announcing it. Short enough to still
// be "the song that just started", long enough that a burst of skips does not
// turn into a burst of readings.
export const TTS_ANNOUNCE_DELAY_MS = 5000;

// A title is a line, not a paragraph: anything longer is cut before being read.
export const MAX_ANNOUNCE_TITLE_CHARS = 200;

// The endpoint is on the same host, so an answer that takes longer than this
// means the TTSBot is stuck, not that the network is slow.
export const TTS_ANNOUNCE_TIMEOUT_MS = 5000;

/**
 * Whether the title of each song must be read out loud by the TTSBot.
 * There is NO default: the feature stays off until TTS_ANNOUNCE_ENABLED is set
 * to a truthy value, and `false`/`off`/`0`/`no` turn it back off.
 * @returns {boolean}
 */
export function isTtsAnnounceEnabled() {
  return !isEnvDisabled(process.env.TTS_ANNOUNCE_ENABLED);
}

/**
 * Address of the TTSBot announcement endpoint.
 * @returns {string}
 */
export function resolveTtsAnnounceUrl() {
  const raw = process.env.TTS_ANNOUNCE_URL;
  return (raw && raw.trim()) ? raw.trim() : DEFAULT_TTS_ANNOUNCE_URL;
}
