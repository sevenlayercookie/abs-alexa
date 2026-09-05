'use strict';
// Characterisation tests. These assert that the skill behaves the way it
// behaves today -- not that the behaviour is correct. A failure means
// something changed; look at the diff and decide whether you meant it.
//
// No network: requests are served from test/fixtures by a local stand-in for
// Audiobookshelf. Record fixtures with `npm run record`.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { scenarios } = require('./scenarios');
const { startServer } = require('./helpers/server-process');
const { loadSkill, invoke, intent, audioPlayer, playbackController, playerStateFrom, asUser } = require('./helpers/alexa');
const { matchSnapshot } = require('./helpers/snapshot');
const { playDirective, assertWellFormedStream, assertNotErrorResponse } = require('./helpers/assertions');
const { createPlaybackToken, parsePlaybackToken } = require('../lambda/lib/playback-token');
const fs = require('fs');
const path = require('path');

function recordedPlaySession(itemId) {
  const cassette = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'abs.json'), 'utf8'));
  const entry = cassette[`POST /api/items/${itemId}/play`];
  assert.ok(entry, `no recorded play session for ${itemId}`);
  return typeof entry.body === 'string' ? JSON.parse(entry.body) : entry.body;
}

describe('skill behaviour', () => {
  let srv;

  before(async () => {
    // Without fixtures every call fails and the snapshots would record nothing
    // but error states. Refuse to run rather than bank meaningless baselines.
    const cassette = path.join(__dirname, 'fixtures', 'abs.json');
    if (!fs.existsSync(cassette) || Object.keys(JSON.parse(fs.readFileSync(cassette, 'utf8'))).length === 0) {
      throw new Error(
        'No fixtures found at test/fixtures/abs.json.\n' +
        'Record them against a live Audiobookshelf server first:\n' +
        '  ABS_API_KEY=... SERVER_URL=http://host:port npm run record');
    }

    // the stand-in server runs in its own process; see helpers/server-main.js
    srv = await startServer('replay', 'abs');
    process.env.SERVER_URL = `http://127.0.0.1:${srv.port}`;
    process.env.ABS_API_KEY = 'TEST_API_KEY';
    process.env.USER_AGENT = 'AlexaSkill';
  });

  after(async () => { if (srv) await srv.close(); });

  test('system playback requests are modeled without conversational sessions', () => {
    assert.strictEqual(audioPlayer('PlaybackStarted').session, undefined);
    assert.strictEqual(playbackController('PlayCommandIssued').session, undefined);
  });

  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      // one skill instance per scenario: models a warm Lambda container across
      // the turns of a single conversation, a cold start between scenarios
      const skill = loadSkill();
      let attrs = {};
      let player = null;   // what the device has loaded; null until something plays
      for (const step of scenario.steps) {
        const res = await invoke(skill, step.make(attrs, player));
        assert.ok(res, `${step.label} returned no response`);

        // Snapshots record whatever happened; these say what a valid answer
        // looks like. Without them a Play directive with an undefined offset
        // gets banked as the baseline, which is how the "previous" bug hid.
        const label = `${scenario.name} -- ${step.label}`;
        const play = playDirective(res);
        if (play && !(scenario.expectMalformedStream || []).includes(step.label)) {
          assertWellFormedStream(play, label);
          if (((res.response || {}).outputSpeech)) {
            assert.strictEqual(res.response.shouldEndSession, true,
              `${label}: a voice intent that starts audio must end the conversational session`);
            assert.ok(JSON.stringify(res).length < 8192,
              `${label}: response should not carry the full ABS play session`);
            assert.strictEqual(res.sessionAttributes?.userPlaySession, undefined,
              `${label}: ended session should not return transient playback state`);
          }
        }
        if (!(scenario.expectErrors || []).includes(step.label)) assertNotErrorResponse(res, label);

        matchSnapshot(label, res);
        attrs = (res && res.sessionAttributes) || attrs;
        const p = playerStateFrom(res);
        if (p && p.token !== undefined) player = p;   // a Play directive means a stream is now loaded
      }
    });
  }

  test('device Play button needs a loaded stream when no state can be recovered', async () => {
    const playDirective = (res) =>
      ((res && res.response && res.response.directives) || []).find((d) => d.type === 'AudioPlayer.Play');

    // cold container: nothing played yet, so there is nothing to resume
    const cold = loadSkill();
    const coldRes = await invoke(cold, playbackController('PlayCommandIssued'));
    assert.strictEqual(playDirective(coldRes), undefined,
      'a cold container has no play session and should emit no Play directive');

    // warm container: a book played earlier in this container's life, so the
    // handler finds a play session and takes its main path
    const warm = loadSkill();
    const first = await invoke(warm, intent('PlayLastIntent', {}, {}, true));
    const warmRes = await invoke(warm,
      playbackController('PlayCommandIssued', undefined, playerStateFrom(first)));
    assert.ok(playDirective(warmRes),
      'the device Play button relies on state outliving the conversation');
  });

  test('device Play button emits a complete resumable stream', async () => {
    const warm = loadSkill();
    const first = await invoke(warm, intent('PlayLastIntent', {}, {}, true));
    const res = await invoke(warm,
      playbackController('PlayCommandIssued', undefined, playerStateFrom(first)));
    const play = ((res.response && res.response.directives) || [])
      .find((d) => d.type === 'AudioPlayer.Play');
    assertWellFormedStream(play, 'device Play button');
    assert.strictEqual(play.playBehavior, 'REPLACE_ALL');
  });

  test('seek and device chapter controls cross multi-track boundaries correctly', async () => {
    const skill = loadSkill();
    const dune = recordedPlaySession('5eb0cd4a-cae7-4b40-8f7f-75616b757e63');
    delete dune.libraryItem;

    const forward = await invoke(skill,
      intent('GoForwardXTimeIntent', { time: 'PT2M' },
        { userPlaySession: dune }, false,
        { token: 2, offsetInMilliseconds: 1200000 }));
    let stream = assertWellFormedStream(playDirective(forward), 'multi-track forward seek');
    assert.strictEqual(parsePlaybackToken(stream.token).trackIndex, 3);
    assert.ok(Math.abs(stream.offsetInMilliseconds - 65880) < 0.001);

    const restartChapter = await invoke(skill,
      playbackController('PreviousCommandIssued', undefined, playerStateFrom(forward)));
    stream = assertWellFormedStream(playDirective(restartChapter), 'multi-track previous chapter');
    assert.strictEqual(parsePlaybackToken(stream.token).trackIndex, 3);
    assert.strictEqual(stream.offsetInMilliseconds, 0);

    const previousChapter = await invoke(skill,
      playbackController('PreviousCommandIssued', undefined,
        { token: 3, offsetInMilliseconds: 0 }));
    stream = assertWellFormedStream(playDirective(previousChapter), 'multi-track prior chapter');
    assert.strictEqual(parsePlaybackToken(stream.token).trackIndex, 2);
    assert.strictEqual(stream.offsetInMilliseconds, 0);

    const nextChapter = await invoke(skill,
      playbackController('NextCommandIssued', undefined, playerStateFrom(previousChapter)));
    stream = assertWellFormedStream(playDirective(nextChapter), 'multi-track next chapter');
    assert.strictEqual(parsePlaybackToken(stream.token).trackIndex, 3);
    assert.strictEqual(stream.offsetInMilliseconds, 0);

    const numberedChapter = await invoke(skill,
      intent('GoToChapterX', { chapterNumber: '7' },
        { userPlaySession: dune }, false,
        { token: 1, offsetInMilliseconds: 0 }));
    stream = assertWellFormedStream(playDirective(numberedChapter), 'multi-track numbered chapter');
    assert.strictEqual(parsePlaybackToken(stream.token).trackIndex, 7);
    assert.ok(Math.abs(stream.offsetInMilliseconds - 28462.5) < 0.001);
    assert.match(numberedChapter.response.outputSpeech.ssml, /chapter 7/i);

    const back = await invoke(skill,
      intent('GoBackXTimeIntent', { time: 'PT1M' },
        { userPlaySession: dune }, false,
        { token: 2, offsetInMilliseconds: 30000 }));
    stream = assertWellFormedStream(playDirective(back), 'multi-track backward seek');
    assert.strictEqual(parsePlaybackToken(stream.token).trackIndex, 1);
    assert.ok(Math.abs(stream.offsetInMilliseconds - 1763952) < 0.001);
  });

  test('play failures reach the global error response', async () => {
    const skill = loadSkill();
    const malformedAttributes = { userPlaySession: { currentTime: 0 } };
    const res = await invoke(skill,
      intent('PlayLastIntent', {}, malformedAttributes, false));

    assert.match(
      (((res.response || {}).outputSpeech || {}).ssml || ''),
      /trouble doing what you asked/i);
  });

  test('pause still stops playback when progress cannot be recovered', async () => {
    const skill = loadSkill();
    const malformedAttributes = { userPlaySession: null, offsetInMilliseconds: 0 };
    const res = await invoke(skill,
      intent('AMAZON.PauseIntent', {}, malformedAttributes, false,
        { token: 1, offsetInMilliseconds: 0 }));

    assert.ok(((res.response || {}).directives || [])
      .some((directive) => directive.type === 'AudioPlayer.Stop'));
    assert.doesNotMatch(
      (((res.response || {}).outputSpeech || {}).ssml || ''),
      /trouble doing what you asked/i);
  });

  test('numbered chapter navigation validates the requested chapter', async () => {
    const skill = loadSkill();
    const first = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(first);

    const missing = await invoke(skill,
      intent('GoToChapterX', {}, {}, true, player));
    assert.strictEqual(playDirective(missing), undefined);
    assert.match(missing.response.outputSpeech.ssml, /between 1 and/i);

    const outOfRange = await invoke(skill,
      intent('GoToChapterX', { chapterNumber: '999999' }, {}, true, player));
    assert.strictEqual(playDirective(outOfRange), undefined);
    assert.match(outOfRange.response.outputSpeech.ssml, /between 1 and/i);
  });

  test('voice and device controls recover after a cold Lambda start', async () => {
    const warm = loadSkill();
    const first = await invoke(warm, intent('PlayLastIntent', {}, {}, true));
    const player = { ...playerStateFrom(first), offsetInMilliseconds: 0 };

    const coldForNext = loadSkill();
    const next = await invoke(coldForNext,
      intent('AMAZON.NextIntent', {}, {}, true, player));
    const nextStream = assertWellFormedStream(playDirective(next), 'cold-start next');
    assert.strictEqual(parsePlaybackToken(nextStream.token).libraryItemId,
      parsePlaybackToken(player.token).libraryItemId);

    const coldForChapter = loadSkill();
    const chapter = await invoke(coldForChapter,
      intent('GoToChapterX', { chapterNumber: '3' }, {}, true, player));
    const chapterStream = assertWellFormedStream(
      playDirective(chapter), 'cold-start numbered chapter');
    assert.strictEqual(parsePlaybackToken(chapterStream.token).libraryItemId,
      parsePlaybackToken(player.token).libraryItemId);

    const coldForPause = loadSkill();
    const pause = await invoke(coldForPause,
      intent('AMAZON.PauseIntent', {}, {}, true, player));
    assert.ok(((pause.response || {}).directives || [])
      .some((directive) => directive.type === 'AudioPlayer.Stop'));

    const coldForButton = loadSkill();
    const button = await invoke(coldForButton,
      playbackController('PlayCommandIssued', undefined, player));
    assertWellFormedStream(playDirective(button), 'cold-start device Play');
  });

  test('warm playback state is isolated by Alexa user', async () => {
    const skill = loadSkill();
    const first = await invoke(skill,
      asUser(intent('PlayLastIntent', {}, {}, true), 'amzn1.ask.account.USER_A'));
    const firstPlayer = { ...playerStateFrom(first), offsetInMilliseconds: 0 };

    const second = await invoke(skill,
      asUser(intent('PlayLastIntent', {}, {}, true), 'amzn1.ask.account.USER_B'));
    assert.match((second.response.outputSpeech || {}).ssml || '', /Playing/i,
      'the second user must open their own ABS session, not silently resume the first user cache');

    const recoveredFirst = await invoke(skill,
      asUser(intent('AMAZON.NextIntent', {}, {}, true, firstPlayer), 'amzn1.ask.account.USER_A'));
    assertWellFormedStream(playDirective(recoveredFirst), 'first user after second user playback');
  });

  test('RecentBooksIntent lists the three most recently listened-to books in order', async () => {
    const r = await invoke(loadSkill(), intent('RecentBooksIntent', {}, {}, true));
    const spoken = r.response.outputSpeech.ssml;
    const expected = [
      'The Lies of Locke Lamora by Scott Lynch',
      'Gentleman Bastard Book 2 - Red Seas under Red Skies by Scott Lynch',
      'The Butcher&apos;s Masquerade by Matt Dinniman',
    ];

    assert.match(spoken, /most recently listened to/i);
    for (const book of expected) assert.ok(spoken.includes(book), `missing recent book: ${book}`);
    assert.ok(spoken.includes(`; and ${expected[expected.length - 1]}`),
      'Alexa should say "and" before the final book');
    assert.ok(expected.every((book, index) =>
      index === 0 || spoken.indexOf(expected[index - 1]) < spoken.indexOf(book)),
    'recent books should retain the ordering returned by Audiobookshelf');
    assert.strictEqual(r.response.shouldEndSession, true);
    assert.strictEqual(playDirective(r), undefined);
  });

  test('a seek saves the old position and commits the destination only after playback starts', async () => {
    const skill = loadSkill();
    const first = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const oldPlayer = playerStateFrom(first);
    oldPlayer.offsetInMilliseconds += 5000;
    await invoke(skill, audioPlayer('PlaybackStarted', oldPlayer));
    await srv.clearRequests();

    const chapter = await invoke(skill,
      intent('GoToChapterX', { chapterNumber: '3' }, {}, true, oldPlayer));
    const newPlayer = playerStateFrom(chapter);
    assert.notStrictEqual(newPlayer.token, oldPlayer.token,
      'a replacement within the same audio file still needs a unique token');
    let writes = (await srv.getRequests()).filter((request) =>
      request.method === 'POST' && /\/api\/session\/[^/]+\/sync$/.test(request.url));

    assert.strictEqual(writes.length, 1, 'navigation should first save exactly one outgoing position');
    assert.ok(Math.abs(writes[0].body.currentTime - 81394.233038136) < 0.001);
    assert.strictEqual(writes[0].body.duration, 81423.743129);
    assert.ok(writes[0].body.timeListened >= 0);

    // REPLACE_ALL reports a stop for the old stream. That callback must not
    // overwrite the already-saved outgoing position.
    await invoke(skill, audioPlayer('PlaybackStopped', oldPlayer));
    writes = (await srv.getRequests()).filter((request) =>
      request.method === 'POST' && /\/api\/session\/[^/]+\/sync$/.test(request.url));
    assert.strictEqual(writes.length, 1, 'the expected old-stream stop should be deduplicated');

    await invoke(skill, audioPlayer('PlaybackStarted', newPlayer));
    writes = (await srv.getRequests()).filter((request) =>
      request.method === 'POST' && /\/api\/session\/[^/]+\/sync$/.test(request.url));
    assert.strictEqual(writes.length, 2, 'confirmed replacement playback should commit the destination');
    assert.ok(Math.abs(writes[1].body.currentTime - 4599.153) < 0.001);
    assert.strictEqual(writes[1].body.timeListened, 0,
      'seeking must not count skipped time as listened time');

    // Also cover the defensive ordering: a delayed old stop arriving after
    // replacement playback began is distinguishable by its unique token.
    await invoke(skill, audioPlayer('PlaybackStopped', oldPlayer));
    writes = (await srv.getRequests()).filter((request) =>
      request.method === 'POST' && /\/api\/session\/[^/]+\/sync$/.test(request.url));
    assert.strictEqual(writes.length, 2, 'a late old-stream stop must not undo the confirmed seek');
  });

  test('stop closes once and its PlaybackStopped callback cannot reopen or resync the session', async () => {
    const skill = loadSkill();
    const first = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(first);
    player.offsetInMilliseconds += 7000;
    await invoke(skill, audioPlayer('PlaybackStarted', player));
    await srv.clearRequests();

    const stopped = await invoke(skill,
      intent('AMAZON.StopIntent', {}, {}, true, player));
    assert.ok(((stopped.response || {}).directives || [])
      .some((directive) => directive.type === 'AudioPlayer.Stop'));
    await invoke(skill, audioPlayer('PlaybackStopped', player));

    const requests = await srv.getRequests();
    const closes = requests.filter((request) =>
      request.method === 'POST' && /\/api\/session\/[^/]+\/close$/.test(request.url));
    const syncs = requests.filter((request) =>
      request.method === 'POST' && /\/api\/session\/[^/]+\/sync$/.test(request.url));
    const replacementSessions = requests.filter((request) =>
      request.method === 'POST' && /\/api\/items\/[^/]+\/play$/.test(request.url));

    assert.strictEqual(closes.length, 1);
    assert.ok(Math.abs(closes[0].body.currentTime - 81396.233038136) < 0.001);
    assert.strictEqual(closes[0].body.duration, 81423.743129);
    assert.ok(closes[0].body.timeListened >= 0);
    assert.deepStrictEqual(syncs, [], 'the callback after a successful close must not sync again');
    assert.deepStrictEqual(replacementSessions, [], 'a status callback must never open a replacement session');
  });

  test('a failed queued stream saves and preserves the stream that is still playing', async () => {
    const skill = loadSkill();
    const dune = recordedPlaySession('5eb0cd4a-cae7-4b40-8f7f-75616b757e63');
    delete dune.libraryItem;
    const currentToken = createPlaybackToken(dune, 1);
    const currentPlayer = {
      token: currentToken,
      offsetInMilliseconds: 120000,
      playerActivity: 'PLAYING',
    };

    const nearlyFinished = await invoke(skill,
      audioPlayer('PlaybackNearlyFinished', currentPlayer,
        { userPlaySession: dune }));
    const queued = playDirective(nearlyFinished)?.audioItem?.stream;
    assert.ok(queued, 'expected the next Dune track to be enqueued');
    await srv.clearRequests();

    await invoke(skill, audioPlayer('PlaybackFailed', {
      token: queued.token,
      offsetInMilliseconds: 0,
      error: { type: 'MEDIA_ERROR_SERVICE_UNAVAILABLE' },
      currentPlaybackState: currentPlayer,
    }));

    const requests = await srv.getRequests();
    const syncs = requests.filter((request) => /\/sync$/.test(request.url));
    const closes = requests.filter((request) => /\/close$/.test(request.url));
    assert.strictEqual(syncs.length, 1);
    assert.ok(Math.abs(syncs[0].body.currentTime - 120) < 0.001,
      'the playing stream position, not the failed queued stream, should be saved');
    assert.deepStrictEqual(closes, [], 'failure of a queued stream must not close active playback');
  });

  test('unconfirmed playback adds no listening time, and a failed book search keeps it open', async () => {
    const skill = loadSkill();
    await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    await srv.clearRequests();

    const missing = await invoke(skill,
      intent('PlayBookIntent', { title: 'a book that does not exist anywhere' }, {}, true));
    assert.strictEqual(playDirective(missing), undefined);
    let closes = (await srv.getRequests()).filter((request) => /\/close$/.test(request.url));
    assert.deepStrictEqual(closes, [], 'an unsuccessful replacement search must not close playback');

    const stillResumable = await invoke(skill, playbackController('PlayCommandIssued'));
    assertWellFormedStream(playDirective(stillResumable), 'playback after failed replacement search');
    await srv.clearRequests();

    await invoke(skill,
      intent('PlayBookIntent', { title: 'the lies of locke lamora' }, {}, true));
    closes = (await srv.getRequests()).filter((request) => /\/close$/.test(request.url));
    assert.strictEqual(closes.length, 1, 'a valid replacement should close the outgoing session once');
    assert.strictEqual(closes[0].body.timeListened, 0,
      'a stream with no PlaybackStarted confirmation must not accrue listening time');
  });

  test('every request was served from a fixture', async () => {
    const misses = await srv.getMisses();
    assert.deepStrictEqual(misses, [],
      'The skill asked for endpoints with no recorded fixture.\n' +
      'Re-record against a live server with:  npm run record');
  });
});
