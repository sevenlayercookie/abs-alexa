'use strict';
// Two different jobs, deliberately kept apart.
//
// Fixtures need SECRETS removed and nothing else. Ids and timestamps must stay
// intact: the skill reads an id out of one response and puts it in the next
// request's URL, so rewriting ids breaks the recording chain. Fixtures are
// frozen once recorded, so leaving real values in them is still deterministic.
//
// Snapshots need VOLATILE values normalised, because those come from the clock
// and from the skill itself rather than from the fixture.

const PLACEHOLDER_KEY = 'TEST_API_KEY';
const PLACEHOLDER_HOST = 'http://abs.test';

function makeSecretScrubber({ apiKey, serverUrl } = {}) {
  const literals = [];
  if (apiKey) literals.push([apiKey, PLACEHOLDER_KEY]);
  if (serverUrl) literals.push([serverUrl.replace(/\/$/, ''), PLACEHOLDER_HOST]);

  // The server echoes the calling client's IP back in play-session responses,
  // so the bare host has to be scrubbed too, not just the full URL.
  let bareHost = null;
  try { bareHost = new URL(serverUrl).hostname; } catch { /* not a URL */ }

  const patterns = [
    [/(\?|&)token=[^"&\s]+/gi, '$1token=' + PLACEHOLDER_KEY],
    [/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer ' + PLACEHOLDER_KEY],
    [/\\?"ipAddress\\?"\s*:\s*\\?"[^"\\]*\\?"/g, (m) => m.split(':')[0] + ':"<ip>"'],
    [/"(username|osusername|refreshToken|accessToken|oldToken)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"'],
    // Email addresses turn up anywhere, not just in an "email" field -- this
    // library stores them inside filesystem paths.
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'redacted@example.com'],
  ];
  if (bareHost) patterns.unshift([new RegExp(bareHost.replace(/\./g, '\\.'), 'g'), 'abs.test']);

  return function scrubSecrets(text) {
    let s = String(text);
    for (const [from, to] of literals) if (from) s = s.split(from).join(to);
    for (const [re, to] of patterns) s = s.replace(re, to);
    return s;
  };
}

// Applied to skill responses before comparing against a stored baseline.
function normaliseVolatile(text) {
  return String(text)
    .replace(/"token"\s*:\s*"[^"]*"/g, '"token":"<token>"')
    .replace(/"expectedPreviousToken"\s*:\s*"[^"]*"/g, '"expectedPreviousToken":"<token>"')
    .replace(/(\?|&)token=[^"&\s]*/g, '$1token=<token>')
    .replace(/"(startedAt|updatedAt|finishedAt|lastUpdate)"\s*:\s*\d+/g, '"$1":0')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<timestamp>')
    .replace(/ask-node\/[\d.]+ Node\/v[\d.]+/g, 'ask-node/<ver> Node/<ver>')
    // the fixture server binds an ephemeral port, so it differs every run
    .replace(/(127\.0\.0\.1|localhost):\d+/g, '$1:<port>');
}

module.exports = { makeSecretScrubber, normaliseVolatile, PLACEHOLDER_KEY, PLACEHOLDER_HOST };
