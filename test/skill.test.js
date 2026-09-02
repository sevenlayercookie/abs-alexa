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
const { loadSkill, invoke, intent, playbackController, playerStateFrom } = require('./helpers/alexa');
const { matchSnapshot } = require('./helpers/snapshot');
const fs = require('fs');
const path = require('path');

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

  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      // one skill instance per scenario: models a warm Lambda container across
      // the turns of a single conversation, a cold start between scenarios
      const skill = loadSkill();
      let attrs = {};
      for (const step of scenario.steps) {
        const res = await invoke(skill, step.make(attrs));
        assert.ok(res, `${step.label} returned no response`);
        matchSnapshot(`${scenario.name} -- ${step.label}`, res);
        attrs = (res && res.sessionAttributes) || attrs;
      }
    });
  }

  // The device Play/Next buttons on an Echo Show arrive as PlaybackController
  // events, which Alexa sends WITHOUT session attributes. The handler therefore
  // reads module-level state that outlives the conversation -- see the comment
  // at PlaybackControllerHandler in lambda/index.js.
  //
  // That state is load-bearing, not accidental: replacing localSessionAttributes
  // with attributesManager would break the device buttons outright. This test
  // pins the dependency so the rewrite cannot remove it silently.
  test('device Play button depends on state outliving the conversation', async () => {
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

  // KNOWN DEFECT, pinned deliberately.
  //
  // PlayCommandIssued builds chapter title, cover art and background metadata
  // and then calls .addAudioPlayerPlayDirective() with every argument commented
  // out, so Alexa receives a Play directive with an empty stream: no url, no
  // token, no offset. Pressing Play on a device with screen controls therefore
  // cannot resume anything.
  //
  // Confirmed pre-existing: the same empty stream comes out of the code as it
  // was before the strict-mode commit, so it is not a refactoring artifact.
  //
  // This asserts the broken behaviour on purpose, so a rewrite cannot change it
  // without someone noticing. When the directive is given its arguments back,
  // this test SHOULD fail -- update it then.
  test('KNOWN BUG: device Play button emits an empty audio stream', async () => {
    const warm = loadSkill();
    const first = await invoke(warm, intent('PlayLastIntent', {}, {}, true));
    const res = await invoke(warm,
      playbackController('PlayCommandIssued', undefined, playerStateFrom(first)));
    const play = ((res.response && res.response.directives) || [])
      .find((d) => d.type === 'AudioPlayer.Play');
    const stream = play.audioItem.stream;
    assert.strictEqual(stream.url, undefined,
      'if this now has a url, the bug was fixed -- update this test');
    assert.strictEqual(stream.token, undefined, 'token is also dropped');
    assert.strictEqual(stream.offsetInMilliseconds, undefined, 'offset is also dropped');
  });

  test('every request was served from a fixture', async () => {
    const misses = await srv.getMisses();
    assert.deepStrictEqual(misses, [],
      'The skill asked for endpoints with no recorded fixture.\n' +
      'Re-record against a live server with:  npm run record');
  });
});
