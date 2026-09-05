'use strict';
// Comprehensive end-to-end coverage of every implemented intent, against a real
// Audiobookshelf server, checking not just that a directive is returned but that
// the audio stream it points at actually plays.
//
// Opt-in, because it needs credentials and network:
//
//   LIVE=1 npm test
//
// Credentials come from lambda/config.js or the environment, same as the skill.
// It exercises one book repeatedly and will move that book's listening position,
// so point BOOK_TITLE at something you do not mind disturbing.
//
// The fixture-based suite in skill.test.js stays the fast default; this is the
// one that answers "would a real Echo actually play sound".

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const A = require('./helpers/alexa');
const { parsePlaybackToken } = require('../lambda/lib/playback-token');

const BOOK = process.env.BOOK_TITLE || 'the lies of locke lamora';

function credentials() {
  let file = {};
  try { file = require(path.join(__dirname, '..', 'lambda', 'config.js')); } catch { /* optional */ }
  const key = process.env.ABS_API_KEY || file.ABS_API_KEY;
  const url = process.env.SERVER_URL || file.SERVER_URL;
  const usable = key && url && key !== 'xxxxxx' && !/abs\.domain\.tld/.test(url);
  return { key, url, usable };
}

const cred = credentials();
const why = !process.env.LIVE
  ? 'set LIVE=1 to run (hits a real server and moves listening position)'
  : !cred.usable
    ? 'no usable ABS_API_KEY / SERVER_URL in the environment or lambda/config.js'
    : false;

// Headers for direct Audiobookshelf calls made by the test itself (saving and
// restoring position), including the Cloudflare Access token when configured.
function absHeaders() {
  let file = {};
  try { file = require(path.join(__dirname, '..', 'lambda', 'config.js')); } catch { /* optional */ }
  const h = { Authorization: `Bearer ${cred.key}` };
  const id = process.env.CFAccessClientId || file.CFAccessClientId;
  const secret = process.env.CFAccessClientSecret || file.CFAccessClientSecret;
  if (id && secret) { h['CF-Access-Client-Id'] = id; h['CF-Access-Client-Secret'] = secret; }
  return h;
}

const playOf = (res) => ((((res || {}).response) || {}).directives || [])
  .find((d) => d.type === 'AudioPlayer.Play');

