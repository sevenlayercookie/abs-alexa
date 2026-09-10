'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { startServer } = require('./helpers/server-process');
const { loadSkill, invoke, intent, audioPlayer, playbackController, playerStateFrom } = require('./helpers/alexa');
const { playDirective } = require('./helpers/assertions');
const { parsePlaybackToken, createPlaybackToken } = require('../lambda/lib/playback-token');

function recordedPlaySession(itemId) {
  const cassette = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'abs.json'), 'utf8'));
  const entry = cassette[`POST /api/items/${itemId}/play`];
  assert.ok(entry, `no recorded play session for ${itemId}`);
  return typeof entry.body === 'string' ? JSON.parse(entry.body) : entry.body;
}

describe('proxy mode playback', () => {
  let srv;

  before(async () => {
    srv = await startServer('replay', 'abs');
    process.env.SERVER_URL = `http://127.0.0.1:${srv.port}`;
    process.env.ABS_API_KEY = 'TEST_API_KEY';
    process.env.USER_AGENT = 'AlexaSkill';
    process.env.USE_PROXY = 'true';
  });

  after(async () => {
    delete process.env.USE_PROXY;
    delete process.env.PROXY_MODE;
    if (srv) await srv.close();
  });

  beforeEach(async () => {
    if (srv) await srv.clearRequests();
  });

  test('PlayAudioIntent / PlayLastIntent starts stream at directive offset 0 with proxyTranscode and startTime in URL and token', async () => {
    const skill = loadSkill();
    const res = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const play = playDirective(res);
    assert.ok(play, 'expected AudioPlayer.Play directive');
    assert.strictEqual(play.playBehavior, 'REPLACE_ALL');

    const stream = play.audioItem.stream;
    assert.strictEqual(stream.offsetInMilliseconds, 0, 'AudioPlayer offset must be 0 in proxy mode');
    assert.match(stream.url, /proxyTranscode=true/);
    assert.match(stream.url, /startTime=81389\.233/);
    assert.match(stream.url, /token=TEST_API_KEY/);

    const token = parsePlaybackToken(stream.token);
    assert.ok(token);
    assert.strictEqual(token.startTime, 81389.233038136);
  });

  test('PlaybackStarted confirms playback at absolute position in proxy mode', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await srv.clearRequests();

    await invoke(skill, audioPlayer('PlaybackStarted', player));
    const syncs = (await srv.getRequests()).filter((r) => /\/sync$/.test(r.url));
    assert.strictEqual(syncs.length, 1);
    assert.strictEqual(syncs[0].body.currentTime, 81389.233038136);
    assert.strictEqual(syncs[0].body.timeListened, 0);
  });

  test('PlaybackStopped syncs absolute position = startTime + streamOffset / 1000', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await invoke(skill, audioPlayer('PlaybackStarted', player));
    await srv.clearRequests();

    // Echo played 30 seconds of the stream instance
    player.offsetInMilliseconds = 30000;
    await invoke(skill, audioPlayer('PlaybackStopped', player));

    const syncs = (await srv.getRequests()).filter((r) => /\/sync$/.test(r.url));
    assert.strictEqual(syncs.length, 1);
    const expectedTime = 81389.233038136 + 30;
    assert.strictEqual(syncs[0].body.currentTime, expectedTime);
  });

  test('AMAZON.PauseIntent pauses and syncs absolute position factoring in stream startTime', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await invoke(skill, audioPlayer('PlaybackStarted', player));
    await srv.clearRequests();

    // Echo played 20 seconds of the stream instance
    player.offsetInMilliseconds = 20000;
    const res = await invoke(skill, intent('AMAZON.PauseIntent', {}, {}, false, player));
    const stop = ((res.response && res.response.directives) || []).find((d) => d.type === 'AudioPlayer.Stop');
    assert.ok(stop, 'expected AudioPlayer.Stop directive');

    const syncs = (await srv.getRequests()).filter((r) => /\/sync$/.test(r.url));
    assert.strictEqual(syncs.length, 1);
    const expectedTime = 81389.233038136 + 20;
    assert.strictEqual(syncs[0].body.currentTime, expectedTime);
  });

  test('GoForwardXTimeIntent issues REPLACE_ALL at directive offset 0 with updated startTime', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await invoke(skill, audioPlayer('PlaybackStarted', player));
    await srv.clearRequests();

    // Echo reports 5s into current stream, user skips 10 seconds forward
    player.offsetInMilliseconds = 5000;
    const res = await invoke(skill, intent('GoForwardXTimeIntent', { time: 'PT10S' }, {}, false, player));
    const play = playDirective(res);
    assert.ok(play);
    assert.strictEqual(play.playBehavior, 'REPLACE_ALL');

    const stream = play.audioItem.stream;
    assert.strictEqual(stream.offsetInMilliseconds, 0, 'AudioPlayer offset must be 0 after seek');

    const expectedNewTime = 81389.233038136 + 5 + 10;
    const roundedTime = Math.round(expectedNewTime * 1000) / 1000;
    assert.match(stream.url, new RegExp(`startTime=${roundedTime}`));
    assert.match(stream.url, /proxyTranscode=true/);

    const token = parsePlaybackToken(stream.token);
    assert.strictEqual(token.startTime, expectedNewTime);
  });

  test('GoBackXTimeIntent issues REPLACE_ALL at directive offset 0 with updated startTime', async () => {
    const skill = loadSkill();
    const played = await invoke(skill, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await invoke(skill, audioPlayer('PlaybackStarted', player));
    await srv.clearRequests();

    // Echo reports 40s into stream, user skips 20s back
    player.offsetInMilliseconds = 40000;
    const res = await invoke(skill, intent('GoBackXTimeIntent', { time: 'PT20S' }, {}, false, player));
    const play = playDirective(res);
    assert.ok(play);
    assert.strictEqual(play.playBehavior, 'REPLACE_ALL');

    const stream = play.audioItem.stream;
    assert.strictEqual(stream.offsetInMilliseconds, 0, 'AudioPlayer offset must be 0 after seek');

    const expectedNewTime = 81389.233038136 + 40 - 20;
    const roundedTime = Math.round(expectedNewTime * 1000) / 1000;
    assert.match(stream.url, new RegExp(`startTime=${roundedTime}`));
    assert.match(stream.url, /proxyTranscode=true/);

    const token = parsePlaybackToken(stream.token);
    assert.strictEqual(token.startTime, expectedNewTime);
  });

  test('cold container recovers startTime from token and syncs correct position on pause', async () => {
    const warm = loadSkill();
    const played = await invoke(warm, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(played);
    await invoke(warm, audioPlayer('PlaybackStarted', player));
    await srv.clearRequests();

    // Cold container receives pause request with token that carries startTime
    player.offsetInMilliseconds = 18000;
    const cold = loadSkill();
    const res = await invoke(cold, intent('AMAZON.PauseIntent', {}, {}, false, player));
    const stop = ((res.response && res.response.directives) || []).find((d) => d.type === 'AudioPlayer.Stop');
    assert.ok(stop);

    const syncs = (await srv.getRequests()).filter((r) => /\/sync$/.test(r.url));
    assert.strictEqual(syncs.length, 1);
    const expectedTime = 81389.233038136 + 18;
    assert.strictEqual(syncs[0].body.currentTime, expectedTime);
  });

  test('multi-track PlaybackNearlyFinished enqueues next track with directive offset 0 and startTime 0', async () => {
    const skill = loadSkill();
    const dune = recordedPlaySession('5eb0cd4a-cae7-4b40-8f7f-75616b757e63');
    delete dune.libraryItem;

    const currentToken = createPlaybackToken(dune, 1, 'inst-proxy', 100);
    const currentPlayer = {
      token: currentToken,
      offsetInMilliseconds: 60000,
      playerActivity: 'PLAYING',
    };

    const nearlyFinished = await invoke(skill,
      audioPlayer('PlaybackNearlyFinished', currentPlayer, { userPlaySession: dune }));
    const queued = playDirective(nearlyFinished)?.audioItem?.stream;
    assert.ok(queued, 'expected the next Dune track to be enqueued');
    assert.strictEqual(queued.offsetInMilliseconds, 0);
    assert.match(queued.url, /proxyTranscode=true/);
    assert.match(queued.url, /startTime=0/);

    const queuedToken = parsePlaybackToken(queued.token);
    assert.strictEqual(queuedToken.trackIndex, 2);
    assert.strictEqual(queuedToken.startTime, 0);
  });

  test('PlaybackController PlayCommandIssued starts stream at directive offset 0 with proxy transcode', async () => {
    const warm = loadSkill();
    const first = await invoke(warm, intent('PlayLastIntent', {}, {}, true));
    const warmRes = await invoke(warm,
      playbackController('PlayCommandIssued', undefined, playerStateFrom(first)));
    const play = playDirective(warmRes);
    assert.ok(play);
    assert.strictEqual(play.audioItem.stream.offsetInMilliseconds, 0);
    assert.match(play.audioItem.stream.url, /proxyTranscode=true/);
    assert.match(play.audioItem.stream.url, /startTime=81389\.233/);
  });

  test('PlayBookIntent in proxy mode closes previous session with startTime and starts new book at offset 0', async () => {
    const warm = loadSkill();
    const first = await invoke(warm, intent('PlayLastIntent', {}, {}, true));
    const player = playerStateFrom(first);
    await invoke(warm, audioPlayer('PlaybackStarted', player));
    await srv.clearRequests();

    player.offsetInMilliseconds = 25000;
    const switched = await invoke(warm, intent('PlayBookIntent', { title: 'the lies of locke lamora' }, {}, true, player));
    const play = playDirective(switched);
    assert.ok(play);
    assert.strictEqual(play.audioItem.stream.offsetInMilliseconds, 0);
    assert.match(play.audioItem.stream.url, /proxyTranscode=true/);

    const closes = (await srv.getRequests()).filter((r) => /\/close$/.test(r.url));
    assert.strictEqual(closes.length, 1, 'previous session should be closed');
    const expectedPrevTime = 81389.233038136 + 25;
    assert.strictEqual(closes[0].body.currentTime, expectedPrevTime);
  });
});
