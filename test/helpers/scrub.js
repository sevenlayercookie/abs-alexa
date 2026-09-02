'use strict';
// Removes anything sensitive or unstable from recorded traffic and from skill
// responses, so fixtures are safe to commit and snapshots compare cleanly.

const PLACEHOLDER_KEY = 'TEST_API_KEY';
const PLACEHOLDER_HOST = 'http://abs.test';

// Values discovered at record time (real key, real host) get swapped for the
// placeholders above. Everything else volatile is normalised by shape.
function makeScrubber({ apiKey, serverUrl } = {}) {
  const literals = [];
  if (apiKey) literals.push([apiKey, PLACEHOLDER_KEY]);
  if (serverUrl) literals.push([serverUrl.replace(/\/$/, ''), PLACEHOLDER_HOST]);

  const patterns = [
    // ids that change every run
    [/"id"\s*:\s*"[0-9a-f-]{16,}"/gi, '"id":"<id>"'],
    [/"sessionId"\s*:\s*"[^"]*"/gi, '"sessionId":"<sessionId>"'],
    [/"userId"\s*:\s*"[^"]*"/gi, '"userId":"<userId>"'],
    [/"libraryItemId"\s*:\s*"[0-9a-f-]{16,}"/gi, '"libraryItemId":"<libraryItemId>"'],
    // wall-clock values
    [/"(startedAt|updatedAt|finishedAt|lastUpdate|addedAt|createdAt)"\s*:\s*\d+/gi, '"$1":0'],
    [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<timestamp>'],
    // any surviving bearer token or ?token= query value
    [/(\?|&)token=[^"&\s]+/gi, '$1token=' + PLACEHOLDER_KEY],
    [/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ' + PLACEHOLDER_KEY],
  ];

  return function scrub(input) {
    let s = typeof input === 'string' ? input : JSON.stringify(input);
    for (const [from, to] of literals) s = s.split(from).join(to);
    for (const [re, to] of patterns) s = s.replace(re, to);
    return typeof input === 'string' ? s : JSON.parse(s);
  };
}

module.exports = { makeScrubber, PLACEHOLDER_KEY, PLACEHOLDER_HOST };
