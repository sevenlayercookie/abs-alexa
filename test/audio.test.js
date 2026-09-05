'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  getCurrentTrackByBookTime,
  getCurrentChapterByBookTime,
  getTrackAndOffsetFromBookTime,
} = require('../lambda/lib/audio');

function multiTrackSession() {
  const cassette = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'abs.json'), 'utf8'));
  const entry = Object.entries(cassette).find(([key]) =>
    key === 'POST /api/items/5eb0cd4a-cae7-4b40-8f7f-75616b757e63/play');
  assert.ok(entry, 'the recorded multi-track play session is missing');
  return typeof entry[1].body === 'string' ? JSON.parse(entry[1].body) : entry[1].body;
}

describe('multi-track playback arithmetic', () => {
  test('maps absolute book time to a track-relative offset', () => {
    const session = multiTrackSession();
    assert.ok(session.audioTracks.length > 1, 'fixture must contain multiple tracks');
    const secondTrack = session.audioTracks[1];
    const bookTime = secondTrack.startOffset + 42;

    const result = getTrackAndOffsetFromBookTime(bookTime, session);

    assert.strictEqual(result.currentTrack, secondTrack);
    assert.strictEqual(result.goalOffset, 42000);
  });

  test('finds the correct track on both sides of a track boundary', () => {
    const session = multiTrackSession();
    const secondTrack = session.audioTracks[1];

    assert.strictEqual(
      getCurrentTrackByBookTime(secondTrack.startOffset - 0.001, session),
      session.audioTracks[0]);
    assert.strictEqual(
      getCurrentTrackByBookTime(secondTrack.startOffset, session),
      secondTrack);
  });

  test('selects the new chapter at an exact chapter boundary', () => {
    const session = multiTrackSession();
    const secondChapter = session.chapters[1];

    assert.strictEqual(
      getCurrentChapterByBookTime(secondChapter.start, session),
      secondChapter);
  });
});
