'use strict';
// Configuration and derived constants. Environment variables win over
// config.js, so a host that supplies them needs no file at all.

let fileConfig = {};
try {
  fileConfig = require('../config.js');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  console.log('No config.js found; reading configuration from the environment.');
}
const cfg = (key, fallback) =>
  process.env[key] !== undefined ? process.env[key] : (fileConfig[key] !== undefined ? fileConfig[key] : fallback);
const ABS_API_KEY = cfg('ABS_API_KEY');
const SERVER_URL = cfg('SERVER_URL');
const USER_AGENT = cfg('USER_AGENT', 'AlexaSkill');
const BACKGROUND_URL = cfg('BACKGROUND_URL');
const CFAccessClientId = cfg('CFAccessClientId');
const CFAccessClientSecret = cfg('CFAccessClientSecret');
if (!ABS_API_KEY || !SERVER_URL) {
  throw new Error('Missing required configuration: set ABS_API_KEY and SERVER_URL in the environment or config.js (see config.example.js).');
}

const baseheaders = {
  "Content-Type": 'application/json',
  "Authorization": 'Bearer ' + ABS_API_KEY,
  "CF-Access-Client-Id": CFAccessClientId,
  "cf-access-client-id": CFAccessClientId,
  "CF-Access-Client-Secret": CFAccessClientSecret,
  "User-Agent": USER_AGENT
}

// Background art for screen devices. Defaults to the cover of the book being
// played; set BACKGROUND_URL to pin a static image instead.
function resolveBackgroundUrl(coverUrl) {
  return BACKGROUND_URL || coverUrl;
}

module.exports = { ABS_API_KEY, SERVER_URL, USER_AGENT, BACKGROUND_URL,
  CFAccessClientId, CFAccessClientSecret, baseheaders, resolveBackgroundUrl };
