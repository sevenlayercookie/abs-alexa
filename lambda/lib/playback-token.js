'use strict';

const crypto = require('crypto');
const PREFIX = 'abs1.';

// `d` and `D` describe the stream itself: where this track starts within the
// book, and how long the book is. Alexa reports an offset measured from the
// start of the *track*, so without `d` that offset cannot be turned into a book
// position at all -- which previously meant fetching the play session, or the
// library item, purely to look up one number. Carrying it here also pins the
// layout the stream was built from, so a book re-split mid-playback cannot make
// an in-flight token resolve against tracks that no longer match it.
function createPlaybackToken(playSession, trackIndex, playbackId = null) {
  if (!playSession?.libraryItemId) throw new Error('Playback token requires a library item id');
  if (!Number.isInteger(Number(trackIndex)) || Number(trackIndex) < 1) {
    throw new Error(`Playback token requires a positive track index, received ${trackIndex}`);
  }

  const track = Array.isArray(playSession.audioTracks)
    ? playSession.audioTracks.find((candidate) => candidate.index == Number(trackIndex))
    : null;
  const trackStart = Number(track?.startOffset);
  const bookDuration = Number(playSession.duration);

  const payload = {
    i: playSession.libraryItemId,
    s: playSession.id || null,
    t: Number(trackIndex),
    ...(playbackId ? { p: playbackId } : {}),
    ...(Number.isFinite(trackStart) ? { d: trackStart } : {}),
    ...(Number.isFinite(bookDuration) ? { D: bookDuration } : {})
  };
  return PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function parsePlaybackToken(token) {
  if (typeof token === 'number' || (typeof token === 'string' && /^\d+$/.test(token))) {
    const trackIndex = Number(token);
    return Number.isInteger(trackIndex) && trackIndex > 0
      ? { version: 0, libraryItemId: null, sessionId: null, trackIndex,
          playbackId: null, trackStart: null, bookDuration: null }
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
      playbackId: typeof payload.p === 'string' ? payload.p : null,
      // Absent from tokens minted before these were carried. Callers must cope
      // with null rather than assume a stream started under this version.
      trackStart: Number.isFinite(payload.d) ? payload.d : null,
      bookDuration: Number.isFinite(payload.D) ? payload.D : null
    };
  } catch {
    return null;
  }
}

function createPlaybackInstanceToken(playSession, trackIndex) {
  return createPlaybackToken(playSession, trackIndex, crypto.randomBytes(9).toString('base64url'));
}

module.exports = { createPlaybackToken, createPlaybackInstanceToken, parsePlaybackToken };
