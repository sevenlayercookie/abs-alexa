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
const { loadSkill, invoke } = require('./helpers/alexa');
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

  test('every request was served from a fixture', async () => {
    const misses = await srv.getMisses();
    assert.deepStrictEqual(misses, [],
      'The skill asked for endpoints with no recorded fixture.\n' +
      'Re-record against a live server with:  npm run record');
  });
});
