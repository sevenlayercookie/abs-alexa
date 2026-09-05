'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { formatSpokenList } = require('../lambda/lib/speech');

test('formats spoken lists naturally for one, two, or three books', () => {
  assert.strictEqual(formatSpokenList(['First']), 'First');
  assert.strictEqual(formatSpokenList(['First', 'Second']), 'First; and Second');
  assert.strictEqual(
    formatSpokenList(['First', 'Second', 'Third']),
    'First; Second; and Third');
});
