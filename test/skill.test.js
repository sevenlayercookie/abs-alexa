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

  // Reproduces a CloudWatch trace: a cold container received PlaybackFailed,
  // the ABS session named by the stream token had already been closed (HTTP
  // 404), and the position the device reported was discarded.
  test('a cold container saves progress when the ABS session is gone', async () => {
    const skill = loadSkill();
    const dune = recordedPlaySession('5eb0cd4a-cae7-4b40-8f7f-75616b757e63');
    // A session id ABS no longer holds open, as after a server restart or an
    // idle timeout.
    const token = createPlaybackToken(
      { libraryItemId: dune.libraryItemId, id: 'a-session-abs-has-forgotten' }, 1);
    await srv.clearRequests();

    // No session attributes and no prior turn: this skill instance has never
    // seen this stream, exactly like a fresh Lambda container.
    await invoke(skill, audioPlayer('PlaybackFailed', {
      token,
      offsetInMilliseconds: 754000,
      playerActivity: 'IDLE',
      error: { type: 'MEDIA_ERROR_INTERNAL_DEVICE_ERROR' },
    }));

    const requests = await srv.getRequests();
    const progress = requests.filter((request) =>
      request.method === 'PATCH' && request.url.startsWith('/api/me/progress/'));
    const replacementSessions = requests.filter((request) =>
      request.method === 'POST' && /\/api\/items\/[^/]+\/play$/.test(request.url));

    assert.strictEqual(progress.length, 1,
      'the device-reported position must reach ABS even with no play session');
    assert.strictEqual(progress[0].url, `/api/me/progress/${dune.libraryItemId}`);
    assert.ok(Math.abs(progress[0].body.currentTime - 754) < 0.001);
    assert.deepStrictEqual(replacementSessions, [],
      'saving progress must not open a play session and duplicate listening history');
  });

  test('closing a session suppresses the fallback for the same stream', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await invoke(skill, audioPlayer('PlaybackStarted', player));
    await invoke(skill, intent('AMAZON.StopIntent', {}, {}, true, player));
    await srv.clearRequests();

    // The same container, but the session is closed: a late callback for that
    // stream has nothing new to say and must not rewrite progress.
    await invoke(skill, audioPlayer('PlaybackStopped', player));

    const progress = (await srv.getRequests()).filter((request) =>
      request.method === 'PATCH' && request.url.startsWith('/api/me/progress/'));
    assert.deepStrictEqual(progress, [],
      'a callback for a session this container just closed must not sync again');
  });

  // Reproduces a device trace: playback started normally, ABS was restarted
  // two minutes in, and the sync and close that followed both returned 404
  // because ABS no longer held the session. Recovery succeeded here -- the
  // container was warm and still had the play session object -- so the
  // no-session fallback never ran and the position was lost.
  test('an ABS restart mid-playback still saves the position', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await invoke(skill, audioPlayer('PlaybackStarted', player));

    await srv.restartAbs();
    try {
      player.offsetInMilliseconds += 120000;
      // "Alexa, stop" reaches an AudioPlayer skill as AMAZON.PauseIntent.
      await invoke(skill, intent('AMAZON.PauseIntent', {}, {}, true, player));
      await srv.clearRequests();
      await invoke(skill, audioPlayer('PlaybackFinished', player));

      const requests = await srv.getRequests();
      const progress = requests.filter((request) =>
        request.method === 'PATCH' && request.url.startsWith('/api/me/progress/'));
      const sessionWrites = requests.filter((request) =>
        /\/api\/session\/[^/]+\/(sync|close)$/.test(request.url));

      assert.strictEqual(progress.length, 1,
        'a book position must reach ABS even after the play session is gone');
      assert.ok(progress[0].body.currentTime > 0);
      assert.deepStrictEqual(sessionWrites, [],
        'once ABS has 404ed a session, later events must not retry writes to it');
    } finally {
      await srv.restoreAbsSessions();
    }
  });

  // Reproduces a device trace: "Alexa, stop" reached a cold container after an
  // ABS restart. Recovery could not find the session, so it opened a
  // replacement purely to record a position -- exactly the duplicate entry in
  // ABS listening history this work set out to remove.
  test('pausing on a cold container saves the position without opening a session', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    const itemId = parsePlaybackToken(player.token).libraryItemId;

    await srv.restartAbs();
    try {
      // A fresh container: nothing but the stream token survives.
      const cold = loadSkill();
      player.offsetInMilliseconds += 120000;
      await srv.clearRequests();
      const paused = await invoke(cold, intent('AMAZON.PauseIntent', {}, {}, true, player));

      assert.ok(((paused.response || {}).directives || [])
        .some((directive) => directive.type === 'AudioPlayer.Stop'),
        'pausing must still stop the device');

      const requests = await srv.getRequests();
      const progress = requests.filter((request) =>
        request.method === 'PATCH' && request.url.startsWith('/api/me/progress/'));
      const newSessions = requests.filter((request) =>
        request.method === 'POST' && /\/api\/items\/[^/]+\/play$/.test(request.url));

      assert.strictEqual(progress.length, 1, 'the paused position must still reach ABS');
      assert.strictEqual(progress[0].url, `/api/me/progress/${itemId}`);
      assert.ok(progress[0].body.currentTime > 0);
      assert.deepStrictEqual(newSessions, [],
        'recording a paused position must not open a play session');
    } finally {
      await srv.restoreAbsSessions();
    }
  });

  // Seen in a device trace: switching books after an ABS restart logged
  // "ABS session unavailable" and went straight to the search, so the outgoing
  // book's position was never written anywhere.
  test('switching books saves the outgoing position when its session is gone', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    const outgoingId = parsePlaybackToken(player.token).libraryItemId;

    await srv.restartAbs();
    try {
      const cold = loadSkill();
      player.offsetInMilliseconds += 120000;
      await srv.clearRequests();
      const switched = await invoke(cold,
        intent('PlayBookIntent', { title: 'the lies of locke lamora' }, {}, true, player));
      assertWellFormedStream(playDirective(switched), 'the replacement book');

      const progress = (await srv.getRequests()).filter((request) =>
        request.method === 'PATCH'
        && request.url === `/api/me/progress/${outgoingId}`);
      assert.strictEqual(progress.length, 1,
        'the outgoing book position must be saved before the new one starts');
      assert.ok(progress[0].body.currentTime > 0);
    } finally {
      await srv.restoreAbsSessions();
    }
  });

  // ABS listening history held a 15975-second entry -- four and a half hours --
  // for a book that had been playing for seconds. A session recovered from ABS
  // carries ABS's own updatedAt, and the age of that timestamp was being
  // reported as time the user spent listening. Listening time is now bounded by
  // the distance actually travelled through the book, so a stale timestamp
  // cannot inflate it past what the position can justify.
  test('a stale session timestamp cannot inflate listening time', async () => {
    const skill = loadSkill();
    const dune = recordedPlaySession('5eb0cd4a-cae7-4b40-8f7f-75616b757e63');
    delete dune.libraryItem;
    // As ABS would return it: last touched hours ago, and never confirmed
    // playing by this container.
    dune.updatedAt = Date.now() - 4.5 * 60 * 60 * 1000;
    delete dune.alexaListeningStartedAt;
    delete dune.alexaPlaybackConfirmed;
    await srv.clearRequests();

    await invoke(skill, audioPlayer('PlaybackStopped', {
      token: createPlaybackToken(dune, 1),
      offsetInMilliseconds: 30000,
    }, { userPlaySession: dune }));

    const syncs = (await srv.getRequests()).filter((request) => /\/sync$/.test(request.url));
    assert.strictEqual(syncs.length, 1);
    // The session sat at 0 and the device is 30 seconds in, so 30 seconds is
    // all the listening the position can account for -- not the 16200 the
    // stale timestamp suggests.
    assert.strictEqual(syncs[0].body.timeListened, 30,
      'listening time must be capped by the progress made through the book');
  });

  test('listening time never exceeds the progress made through the book', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await invoke(skill, audioPlayer('PlaybackStarted', player));
    await srv.clearRequests();

    // A cold container has none of the timing this one recorded, so it has to
    // infer the interval; it must still not claim more than the position moved.
    const cold = loadSkill();
    player.offsetInMilliseconds += 45000;
    await invoke(cold, audioPlayer('PlaybackStopped', player));

    const syncs = (await srv.getRequests()).filter((request) => /\/sync$/.test(request.url));
    assert.strictEqual(syncs.length, 1, 'a real listening interval must still be reported');
    assert.ok(syncs[0].body.timeListened > 0,
      'a cold container must not silently drop a real listening interval');
    assert.ok(syncs[0].body.timeListened <= 45,
      `listening time ${syncs[0].body.timeListened} exceeds the 45 seconds of book travelled`);
  });

  // A transient 502 from the media server handed Alexa an HTML error page
  // instead of audio. The device failed the stream and reported offset 0, and
  // that 0 was written to ABS -- closing a 22-hour audiobook at the beginning
  // and losing the listener's place.
  test('a failed stream cannot rewind the book', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await invoke(skill, audioPlayer('PlaybackStarted', player));
    const startedAt = parsePlaybackToken(player.token);
    assert.ok(player.offsetInMilliseconds > 0,
      'this fixture must start mid-book for the test to mean anything');
    await srv.clearRequests();

    // The device could not play the stream and reports nothing useful.
    await invoke(skill, audioPlayer('PlaybackFailed', {
      token: player.token,
      offsetInMilliseconds: 0,
      playerActivity: 'IDLE',
      error: { type: 'MEDIA_ERROR_INTERNAL_DEVICE_ERROR' },
    }));

    const writes = (await srv.getRequests()).filter((request) =>
      /\/(sync|close)$/.test(request.url) || request.url.startsWith('/api/me/progress/'));
    assert.ok(writes.length > 0, 'a failed stream should still settle the session');
    for (const write of writes) {
      assert.ok(write.body.currentTime > 0,
        `a failed stream wrote currentTime=${write.body.currentTime}, sending the listener to the start of ${startedAt.libraryItemId}`);
    }
  });

  test('every request was served from a fixture', async () => {
    const misses = await srv.getMisses();
    assert.deepStrictEqual(misses, [],
      'The skill asked for endpoints with no recorded fixture.\n' +
      'Re-record against a live server with:  npm run record');
  });
});
