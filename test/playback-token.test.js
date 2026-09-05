'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createPlaybackToken, createPlaybackInstanceToken,
  parsePlaybackToken } = require('../lambda/lib/playback-token');

describe('playback stream tokens', () => {
  test('round-trips the ABS item, play session, and track', () => {
    const token = createPlaybackToken({ libraryItemId: 'item-123', id: 'session-456' }, 7);
    assert.strictEqual(typeof token, 'string');
    assert.deepStrictEqual(parsePlaybackToken(token), {
      version: 1,
      libraryItemId: 'item-123',
      sessionId: 'session-456',
      trackIndex: 7,
      playbackId: null,
      trackStart: null,
      bookDuration: null
    });
  });

  test('carries where the track starts and how long the book is', () => {
    // Alexa reports an offset from the start of the track, so a book position
    // is only recoverable from the token if the track's start is in it.
    const session = {
      libraryItemId: 'item-123',
      id: 'session-456',
      duration: 10800,
      audioTracks: [
        { index: 1, startOffset: 0, duration: 3600 },
        { index: 2, startOffset: 3600, duration: 3600 },
        { index: 3, startOffset: 7200, duration: 3600 },
      ],
    };
    const parsed = parsePlaybackToken(createPlaybackToken(session, 3));
    assert.strictEqual(parsed.trackStart, 7200);
    assert.strictEqual(parsed.bookDuration, 10800);
    // 20 minutes into track 3 is 2h20m into the book, and nothing but the
    // token was needed to say so.
    assert.strictEqual(parsed.trackStart + 1200, 8400);
  });

  test('stays well inside the 1024-character token limit Alexa enforces', () => {
    const session = {
      libraryItemId: '95b7a24b-62e2-438a-ad9c-c41b991a7a32',
      id: '0994b10f-6c1f-4a35-9f0e-aabbccddeeff',
      duration: 81423.743129,
      audioTracks: [{ index: 1, startOffset: 12345.6789, duration: 81423.743129 }],
    };
    assert.ok(createPlaybackInstanceToken(session, 1).length < 300,
      'token has room to grow before Alexa refuses it');
  });

  test('omits the stream fields when the play session cannot supply them', () => {
    const parsed = parsePlaybackToken(
      createPlaybackToken({ libraryItemId: 'item-123', id: 'session-456' }, 1));
    assert.strictEqual(parsed.trackStart, null,
      'a caller must be able to tell "unknown" from "starts at zero"');
    assert.strictEqual(parsed.bookDuration, null);
  });

  test('gives each playback directive a unique self-describing token', () => {
    const session = { libraryItemId: 'item-123', id: 'session-456' };
    const first = createPlaybackInstanceToken(session, 7);
    const second = createPlaybackInstanceToken(session, 7);
    assert.notStrictEqual(first, second);
    assert.deepStrictEqual(
      { ...parsePlaybackToken(first), playbackId: Boolean(parsePlaybackToken(first).playbackId) },
      {
        version: 1,
        libraryItemId: 'item-123',
        sessionId: 'session-456',
        trackIndex: 7,
        playbackId: true,
        trackStart: null,
        bookDuration: null,
      });
  });

  test('accepts old numeric tokens during migration', () => {
    assert.deepStrictEqual(parsePlaybackToken('3'), {
      version: 0,
      libraryItemId: null,
      sessionId: null,
      trackIndex: 3,
      playbackId: null,
      trackStart: null,
      bookDuration: null
    });
  });

  test('rejects malformed tokens', () => {
    assert.strictEqual(parsePlaybackToken('abs1.not-base64'), null);
    assert.strictEqual(parsePlaybackToken(''), null);
    assert.strictEqual(parsePlaybackToken(0), null);
  });
});
