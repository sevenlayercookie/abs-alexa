'use strict';
// One definition of what the skill is expected to survive, shared by the
// recorder and the tests. Each scenario is a sequence of turns run against a
// single skill instance, so it also exercises state carried between turns the
// way a real Lambda container would.

const A = require('./helpers/alexa');

// Steps receive (sessionAttributes, player). `player` is what the device would
// report about the stream it currently has loaded, derived from the previous
// AudioPlayer.Play directive -- null until something is playing. Alexa only
// sends context.AudioPlayer when a stream exists, and index.js dereferences it
// in 21 places, so getting this right decides which code paths are reachable.

const scenarios = [
  {
    name: 'launch',
    steps: [{ label: 'LaunchRequest', make: () => A.launch() }],
  },
  {
    name: 'play-last-then-pause',
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'AudioPlayer.PlaybackStarted', make: (a, p) => A.audioPlayer('PlaybackStarted', p || {}, a) },
      { label: 'AMAZON.PauseIntent', make: (a, p) => A.intent('AMAZON.PauseIntent', {}, a, false, p) },
    ],
  },
  {
    name: 'resume',
    steps: [{ label: 'AMAZON.ResumeIntent', make: () => A.intent('AMAZON.ResumeIntent', {}, {}, true) }],
  },
  {
    name: 'recent-books',
    steps: [{ label: 'RecentBooksIntent', make: () => A.intent('RecentBooksIntent', {}, {}, true) }],
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
      { label: 'AMAZON.NextIntent', make: (a, p) => A.intent('AMAZON.NextIntent', {}, a, false, p) },
      { label: 'AMAZON.PreviousIntent', make: (a, p) => A.intent('AMAZON.PreviousIntent', {}, a, false, p) },
    ],
  },
  {
    name: 'seek-within-book',
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'GoForwardXTimeIntent 2m', make: (a, p) => A.intent('GoForwardXTimeIntent', { time: 'PT2M' }, a, false, p) },
      { label: 'GoBackXTimeIntent 30s', make: (a, p) => A.intent('GoBackXTimeIntent', { time: 'PT30S' }, a, false, p) },
    ],
  },
  {
    name: 'nearly-finished-enqueues-next',
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'AudioPlayer.PlaybackNearlyFinished', make: (a, p) => A.audioPlayer('PlaybackNearlyFinished', p || {}, a) },
    ],
  },
  {
    name: 'device-buttons',
    // Device buttons on an Echo Show arrive as PlaybackController events, which
    // Alexa sends without session attributes. They only make sense once
    // something is playing, so establish that first -- pressing them cold is
    // covered separately by the two dedicated tests in skill.test.js.
    //
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'PlaybackController.PlayCommandIssued', make: (a, p) => A.playbackController('PlayCommandIssued', a, p) },
      { label: 'PlaybackController.PauseCommandIssued', make: (a, p) => A.playbackController('PauseCommandIssued', a, p) },
      { label: 'PlaybackController.NextCommandIssued', make: (a, p) => A.playbackController('NextCommandIssued', a, p) },
      { label: 'PlaybackController.PreviousCommandIssued', make: (a, p) => A.playbackController('PreviousCommandIssued', a, p) },
    ],
  },
  {
    name: 'audio-player-events',
    // What Alexa sends while a book is actually playing. AudioPlayerEventHandler
    // is ~90 lines that never ran under test, and it is what advances tracks and
    // reports progress back to Audiobookshelf during real listening.
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'AudioPlayer.PlaybackStarted', make: (a, p) => A.audioPlayer('PlaybackStarted', p || {}, a) },
      { label: 'AudioPlayer.PlaybackNearlyFinished', make: (a, p) => A.audioPlayer('PlaybackNearlyFinished', p || {}, a) },
      { label: 'AudioPlayer.PlaybackStopped', make: (a, p) => A.audioPlayer('PlaybackStopped', p || {}, a) },
      { label: 'AudioPlayer.PlaybackFinished', make: (a, p) => A.audioPlayer('PlaybackFinished', p || {}, a) },
    ],
  },
  {
    name: 'help-and-stop',
    steps: [
      { label: 'AMAZON.HelpIntent', make: () => A.intent('AMAZON.HelpIntent', {}, {}, true) },
      { label: 'AMAZON.StopIntent', make: (a, p) => A.intent('AMAZON.StopIntent', {}, a, false, p) },
    ],
  },
  {
    name: 'play-book-not-in-library',
    steps: [{ label: 'PlayBookIntent unknown title', make: () => A.intent('PlayBookIntent', { title: 'a book that does not exist anywhere' }, {}, true) }],
  },
  {
    name: 'go-to-chapter',
    steps: [
      { label: 'PlayLastIntent', make: () => A.intent('PlayLastIntent', {}, {}, true) },
      { label: 'GoToChapterX chapter 3', make: (a, p) => A.intent('GoToChapterX', { chapterNumber: '3' }, a, false, p) },
    ],
  },
  {
    name: 'session-ended',
    steps: [{ label: 'SessionEndedRequest', make: () => A.sessionEnded() }],
  },
];

module.exports = { scenarios };
