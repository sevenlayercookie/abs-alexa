'use strict';
// A stand-in for the Audiobookshelf server.
//
//   replay(): serves previously recorded responses. No network. Used by tests.
//   record(): proxies to the real ABS server, saving each scrubbed
//             request/response pair as a fixture. Used by `npm run record`.
//
// It has to be a real HTTP server on a real port: the skill talks to ABS via
// sync-request, which performs the request in a child process, so in-process
// HTTP mocking cannot intercept it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeSecretScrubber } = require('./scrub');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

const keyFor = (method, url) => `${method} ${url}`;
const fileFor = (name) => path.join(FIXTURES, name + '.json');

function loadCassette(name) {
  const f = fileFor(name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

function saveCassette(name, data) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(fileFor(name), JSON.stringify(data, null, 2) + '\n');
}

const WRITE_ENDPOINTS = [
  /^\/api\/session\/[^/]+\/sync$/,
  /^\/api\/session\/[^/]+\/close$/,
  /^\/api\/me\/progress\//,
];

const isWrite = (url) => {
  const p = url.split('?')[0];
  return WRITE_ENDPOINTS.some((re) => re.test(p));
};

// Serve recorded interactions; unknown requests fail loudly rather than
// silently returning something plausible.
function replay(name) {
  const cassette = loadCassette(name);
  const misses = [];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = rawBody;
    if (rawBody && (req.headers['content-type'] || '').includes('application/json')) {
      try { body = JSON.parse(rawBody); } catch { /* keep malformed JSON visible */ }
    }
    requests.push({ method: req.method, url: req.url, body });

    let hit = cassette[keyFor(req.method, req.url)];

    // Older cassettes recorded the default 25-item response. Reuse and trim
    // that response when production asks ABS to return a smaller recent list.
    const recentMatch = req.method === 'GET'
      && req.url.match(/^\/api\/me\/items-in-progress\?limit=(\d+)$/);
    if (!hit && recentMatch) {
      const recorded = cassette['GET /api/me/items-in-progress'];
      if (recorded) {
        const body = typeof recorded.body === 'string' ? JSON.parse(recorded.body) : recorded.body;
        hit = {
          ...recorded,
          body: { ...body, libraryItems: (body.libraryItems || []).slice(0, Number(recentMatch[1])) },
        };
      }
    }

    // A play-session response recorded from POST /items/:id/play is also what
    // ABS returns from GET /session/:id. Synthesize that lookup so cold-start
    // recovery can be tested without depending on an expired live session.
    const sessionMatch = req.method === 'GET' && req.url.match(/^\/api\/session\/([^/?]+)$/);
    if (!hit && sessionMatch) {
      const wantedId = decodeURIComponent(sessionMatch[1]);
      for (const [key, entry] of Object.entries(cassette)) {
        if (!/^POST \/api\/items\/[^/]+\/play$/.test(key)) continue;
        try {
          const body = typeof entry.body === 'string' ? JSON.parse(entry.body) : entry.body;
          if (body?.id === wantedId) {
            hit = { status: 200, headers: { 'Content-Type': 'application/json' }, body };
            break;
          }
        } catch { /* malformed fixtures are handled as misses below */ }
      }
      // ABS only serves a play session while it is still open, so an id it no
      // longer holds is a 404, not a missing fixture. Answering that way lets
      // tests exercise recovery from an expired session.
      if (!hit) {
        hit = { status: 404, headers: { 'Content-Type': 'application/json' }, body: '{}' };
      }
    }

    // Writes are blocked while recording and their response body is never
    // consumed by the skill. Treat every matching play-session id the same so
    // adding a test does not require a meaningless id-specific fixture.
    if (!hit && isWrite(req.url)) {
      hit = { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
    }

    if (!hit) {
      misses.push(keyFor(req.method, req.url));
      res.writeHead(599, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no fixture for ' + keyFor(req.method, req.url) }));
    }
    res.writeHead(hit.status, hit.headers || { 'Content-Type': 'application/json' });
    res.end(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body));
  });
  return { server, misses, requests, cassette };
}

// Endpoints that would modify the user's library are never forwarded. The
// skill reports listening progress back to Audiobookshelf, so recording these
// for real would overwrite the position in whatever books are in progress.
// They are answered with a canned success instead, which is what the skill
// checks for anyway (it only looks at statusCode).
// Proxy to the real server, recording as we go.
function record(name, upstream, apiKey) {
  const cassette = loadCassette(name);
  const scrubSecrets = makeSecretScrubber({ apiKey, serverUrl: upstream });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    if (isWrite(req.url)) {
      const canned = { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
      cassette[keyFor(req.method, scrubSecrets(req.url))] = { ...canned, note: 'write blocked during recording' };
      saveCassette(name, cassette);
      console.error(`  [write blocked] ${req.method} ${req.url}`);
      res.writeHead(canned.status, canned.headers);
      return res.end(canned.body);
    }

    let upstreamRes, text;
    try {
      upstreamRes = await fetch(upstream + req.url, {
        method: req.method,
        headers: { ...req.headers, host: new URL(upstream).host },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      text = await upstreamRes.text();
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(err) }));
    }
    const ct = upstreamRes.headers.get('content-type') || 'application/json';
    const isText = ct.includes('json') || ct.includes('text');
    // Store the secret-scrubbed copy, but hand the skill the REAL body. The
    // skill takes ids out of one response and builds the next request's URL
    // from them, so a placeholder here would break the chain (and did).
    cassette[keyFor(req.method, scrubSecrets(req.url))] = {
      status: upstreamRes.status,
      headers: { 'Content-Type': ct },
      body: isText ? scrubSecrets(text) : '<binary omitted>',
    };
    saveCassette(name, cassette);
    res.writeHead(upstreamRes.status, { 'Content-Type': ct });
    res.end(isText ? text : '');
  });
  return { server, cassette };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

module.exports = { replay, record, listen, loadCassette, saveCassette };
