'use strict';
// One definition of what the skill is expected to survive, shared by the
// recorder and the tests. Each scenario is a sequence of turns run against a
// single skill instance, so it also exercises state carried between turns the
// way a real Lambda container would.

const A = require('./helpers/alexa');

const scenarios = [
  {
    name: 'launch',
    steps: [{ label: 'LaunchRequest', make: () => A.launch() }],
  },
  {
    name: 'play-last-then-pause',
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'AudioPlayer.PlaybackStarted', make: (a) => A.audioPlayer('PlaybackStarted', {}, a) },
      { label: 'AMAZON.PauseIntent', make: (a) => A.intent('AMAZON.PauseIntent', {}, a) },
    ],
  },
  {
    name: 'resume',
    steps: [{ label: 'AMAZON.ResumeIntent', make: () => A.intent('AMAZON.ResumeIntent', {}, {}, true) }],
  },
  {
    name: 'play-book-by-title',
    steps: [{ label: 'PlayBookIntent title only', make: () => A.intent('PlayBookIntent', { title: 'the lies of locke lamora' }, {}, true) }],
  },
  {
    name: 'play-book-by-title-and-author',
    steps: [{ label: 'PlayBookIntent title + author', make: () => A.intent('PlayBookIntent', { title: 'red seas under red skies', author: 'scott lynch' }, {}, true) }],
  },
  {
    name: 'chapter-navigation',
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'AMAZON.NextIntent', make: (a) => A.intent('AMAZON.NextIntent', {}, a) },
      { label: 'AMAZON.PreviousIntent', make: (a) => A.intent('AMAZON.PreviousIntent', {}, a) },
    ],
  },
  {
    name: 'seek-within-book',
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'GoForwardXTimeIntent 2m', make: (a) => A.intent('GoForwardXTimeIntent', { time: 'PT2M' }, a) },
      { label: 'GoBackXTimeIntent 30s', make: (a) => A.intent('GoBackXTimeIntent', { time: 'PT30S' }, a) },
    ],
  },
  {
    name: 'nearly-finished-enqueues-next',
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'AudioPlayer.PlaybackNearlyFinished', make: (a) => A.audioPlayer('PlaybackNearlyFinished', {}, a) },
    ],
  },
  {
    name: 'device-buttons',
    steps: [
      { label: 'PlaybackController.PlayCommandIssued', make: () => A.playbackController('PlayCommandIssued') },
      { label: 'PlaybackController.NextCommandIssued', make: (a) => A.playbackController('NextCommandIssued', a) },
    ],
  },
  {
    name: 'help-and-stop',
    steps: [
      { label: 'AMAZON.HelpIntent', make: () => A.intent('AMAZON.HelpIntent', {}, {}, true) },
      { label: 'AMAZON.StopIntent', make: (a) => A.intent('AMAZON.StopIntent', {}, a) },
    ],
  },
  {
    name: 'play-book-not-in-library',
    steps: [{ label: 'PlayBookIntent unknown title', make: () => A.intent('PlayBookIntent', { title: 'a book that does not exist anywhere' }, {}, true) }],
  },
  {
    name: 'unhandled-intent-falls-back',
    steps: [{ label: 'GoToChapterX (no handler)', make: () => A.intent('GoToChapterX', { chapterNumber: '3' }, {}, true) }],
  },
  {
    name: 'session-ended',
    steps: [{ label: 'SessionEndedRequest', make: () => A.sessionEnded() }],
  },
];

module.exports = { scenarios };
