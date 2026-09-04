'use strict';
// Performance counters. These are module-level on purpose: a Lambda container
// serves one request at a time, and the handlers record into them as they go.

const timers = {
  context: {
    timestamp: null,
    absDatabaseSize: null,
    authorProvided: false,
    titleProvided: false,
  },
  amazonStuff: null,
  ABSapi: null,
  fuzzySearch: null,
  totalABSsearch: null,
  preparePlay: null,
  totalIntentTime: null
}

const timestamps = {
  PlaybackControllerHandlerStartTime: null,
  PlaybackControllerHandlerEndTime: null,
  AudioPlayerEventHandlerStartTime: null,
  AudioPlayerEventHandlerEndTime: null,
  PlayAudioIntentHandlerStartTime: null,
  PlayAudioIntentHandlerEndTime: null,
  PlayBookIntentHandlerStartTime: null,
  PlayBookIntentHandlerEndTime: null
};

// Reset by mutating in place, never by reassigning: other modules hold a
// reference to this object and would keep the stale one.
function clearTimers() {
  Object.assign(timers, {
    context: { timestamp: null, absDatabaseSize: null, authorProvided: false, titleProvided: false },
    amazonStuff: null,
    ABSapi: null,
    fuzzySearch: null,
    totalABSsearch: null,
    preparePlay: null,
    totalIntentTime: null,
  });
}

function resetTimestamps() {
  for (let key in timestamps) {
    if (timestamps.hasOwnProperty(key)) {
      timestamps[key] = null;
    }
  }
}

module.exports = { timers, timestamps, clearTimers, resetTimestamps };
