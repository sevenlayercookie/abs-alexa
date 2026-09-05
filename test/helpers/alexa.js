'use strict';
// Builds Alexa request envelopes and invokes the skill against them.

const path = require('path');
const fs = require('fs');
const SKILL = path.join(__dirname, '..', '..', 'lambda', 'index.js');
const SETTINGS = path.join(__dirname, '..', '..', 'lambda', 'lib', 'settings.js');
const MODEL = path.join(__dirname, '..', '..', 'skill-package', 'interactionModels', 'custom', 'en-US.json');

// Alexa sends every slot declared for an intent, with `value` absent when the
// user did not fill it -- not just the ones that were filled. Reproducing that
// matters: index.js reads `slots.author.value` directly, which throws if the
// slot object is missing altogether.
const declaredSlots = (() => {
  try {
    const model = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
    const out = {};
    for (const i of model.interactionModel.languageModel.intents || []) {
      out[i.name] = (i.slots || []).map((s) => s.name);
    }
    return out;
  } catch { return {}; }
})();

// `player` mirrors what a device reports about the stream it currently has
// loaded. Alexa includes context.AudioPlayer ONLY when there is such a stream:
// captured envelopes for PlayLastIntent, ResumeIntent, PauseIntent, HelpIntent,
// GoBackXTimeIntent, GoForwardXTimeIntent and GoToChapterX all omit it entirely
// when nothing is playing. index.js dereferences
// context.AudioPlayer.offsetInMilliseconds in 21 places, so whether the object
// is there at all changes which failures are reachable. Passing no player state
// therefore omits the key, exactly as Alexa does.
const base = (sessionAttributes = {}, newSession = true, player = null) => ({
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
    ...(player ? { AudioPlayer: { playerActivity: 'PLAYING', ...player } } : {}),
  },
});

const withRequest = (request, sessionAttributes, newSession, player) => {
  const env = base(sessionAttributes, newSession, player);
  env.request = {
    requestId: 'amzn1.echo-api.request.TEST',
    timestamp: '2024-01-01T00:00:00Z',
    locale: 'en-US',
    ...request,
  };
  return env;
};

const launch = (attrs) => withRequest({ type: 'LaunchRequest' }, attrs);

const intent = (name, slots = {}, attrs, newSession = false, player = null) =>
  withRequest({
    type: 'IntentRequest',
    intent: {
      name,
      confirmationStatus: 'NONE',
      slots: Object.fromEntries(
        [...new Set([...(declaredSlots[name] || []), ...Object.keys(slots)])].map((k) => [
          k,
          slots[k] === undefined
            ? { name: k, confirmationStatus: 'NONE' }              // declared but unfilled
            : { name: k, value: slots[k], confirmationStatus: 'NONE' },
        ])
      ),
    },
  }, attrs, newSession, player);

// An AudioPlayer.* request always describes a stream, so it always carries
// context.AudioPlayer.
const audioPlayer = (event, extra = {}, attrs) => {
  const req = { type: `AudioPlayer.${event}`, token: 'TEST_TOKEN', offsetInMilliseconds: 0, ...extra };
  const envelope = withRequest(req, attrs, false,
    { token: req.token, offsetInMilliseconds: req.offsetInMilliseconds });
  delete envelope.session;
  return envelope;
};

const playbackController = (event, attrs, player) => {
  const envelope = withRequest({ type: `PlaybackController.${event}` }, attrs, false, player);
  delete envelope.session;
  return envelope;
};

// Pulls the token/offset out of a previous AudioPlayer.Play directive, so a
// follow-up device-button event carries what a real Echo would report.
const playerStateFrom = (res) => {
  const d = ((res && res.response && res.response.directives) || [])
    .find((x) => x.type === 'AudioPlayer.Play');
  const stream = (d && d.audioItem && d.audioItem.stream) || {};
  return { token: stream.token, offsetInMilliseconds: stream.offsetInMilliseconds, playerActivity: 'PLAYING' };
};

const sessionEnded = (reason = 'USER_INITIATED', attrs, player = null) =>
  withRequest({ type: 'SessionEndedRequest', reason }, attrs, false, player);

function asUser(envelope, userId) {
  envelope.context.System.user.userId = userId;
  if (envelope.session?.user) envelope.session.user.userId = userId;
  return envelope;
}

// Load a fresh copy of the skill. Module-level state in index.js persists for
// the life of a Lambda container, so a fresh require models a cold start;
// reusing the returned skill models a warm one.
function loadSkill() {
  // Skill behaviour tests provide explicit test configuration and exercise
  // settings.js separately in config.test.js. Stub the resolved settings here
  // so a developer's ignored lambda/config.js cannot affect or be modified by
  // the offline suite.
  const serverUrl = process.env.SERVER_URL;
  const apiKey = process.env.ABS_API_KEY;
  require.cache[require.resolve(SETTINGS)] = {
    id: SETTINGS,
    filename: SETTINGS,
    loaded: true,
    exports: {
      ABS_API_KEY: apiKey,
      SERVER_URL: serverUrl,
      USER_AGENT: process.env.USER_AGENT || 'AlexaSkill',
      BACKGROUND_URL: process.env.BACKGROUND_URL,
      CFAccessClientId: process.env.CFAccessClientId,
      CFAccessClientSecret: process.env.CFAccessClientSecret,
      baseheaders: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      resolveBackgroundUrl: (coverUrl) => process.env.BACKGROUND_URL || coverUrl,
    },
  };
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

module.exports = { launch, intent, audioPlayer, playbackController, playerStateFrom,
  sessionEnded, asUser, loadSkill, invoke };
