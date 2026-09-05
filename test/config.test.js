'use strict';
// Configuration resolution, each case in a child process so it gets a clean
// module registry and its own environment.
//
// This exists because the module split broke the config.js path and no test
// noticed: lib/settings.js moved into lambda/lib/ but kept require('./config.js'),
// which then resolved to lambda/lib/config.js. Every other test sets ABS_API_KEY
// and SERVER_URL in the environment, so the file fallback was never exercised --
// and the skill only failed once it was deployed.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LAMBDA = path.join(__dirname, '..', 'lambda');

function load(env, { withConfigFile }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-config-test-'));
  const lib = path.join(sandbox, 'lib');
  fs.mkdirSync(lib);
  fs.copyFileSync(path.join(LAMBDA, 'lib', 'settings.js'), path.join(lib, 'settings.js'));
  if (withConfigFile) {
    fs.writeFileSync(path.join(sandbox, 'config.js'),
      "module.exports = { ABS_API_KEY: 'from-file', SERVER_URL: 'https://file.example' };\n");
  }
  try {
    const out = execFileSync(process.execPath, ['-e',
      "const s=require('./lib/settings');" +
      "console.log(JSON.stringify({key:s.ABS_API_KEY,url:s.SERVER_URL,ua:s.USER_AGENT}));"],
      { cwd: sandbox, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

describe('configuration resolution', () => {
  test('reads lambda/config.js when nothing is set in the environment', () => {
    const c = load({}, { withConfigFile: true });
    assert.strictEqual(c.key, 'from-file');
    assert.strictEqual(c.url, 'https://file.example');
  });

  test('environment overrides config.js', () => {
    const c = load({ ABS_API_KEY: 'from-env', SERVER_URL: 'https://env.example' }, { withConfigFile: true });
    assert.strictEqual(c.key, 'from-env');
    assert.strictEqual(c.url, 'https://env.example');
  });

  test('works from the environment alone, with no config.js present', () => {
    const c = load({ ABS_API_KEY: 'k', SERVER_URL: 'https://e' }, { withConfigFile: false });
    assert.strictEqual(c.key, 'k');
    assert.strictEqual(c.ua, 'AlexaSkill');
  });

  test('fails loudly when neither source supplies credentials', () => {
    assert.throws(() => load({}, { withConfigFile: false }), /Missing required configuration/);
  });
});
