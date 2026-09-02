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
const { makeScrubber } = require('./scrub');

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

// Serve recorded interactions; unknown requests fail loudly rather than
// silently returning something plausible.
function replay(name) {
  const cassette = loadCassette(name);
  const misses = [];
  const server = http.createServer((req, res) => {
    const hit = cassette[keyFor(req.method, req.url)];
    if (!hit) {
      misses.push(keyFor(req.method, req.url));
      res.writeHead(599, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no fixture for ' + keyFor(req.method, req.url) }));
    }
    res.writeHead(hit.status, hit.headers || { 'Content-Type': 'application/json' });
    res.end(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body));
  });
  return { server, misses, cassette };
}

// Proxy to the real server, recording as we go.
function record(name, upstream, apiKey) {
  const cassette = loadCassette(name);
  const scrub = makeScrubber({ apiKey, serverUrl: upstream });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
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
    // store the scrubbed copy; hand the caller the scrubbed copy too, so the
    // skill under test never sees the real key
    const safeBody = ct.includes('json') || ct.includes('text') ? scrub(text) : '<binary omitted>';
    cassette[keyFor(req.method, scrub(req.url))] = {
      status: upstreamRes.status,
      headers: { 'Content-Type': ct },
      body: safeBody,
    };
    saveCassette(name, cassette);
    res.writeHead(upstreamRes.status, { 'Content-Type': ct });
    res.end(safeBody);
  });
  return { server, cassette };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

module.exports = { replay, record, listen, loadCassette, saveCassette };
