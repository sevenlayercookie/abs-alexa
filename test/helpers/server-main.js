'use strict';
// Child-process entry point for the Audiobookshelf stand-in.
//
// This MUST run in its own process. The skill calls ABS through sync-request,
// which blocks the calling thread while a child process performs the request.
// A fixture server sharing that blocked event loop could never reply, and the
// test would deadlock.

const { replay, record, listen } = require('./abs-server');

(async () => {
  const mode = process.argv[2];
  const name = process.argv[3] || 'abs';
  let server;

  if (mode === 'record') {
    ({ server } = record(name, process.argv[4], process.argv[5]));
  } else {
    const r = replay(name);
    server = r.server;
    // The parent asks for misses explicitly and waits for the answer. Pushing
    // them asynchronously would race with the assertion that reads them.
    process.on('message', (m) => {
      if (m === 'get-misses') process.send({ type: 'misses', list: r.misses.slice() });
      if (m === 'get-requests') process.send({ type: 'requests', list: r.requests.slice() });
      if (m === 'clear-requests') {
        r.requests.length = 0;
        process.send({ type: 'requests-cleared' });
      }
      if (m === 'forget-sessions' || m === 'remember-sessions') {
        r.setSessionsForgotten(m === 'forget-sessions');
        process.send({ type: 'sessions-forgotten' });
      }
    });
  }

  const port = await listen(server);
  process.send({ type: 'ready', port });
  process.on('message', (m) => { if (m === 'close') { server.close(); process.exit(0); } });
})();
