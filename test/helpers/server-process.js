'use strict';
// Parent-side handle for the fixture server running in its own process.

const { fork } = require('child_process');
const path = require('path');

function startServer(mode, name = 'abs', upstream, apiKey) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'server-main.js'),
      [mode, name, upstream || '', apiKey || ''],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

    const timer = setTimeout(() => reject(new Error('fixture server did not start')), 10000);

    // Ask the server which requests it could not satisfy. Synchronous
    // request/response over IPC, so the caller cannot read a stale empty list.
    function getMisses() {
      return new Promise((done, fail) => {
        const t = setTimeout(() => fail(new Error('timed out reading misses')), 5000);
        child.once('message', function onMsg(m) {
          if (m.type === 'misses') { clearTimeout(t); done(m.list); }
          else child.once('message', onMsg);
        });
        child.send('get-misses');
      });
    }

    function requestReply(command, responseType, timeoutMessage) {
      return new Promise((done, fail) => {
        const t = setTimeout(() => fail(new Error(timeoutMessage)), 5000);
        child.once('message', function onMsg(m) {
          if (m.type === responseType) { clearTimeout(t); done(m.list); }
          else child.once('message', onMsg);
        });
        child.send(command);
      });
    }

    const getRequests = () => requestReply(
      'get-requests', 'requests', 'timed out reading captured requests');
    const clearRequests = () => requestReply(
      'clear-requests', 'requests-cleared', 'timed out clearing captured requests');

    child.on('message', (m) => {
      if (m.type === 'ready') {
        clearTimeout(timer);
        resolve({ port: m.port, getMisses, getRequests, clearRequests, close });
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => { if (code) reject(new Error('fixture server exited ' + code)); });

    function close() {
      return new Promise((done) => {
        if (child.exitCode !== null || child.killed) return done();
        child.once('exit', () => done());
        try { child.send('close'); } catch { child.kill(); }
        setTimeout(() => { child.kill(); done(); }, 2000).unref();
      });
    }
  });
}

module.exports = { startServer };
