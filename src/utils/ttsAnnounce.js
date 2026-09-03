/**
 * Sends the title of the song that just started to the TTSBot, which reads it
 * out loud in the same voice channel.
 *
 * Fire and forget: the announcement is a nicety, so every failure (TTSBot down,
 * channel busy with a /read, malformed URL) is logged and dropped. Nothing here
 * ever throws or delays playback.
 */

import http from 'node:http';
import https from 'node:https';

import {
  MAX_ANNOUNCE_TITLE_CHARS,
  TTS_ANNOUNCE_TIMEOUT_MS,
  isTtsAnnounceEnabled,
  resolveTtsAnnounceUrl
} from '../../config/index.js';

// Enough to carry back the error message of the endpoint, which is a sentence.
const MAX_RESPONSE_CHARS = 1000;

/**
 * Turns a video title into something worth listening to: no line breaks, no
 * runs of spaces, and never longer than a spoken line.
 * @param {string} title
 * @returns {string} Empty when there is nothing to read
 */
function speechTitle(title) {
  const cleaned = String(title || '').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_ANNOUNCE_TITLE_CHARS
    ? cleaned.slice(0, MAX_ANNOUNCE_TITLE_CHARS).trim()
    : cleaned;
}

/**
 * POSTs the announcement and resolves with the answer of the endpoint.
 * @param {URL} url
 * @param {object} payload
 * @returns {Promise<{status: number, body: string}>}
 */
function postAnnouncement(url, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length
      },
      timeout: TTS_ANNOUNCE_TIMEOUT_MS
    }, response => {
      let raw = '';
      response.setEncoding('utf-8');
      response.on('data', chunk => {
        if (raw.length < MAX_RESPONSE_CHARS) raw += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, body: raw }));
    });

    request.on('timeout', () => {
      request.destroy(new Error(`no answer within ${TTS_ANNOUNCE_TIMEOUT_MS}ms`));
    });
    request.on('error', reject);
    request.end(body);
  });
}

/**
 * Asks the TTSBot to read the title in the given voice channel.
 * @param {object} announcement
 * @param {string} announcement.guildId
 * @param {string} announcement.channelId - Voice channel the music is playing in
 * @param {string} announcement.title
 * @returns {Promise<void>} Always resolves
 */
export async function announceSong({ guildId, channelId, title }) {
  if (!isTtsAnnounceEnabled()) return;

  const text = speechTitle(title);
  if (!text) return;

  let url;
  try {
    url = new URL(resolveTtsAnnounceUrl());
  } catch {
    console.warn(`⚠️  [TTS] Invalid TTS_ANNOUNCE_URL: "${resolveTtsAnnounceUrl()}"`);
    return;
  }

  try {
    const { status, body } = await postAnnouncement(url, { guildId, channelId, text });
    if (status === 202) {
      console.log(`🗣️  [TTS] Announced: "${text}"`);
      return;
    }
    // The endpoint answers with { ok: false, error } on every refusal; the raw
    // body is the fallback for anything else listening on that address.
    let detail = body;
    try { detail = JSON.parse(body).error || body; } catch { /* not our endpoint */ }
    console.warn(`⚠️  [TTS] Announcement refused (${status}): ${detail}`);
  } catch (e) {
    console.warn(`⚠️  [TTS] Announcement not delivered: ${e.message}`);
  }
}
