'use strict';
// Records fixtures by running every scenario against a real Audiobookshelf
// server. Credentials come from the environment or lambda/config.js and are
// scrubbed out before anything is written to disk.
//
//   ABS_API_KEY=... SERVER_URL=http://host:port node test/record.js

const path = require('path');
const { scenarios } = require('./scenarios');
const { startServer } = require('./helpers/server-process');
const { loadSkill, invoke } = require('./helpers/alexa');

function realConfig() {
  let file = {};
  try { file = require(path.join(__dirname, '..', 'lambda', 'config.js')); } catch { /* optional */ }
  const apiKey = process.env.ABS_API_KEY || file.ABS_API_KEY;
  const serverUrl = process.env.SERVER_URL || file.SERVER_URL;
  if (!apiKey || !serverUrl || apiKey === 'xxxxxx') {
    console.error('Need a real ABS_API_KEY and SERVER_URL (environment or lambda/config.js).');
    process.exit(1);
  }
  return { apiKey, serverUrl: serverUrl.replace(/\/$/, '') };
}

(async () => {
  const { apiKey, serverUrl } = realConfig();
  const srv = await startServer('record', 'abs', serverUrl, apiKey);
  const port = srv.port;
  console.log(`recording against ${serverUrl} via 127.0.0.1:${port}`);

  // the skill talks to the proxy, and the proxy holds the only copy of the key
  process.env.SERVER_URL = `http://127.0.0.1:${port}`;
  process.env.ABS_API_KEY = apiKey;

  for (const scenario of scenarios) {
    const skill = loadSkill();
    let attrs = {};
    for (const step of scenario.steps) {
      try {
        const res = await invoke(skill, step.make(attrs));
        attrs = (res && res.sessionAttributes) || attrs;
        console.log(`  ok   ${scenario.name} -- ${step.label}`);
      } catch (err) {
        console.log(`  err  ${scenario.name} -- ${step.label}: ${err.message}`);
      }
    }
  }
  await srv.close();
  console.log('\nfixtures written to test/fixtures/abs.json');
  console.log('Review them before committing -- they came from your real library.');
})();
