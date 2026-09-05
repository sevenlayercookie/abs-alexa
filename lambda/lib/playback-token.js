'use strict';

const crypto = require('crypto');
const PREFIX = 'abs1.';

function createPlaybackToken(playSession, trackIndex, playbackId = null) {
  if (!playSession?.libraryItemId) throw new Error('Playback token requires a library item id');
  if (!Number.isInteger(Number(trackIndex)) || Number(trackIndex) < 1) {
    throw new Error(`Playback token requires a positive track index, received ${trackIndex}`);
  }

  const payload = {
    i: playSession.libraryItemId,
    s: playSession.id || null,
    t: Number(trackIndex),
    ...(playbackId ? { p: playbackId } : {})
  };
  return PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function parsePlaybackToken(token) {
  if (typeof token === 'number' || (typeof token === 'string' && /^\d+$/.test(token))) {
    const trackIndex = Number(token);
    return Number.isInteger(trackIndex) && trackIndex > 0
      ? { version: 0, libraryItemId: null, sessionId: null, trackIndex }
      : null;
  }
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;

  try {
    const payload = JSON.parse(Buffer.from(token.slice(PREFIX.length), 'base64url').toString('utf8'));
    if (typeof payload.i !== 'string' || payload.i.length === 0) return null;
    if (!Number.isInteger(payload.t) || payload.t < 1) return null;
    if (payload.s !== null && payload.s !== undefined && typeof payload.s !== 'string') return null;
    return {
      version: 1,
      libraryItemId: payload.i,
      sessionId: payload.s || null,
      trackIndex: payload.t,
      playbackId: typeof payload.p === 'string' ? payload.p : null
    };
  } catch {
    return null;
  }
}

function createPlaybackInstanceToken(playSession, trackIndex) {
  return createPlaybackToken(playSession, trackIndex, crypto.randomBytes(9).toString('base64url'));
}

module.exports = { createPlaybackToken, createPlaybackInstanceToken, parsePlaybackToken };