describe('live: every implemented intent', { skip: why }, () => {
  let skill;
  let restore = null;   // { itemId, currentTime } captured before anything moves

  before(async () => {
    process.env.ABS_API_KEY = cred.key;
    process.env.SERVER_URL = cred.url;
    skill = A.loadSkill();

    // These tests skip chapters and seek around, which writes the new position
    // back to Audiobookshelf. Record where the book actually was so it can be
    // put back afterwards, rather than requiring a book you do not mind losing
    // your place in.
    const first = await A.invoke(skill, A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    const url = (((playOf(first) || {}).audioItem || {}).stream || {}).url || '';
    const m = url.match(/\/api\/items\/([0-9a-f-]+)\//);
    if (!m) return;
    const itemId = m[1];
    const res = await fetch(`${cred.url}/api/me/progress/${itemId}`, { headers: absHeaders() });
    if (!res.ok) return;
    const body = await res.json();
    if (typeof body.currentTime === 'number') {
      restore = { itemId, currentTime: body.currentTime };
      console.log('      saved position: %ss in %s', Math.round(restore.currentTime), itemId);
    }
  });

  after(async () => {
    if (!restore) return;
    const res = await fetch(`${cred.url}/api/me/progress/${restore.itemId}`, {
      method: 'PATCH',
      headers: { ...absHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentTime: restore.currentTime }),
    });
    console.log('      restored position: %ss (HTTP %d)', Math.round(restore.currentTime), res.status);
  });

  const invoke = (env) => A.invoke(skill, env);
  const play = (res) => ((((res || {}).response) || {}).directives || [])
    .find((d) => d.type === 'AudioPlayer.Play');
  const stop = (res) => ((((res || {}).response) || {}).directives || [])
    .find((d) => d.type === 'AudioPlayer.Stop');
  const speech = (res) => (((((res || {}).response) || {}).outputSpeech) || {}).ssml || '';

  // The assertion that matters: the URL in the directive really serves audio.
  async function assertPlayable(directive, label) {
    assert.ok(directive, `${label}: expected an AudioPlayer.Play directive`);
    const s = directive.audioItem && directive.audioItem.stream;
    assert.ok(s, `${label}: directive has no stream`);
    assert.ok(typeof s.url === 'string' && s.url.startsWith('http'), `${label}: stream url missing`);
    assert.match(s.url, /\/api\/items\/[0-9a-f-]+\/file\//, `${label}: url is not an ABS item file`);
    assert.match(s.url, /[?&]token=/, `${label}: url carries no auth token`);
    assert.ok(typeof s.token === 'string' && s.token.length > 0, `${label}: no string stream token`);
    assert.ok(Number.isFinite(s.offsetInMilliseconds) && s.offsetInMilliseconds >= 0,
      `${label}: offset is not a sane number (${s.offsetInMilliseconds})`);

    const res = await fetch(s.url, { headers: { Range: 'bytes=0-2047' } });
    assert.ok([200, 206].includes(res.status), `${label}: stream returned HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    assert.match(ct, /^(audio|video|application\/octet-stream)/, `${label}: content-type was "${ct}"`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 0, `${label}: stream returned no bytes`);
    return { url: s.url, offset: s.offsetInMilliseconds, bytes: bytes.length, ct };
  }

  // --- intents that must produce playable audio ------------------------------

  test('PlayBookIntent by title returns a playable stream', async () => {
    const r = await invoke(A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    const info = await assertPlayable(play(r), 'PlayBookIntent(title)');
    assert.match(speech(r), /Playing/i);
    console.log('      offset %dms, %s, %d bytes', info.offset, info.ct, info.bytes);
  });

  test('PlayBookIntent with title and author returns a playable stream', async () => {
    const r = await invoke(A.intent('PlayBookIntent', { title: BOOK, author: 'scott lynch' }, {}, true));
    await assertPlayable(play(r), 'PlayBookIntent(title+author)');
  });

  test('PlayLastIntent returns a playable stream', async () => {
    const r = await invoke(A.intent('PlayLastIntent', {}, {}, true));
    await assertPlayable(play(r), 'PlayLastIntent');
  });

  test('AMAZON.ResumeIntent returns a playable stream', async () => {
    const r = await invoke(A.intent('AMAZON.ResumeIntent', {}, {}, true));
    await assertPlayable(play(r), 'ResumeIntent');
  });

  // --- navigation, which needs an established session ------------------------

  test('chapter navigation and seek all return playable streams in a session', async () => {
    let attrs = {}, player = null;
    const step = async (label, env) => {
      const r = await invoke(env);
      attrs = (r && r.sessionAttributes) || attrs;
      const p = A.playerStateFrom(r);
      if (p && p.token !== undefined) player = p;
      return r;
    };
    await step('play', A.intent('PlayBookIntent', { title: BOOK }, {}, true));

    // The book resumes wherever it was last left, which may be the final
    // chapter -- where "next" correctly declines instead of playing. Move an
    // hour back first so next and previous both have somewhere to go, making
    // this test independent of the saved position.
    await step('rewind', A.intent('GoBackXTimeIntent', { time: 'PT1H' }, attrs, false, player));

    const next = await step('next', A.intent('AMAZON.NextIntent', {}, attrs, false, player));
    await assertPlayable(play(next), 'NextIntent');

    const prev = await step('previous', A.intent('AMAZON.PreviousIntent', {}, attrs, false, player));
    await assertPlayable(play(prev), 'PreviousIntent');

    const chapter = await step(
      'chapter', A.intent('GoToChapterX', { chapterNumber: '3' }, attrs, false, player));
    await assertPlayable(play(chapter), 'GoToChapterX');
    assert.match(speech(chapter), /chapter 3/i);

    const fwd = await step('forward', A.intent('GoForwardXTimeIntent', { time: 'PT2M' }, attrs, false, player));
    await assertPlayable(play(fwd), 'GoForwardXTimeIntent');

    const back = await step('back', A.intent('GoBackXTimeIntent', { time: 'PT30S' }, attrs, false, player));
    await assertPlayable(play(back), 'GoBackXTimeIntent');
  });

  test('ABS progress follows confirmed playback and is not overwritten by replacement stop events', async () => {
    skill = A.loadSkill();
    const first = await invoke(A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    const oldPlayer = A.playerStateFrom(first);
    await invoke(A.audioPlayer('PlaybackStarted', oldPlayer));

    const chapter = await invoke(A.intent(
      'GoToChapterX', { chapterNumber: '3' }, {}, true, oldPlayer));
    const newPlayer = A.playerStateFrom(chapter);
    assert.notStrictEqual(newPlayer.token, oldPlayer.token,
      'same-file replacement playback should have a distinct token');
    const token = parsePlaybackToken(newPlayer.token);
    assert.ok(token?.libraryItemId && token?.sessionId, 'playback token lacks ABS recovery data');

    // This is the order Alexa produces for REPLACE_ALL: old stream stops, then
    // replacement starts. Only PlaybackStarted confirms that the seek happened.
    await invoke(A.audioPlayer('PlaybackStopped', oldPlayer));
    await invoke(A.audioPlayer('PlaybackStarted', newPlayer));
    await invoke(A.audioPlayer('PlaybackStopped', oldPlayer));

    const confirmed = await fetch(`${cred.url}/api/me/progress/${token.libraryItemId}`, {
      headers: absHeaders(),
    });
    assert.ok(confirmed.ok, `progress lookup returned HTTP ${confirmed.status}`);
    const confirmedProgress = await confirmed.json();
    assert.ok(Math.abs(confirmedProgress.currentTime - 4599.153) < 1,
      `ABS stored ${confirmedProgress.currentTime}s instead of chapter 3 at 4599.153s`);

    const stopped = await invoke(A.intent('AMAZON.StopIntent', {}, {}, true, newPlayer));
    assert.ok(stop(stopped), 'stop should emit AudioPlayer.Stop');
    await invoke(A.audioPlayer('PlaybackStopped', newPlayer));

    const afterStop = await fetch(`${cred.url}/api/me/progress/${token.libraryItemId}`, {
      headers: absHeaders(),
    });
    assert.ok(afterStop.ok, `post-stop progress lookup returned HTTP ${afterStop.status}`);
    const stoppedProgress = await afterStop.json();
    assert.ok(Math.abs(stoppedProgress.currentTime - 4599.153) < 1,
      `the stop callback moved ABS progress to ${stoppedProgress.currentTime}s`);
  });

  test('next in the final chapter declines instead of throwing', async () => {
    const first = await invoke(A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    let attrs = first.sessionAttributes || {};
    let player = A.playerStateFrom(first);
    // jump to the very end: forward far beyond the book's length lands in the
    // last chapter regardless of where it resumed
    const end = await invoke(A.intent('GoForwardXTimeIntent', { time: 'PT24H' }, attrs, false, player));
    attrs = end.sessionAttributes || attrs;
    const p2 = A.playerStateFrom(end);
    const r = await invoke(A.intent('AMAZON.NextIntent', {}, attrs, false, p2 || player));
    assert.doesNotMatch(speech(r), /trouble doing what you asked/i,
      'next in the final chapter should not hit the generic error handler');
  });

  test('controls recover from the stream token after a cold Lambda start', async () => {
    const first = await invoke(A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    const player = { ...A.playerStateFrom(first), offsetInMilliseconds: 0 };

    const invokeCold = async (envelope) => {
      skill = A.loadSkill();
      const response = await invoke(envelope);
      assert.strictEqual(response.sessionAttributes?.userPlaySession, undefined,
        'cold-start response must not depend on returned Alexa session attributes');
      return response;
    };

    const next = await invokeCold(A.intent('AMAZON.NextIntent', {}, {}, true, player));
    await assertPlayable(play(next), 'cold-start NextIntent');

    const previousPlayer = { ...A.playerStateFrom(next), offsetInMilliseconds: 0 };
    const previous = await invokeCold(
      A.intent('AMAZON.PreviousIntent', {}, {}, true, previousPlayer));
    await assertPlayable(play(previous), 'cold-start PreviousIntent');

    const forward = await invokeCold(
      A.intent('GoForwardXTimeIntent', { time: 'PT2M' }, {}, true, player));
    await assertPlayable(play(forward), 'cold-start GoForwardXTimeIntent');

    const chapter = await invokeCold(
      A.intent('GoToChapterX', { chapterNumber: '3' }, {}, true, player));
    await assertPlayable(play(chapter), 'cold-start GoToChapterX');

    const backward = await invokeCold(
      A.intent('GoBackXTimeIntent', { time: 'PT30S' }, {}, true, A.playerStateFrom(forward)));
    await assertPlayable(play(backward), 'cold-start GoBackXTimeIntent');

    const paused = await invokeCold(A.intent('AMAZON.PauseIntent', {}, {}, true, player));
    assert.ok(stop(paused), 'cold-start pause should emit AudioPlayer.Stop');

    const devicePlay = await invokeCold(
      A.playbackController('PlayCommandIssued', undefined, player));
    await assertPlayable(play(devicePlay), 'cold-start device Play');

    const deviceNext = await invokeCold(
      A.playbackController('NextCommandIssued', undefined, player));
    await assertPlayable(play(deviceNext), 'cold-start device Next');

    const devicePrevious = await invokeCold(
      A.playbackController('PreviousCommandIssued', undefined,
        { ...A.playerStateFrom(deviceNext), offsetInMilliseconds: 0 }));
    await assertPlayable(play(devicePrevious), 'cold-start device Previous');

    const devicePause = await invokeCold(
      A.playbackController('PauseCommandIssued', undefined, player));
    assert.ok(stop(devicePause), 'cold-start device Pause should emit AudioPlayer.Stop');
  });

  test('active playback survives SessionEndedRequest', async () => {
    skill = A.loadSkill();
    const first = await invoke(A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    const player = A.playerStateFrom(first);

    const ended = await invoke(A.sessionEnded('ERROR', {}, {
      ...player,
      playerActivity: 'PLAYING'
    }));
    assert.ok(ended, 'active SessionEndedRequest returned no response');

    // No session attributes and no player token are supplied here. This can
    // succeed only if SessionEndedRequest retained the warm playback state.
    const resumed = await invoke(A.playbackController('PlayCommandIssued'));
    await assertPlayable(play(resumed), 'device Play after active SessionEndedRequest');
  });

  // --- intents that must stop audio -----------------------------------------

  test('pause stops playback', async () => {
    let attrs = {}, player = null;
    const first = await invoke(A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    attrs = first.sessionAttributes || {};
    player = A.playerStateFrom(first);
    const r = await invoke(A.intent('AMAZON.PauseIntent', {}, attrs, false, player));
    assert.ok(stop(r), 'pause should emit AudioPlayer.Stop');
  });

  for (const name of ['AMAZON.StopIntent', 'AMAZON.CancelIntent']) {
    test(`${name} stops and says goodbye`, async () => {
      const r = await invoke(A.intent(name, {}, {}, true));
      assert.ok(stop(r), `${name} should emit AudioPlayer.Stop`);
      assert.match(speech(r), /goodbye/i);
    });
  }

  // --- intents that speak but must not throw ---------------------------------

  test('LaunchRequest greets without audio', async () => {
    const r = await invoke(A.launch());
    assert.match(speech(r), /audiobookshelf/i);
    assert.strictEqual(play(r), undefined, 'launch should not start audio');
  });

  test('HelpIntent explains itself', async () => {
    const r = await invoke(A.intent('AMAZON.HelpIntent', {}, {}, true));
    assert.ok(speech(r).length > 0, 'help should say something');
  });

  test('RecentBooksIntent lists up to three books from the live recent-listening feed', async () => {
    const recentResponse = await fetch(`${cred.url}/api/me/items-in-progress?limit=3`, {
      headers: absHeaders(),
    });
    assert.ok(recentResponse.ok, `recent-listening feed returned HTTP ${recentResponse.status}`);
    const recentData = await recentResponse.json();
    const expected = (recentData.libraryItems || [])
      .filter((item) => item?.media?.metadata?.title)
      .slice(0, 3)
      .map((item) => item.media.metadata.title);

    const r = await invoke(A.intent('RecentBooksIntent', {}, {}, true));
    const spoken = speech(r);
    assert.doesNotMatch(spoken, /trouble doing what you asked/i);
    assert.strictEqual(play(r), undefined);
    for (const title of expected) {
      const escapedTitle = title.replace(/&/g, '&amp;').replace(/'/g, '&apos;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      assert.ok(spoken.includes(escapedTitle), `RecentBooksIntent omitted ${title}`);
    }
    if (expected.length > 1) {
      const escapedLastTitle = expected[expected.length - 1]
        .replace(/&/g, '&amp;').replace(/'/g, '&apos;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      assert.ok(spoken.includes(`; and ${escapedLastTitle}`),
        'RecentBooksIntent should say "and" before the final book');
    }
  });

  test('FallbackIntent responds without throwing', async () => {
    const r = await invoke(A.intent('AMAZON.FallbackIntent', {}, {}, true));
    assert.ok(speech(r).length > 0);
  });

  for (const name of ['AMAZON.LoopOnIntent', 'AMAZON.ShuffleOnIntent', 'AMAZON.StartOverIntent', 'AMAZON.RepeatIntent']) {
    test(`${name} is declined gracefully`, async () => {
      const r = await invoke(A.intent(name, {}, {}, true));
      assert.ok(speech(r).length > 0, `${name} should say something rather than throw`);
      assert.doesNotMatch(speech(r), /trouble doing what you asked/i,
        `${name} fell through to the generic error handler`);
    });
  }

  test('an unknown book is declined, not crashed', async () => {
    const r = await invoke(A.intent('PlayBookIntent', { title: 'a book that certainly does not exist' }, {}, true));
    assert.strictEqual(play(r), undefined);
    assert.doesNotMatch(speech(r), /trouble doing what you asked/i);
  });

  test('GoToChapterX rejects an out-of-range chapter cleanly', async () => {
    const first = await invoke(A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    const r = await invoke(A.intent('GoToChapterX', { chapterNumber: '999999' }, {}, true,
      A.playerStateFrom(first)));
    assert.strictEqual(play(r), undefined);
    assert.match(speech(r), /between 1 and/i);
    assert.doesNotMatch(speech(r), /trouble doing what you asked/i);
  });

  // --- device and playback events -------------------------------------------

  test('AudioPlayer events are handled without throwing', async () => {
    const first = await invoke(A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    const attrs = first.sessionAttributes || {};
    const player = A.playerStateFrom(first);
    for (const ev of ['PlaybackStarted', 'PlaybackStopped', 'PlaybackNearlyFinished', 'PlaybackFinished']) {
      const r = await invoke(A.audioPlayer(ev, player, attrs));
      assert.ok(r, `AudioPlayer.${ev} returned no response`);
      assert.doesNotMatch(speech(r), /trouble doing what you asked/i,
        `AudioPlayer.${ev} hit the generic error handler`);
    }
  });

  test('device buttons are handled without throwing', async () => {
    const first = await invoke(A.intent('PlayBookIntent', { title: BOOK }, {}, true));
    const player = A.playerStateFrom(first);
    for (const ev of ['PlayCommandIssued', 'PauseCommandIssued', 'NextCommandIssued', 'PreviousCommandIssued']) {
      const r = await invoke(A.playbackController(ev, undefined, player));
      assert.ok(r, `PlaybackController.${ev} returned no response`);
      assert.doesNotMatch(speech(r), /trouble doing what you asked/i,
        `PlaybackController.${ev} hit the generic error handler`);
    }
  });

  test('SessionEndedRequest is handled', async () => {
    const r = await invoke(A.sessionEnded());
    assert.ok(r, 'session end returned no response');
  });
});
