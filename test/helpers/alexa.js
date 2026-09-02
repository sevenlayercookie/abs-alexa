'use strict';
// Builds Alexa request envelopes and invokes the skill against them.

const path = require('path');
const SKILL = path.join(__dirname, '..', '..', 'lambda', 'index.js');

const base = (sessionAttributes = {}, newSession = true) => ({
  version: '1.0',
  session: {
    new: newSession,
    sessionId: 'amzn1.echo-api.session.TEST',
    application: { applicationId: 'amzn1.ask.skill.TEST' },
    user: { userId: 'amzn1.ask.account.TEST' },
    attributes: sessionAttributes,
  },
  context: {
    System: {
      application: { applicationId: 'amzn1.ask.skill.TEST' },
      user: { userId: 'amzn1.ask.account.TEST' },
      device: { deviceId: 'TESTDEVICE', supportedInterfaces: { AudioPlayer: {} } },
      apiEndpoint: 'https://api.amazonalexa.com',
      apiAccessToken: 'TEST_ACCESS_TOKEN',
    },
    AudioPlayer: { playerActivity: 'IDLE' },
  },
});

const withRequest = (request, sessionAttributes, newSession) => {
  const env = base(sessionAttributes, newSession);
  env.request = {
    requestId: 'amzn1.echo-api.request.TEST',
    timestamp: '2024-01-01T00:00:00Z',
    locale: 'en-US',
    ...request,
  };
  return env;
};

const launch = (attrs) => withRequest({ type: 'LaunchRequest' }, attrs);

const intent = (name, slots = {}, attrs, newSession = false) =>
  withRequest({
    type: 'IntentRequest',
    intent: {
      name,
      confirmationStatus: 'NONE',
      slots: Object.fromEntries(
        Object.entries(slots).map(([k, v]) => [k, { name: k, value: v, confirmationStatus: 'NONE' }])
      ),
    },
  }, attrs, newSession);

const audioPlayer = (event, extra = {}, attrs) =>
  withRequest({ type: `AudioPlayer.${event}`, token: 'TEST_TOKEN', offsetInMilliseconds: 0, ...extra }, attrs);

const playbackController = (event, attrs) =>
  withRequest({ type: `PlaybackController.${event}` }, attrs);

const sessionEnded = (reason = 'USER_INITIATED', attrs) =>
  withRequest({ type: 'SessionEndedRequest', reason }, attrs);

// Load a fresh copy of the skill. Module-level state in index.js persists for
// the life of a Lambda container, so a fresh require models a cold start;
// reusing the returned skill models a warm one.
function loadSkill() {
  delete require.cache[require.resolve(SKILL)];
  return require(SKILL);
}

function invoke(skill, envelope) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, res) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(res);
    };
    try {
      const maybe = skill.handler(envelope, {}, done);
      if (maybe && typeof maybe.then === 'function') maybe.then((r) => done(null, r), done);
    } catch (err) {
      done(err);
    }
  });
}

module.exports = { launch, intent, audioPlayer, playbackController, sessionEnded, loadSkill, invoke };
