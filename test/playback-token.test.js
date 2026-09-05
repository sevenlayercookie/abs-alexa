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
      playbackId: null
    });
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
      });
  });

  test('accepts old numeric tokens during migration', () => {
    assert.deepStrictEqual(parsePlaybackToken('3'), {
      version: 0,
      libraryItemId: null,
      sessionId: null,
      trackIndex: 3
    });
  });

  test('rejects malformed tokens', () => {
    assert.strictEqual(parsePlaybackToken('abs1.not-base64'), null);
    assert.strictEqual(parsePlaybackToken(''), null);
    assert.strictEqual(parsePlaybackToken(0), null);
  });
});
