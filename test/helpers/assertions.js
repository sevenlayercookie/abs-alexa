'use strict';
// Checks shared by the offline and live suites.
//
// These exist because snapshots alone are not enough. A snapshot records
// whatever the skill did and calls it the baseline, so a genuinely broken
// response becomes the expected result -- which is exactly what happened with
// "previous", whose Play directive carried offsetInMilliseconds: undefined for
// as long as anyone had been running the tests. Nothing complained, because
// nothing had ever said what a valid directive looks like.

const assert = require('node:assert');

const directives = (res) => (((res || {}).response) || {}).directives || [];
const playDirective = (res) => directives(res).find((d) => d.type === 'AudioPlayer.Play');
const stopDirective = (res) => directives(res).find((d) => d.type === 'AudioPlayer.Stop');
const speech = (res) => (((((res || {}).response) || {}).outputSpeech) || {}).ssml || '';

// Everything that can be checked without touching the network.
function assertWellFormedStream(directive, label) {
  assert.ok(directive, `${label}: expected an AudioPlayer.Play directive`);
  const s = (directive.audioItem || {}).stream;
  assert.ok(s, `${label}: directive carries no stream`);
  assert.ok(typeof s.url === 'string' && s.url.length > 0, `${label}: stream has no url`);
  assert.match(s.url, /\/api\/items\/[0-9a-f-]+\/file\//, `${label}: url is not an Audiobookshelf item file`);
  assert.match(s.url, /[?&]token=/, `${label}: url carries no auth token`);
  assert.ok(s.token !== undefined && s.token !== null, `${label}: stream has no token`);
  assert.ok(Number.isFinite(s.offsetInMilliseconds),
    `${label}: offsetInMilliseconds is ${s.offsetInMilliseconds}, not a number`);
  assert.ok(s.offsetInMilliseconds >= 0, `${label}: negative offset ${s.offsetInMilliseconds}`);
  const md = (directive.audioItem || {}).metadata;
  if (md) assert.ok(md.title, `${label}: metadata present but has no title`);
  return s;
}

// A response should never be the generic apology unless a test says so.
function assertNotErrorResponse(res, label) {
  assert.doesNotMatch(speech(res), /trouble doing what you asked/i,
    `${label}: fell through to the generic error handler`);
}

module.exports = { directives, playDirective, stopDirective, speech, assertWellFormedStream, assertNotErrorResponse };
