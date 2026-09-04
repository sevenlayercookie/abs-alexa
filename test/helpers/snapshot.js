'use strict';
// Characterisation snapshots: record what the skill does today so any change
// in behaviour shows up as a diff. Regenerate deliberately with
// UPDATE_SNAPSHOTS=1 npm test -- never to make a red test go green.

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const { normaliseVolatile } = require('./scrub');

const DIR = path.join(__dirname, '..', 'snapshots');

// Anything derived from the clock or a random id would differ on every run.
function normalise(value) {
  return normaliseVolatile(JSON.stringify(value, null, 2));
}

function matchSnapshot(name, value) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name.replace(/[^\w.-]+/g, '_') + '.snap.json');
  const actual = normalise(value);
  if (process.env.UPDATE_SNAPSHOTS === '1' || !fs.existsSync(file)) {
    fs.writeFileSync(file, actual + '\n');
    return { written: true, file };
  }
  const expected = fs.readFileSync(file, 'utf8').trimEnd();
  assert.strictEqual(actual, expected,
    `Behaviour changed for "${name}".\n` +
    `If the change is intended, re-record with:  UPDATE_SNAPSHOTS=1 npm test\n` +
    `Snapshot: ${path.relative(process.cwd(), file)}`);
  return { written: false, file };
}

module.exports = { matchSnapshot, normalise };
