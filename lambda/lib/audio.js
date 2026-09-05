'use strict';
// Pure helpers: time, track and chapter arithmetic, plus speech sanitising.
// Nothing here touches configuration, the network, or skill state.

function calculateCurrentTime(playSession, currentTrackOffset, currentToken) {
  try {


    let currentIndex = currentToken;
    let currentTrack = playSession.audioTracks.filter(track => track.index == currentIndex)[0];

    if (!currentTrack) {
      return 0.0; // Return a default value if no track is found
    }

    let currentTime = currentTrack.startOffset + currentTrackOffset / 1000;

    // Ensure the result is a non-null float
    return (typeof currentTime === 'number' && !isNaN(currentTime)) ? parseFloat(currentTime) : 0.0;
  } catch (error) {
    console.error('Error calculating current book time:', error);
    return null
  }
}

function getCurrentTrackByBookTime(currentTime, userPlaySession) {
  try {
  let audioTracks = userPlaySession.audioTracks
  let currentTrack = null
  if (currentTime > userPlaySession.duration) { // validation
    console.error("currentTime is greater than book duration; check inputs; setting currentTrack to first track");
    currentTrack = audioTracks[0]
  }
  else {
    currentTrack = null;
    for (const track of audioTracks) {
      if (track.startOffset <= currentTime && (track.startOffset + track.duration) > currentTime) {
        currentTrack = track;
      }
    }

  }
  return currentTrack;
} catch (error) {
  console.error('getCurrentTrackByBookTime - Error retrieving current track:', error);
  return null
}
}

function getCurrentTrackIndexByBookTime(currentTime, userPlaySession) {
  try {
  let audioTracks = userPlaySession.audioTracks
  if (currentTime > userPlaySession.duration) { // validation
    console.error("currentTime is greater than book duration; check inputs; setting currentTrackIndex to first track");
    let currentTrack = audioTracks[0]
  }
  else {
    for (let i = 0; i < audioTracks.length; i++) {
      const track = audioTracks[i];
      if (track.startOffset <= currentTime && (track.startOffset + track.duration) > currentTime) {
        return i + 1;
      }
    }
    return null;
  }
} catch (error) {
  console.error('getCurrentTrackIndexByBookTime - Error retrieving current track index:', error);
  return null
}
}

function getCurrentChapterByBookTime(currentBookTime, playSession) {
  try {
    const chapters = playSession.chapters
    for (let i = 0; i < chapters.length; i++) {
      const isLastChapter = i === chapters.length - 1
      if (currentBookTime >= chapters[i].start
        && (currentBookTime < chapters[i].end || (isLastChapter && currentBookTime <= chapters[i].end))) {
        return chapters[i];
      }
    }
    return null; // Return null if no chapter is found
  } catch (error) {
    console.error('getCurrentChapterByBookTime - Error getting current chapter:', error);
  }
}

function getTrackAndOffsetFromBookTime(bookTime, userPlaySession) {
  // getCurrentTrackByBookTime takes the play session, not the track array.
  // Passing audioTracks made it read audioTracks.audioTracks (undefined) and
  // return null every time, so this function could never succeed.
  const currentTrack = getCurrentTrackByBookTime(bookTime, userPlaySession)
  const goalOffset = (bookTime - currentTrack.startOffset) * 1000
  return {
    currentTrack: currentTrack,
    goalOffset: goalOffset
  }
}

function isoDurationToMilliseconds(duration) {
  const regex = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/;
  const matches = duration.match(regex);

  let years = parseInt(matches[1] || 0);
  let months = parseInt(matches[2] || 0);
  let weeks = parseInt(matches[3] || 0);
  let days = parseInt(matches[4] || 0);
  let hours = parseInt(matches[5] || 0);
  let minutes = parseInt(matches[6] || 0);
  let seconds = parseInt(matches[7] || 0);

  // Convert all units to milliseconds
  const msInSecond = 1000;
  const msInMinute = 60 * msInSecond;
  const msInHour = 60 * msInMinute;
  const msInDay = 24 * msInHour;
  const msInWeek = 7 * msInDay;
  const msInMonth = 30 * msInDay; // Approximation
  const msInYear = 365 * msInDay; // Approximation

  return (
    years * msInYear +
    months * msInMonth +
    weeks * msInWeek +
    days * msInDay +
    hours * msInHour +
    minutes * msInMinute +
    seconds * msInSecond
  );
}

function sanitizeForSSML(input) {
  if (input) {
    // Remove characters that are not allowed in XML/SSML
    const disallowedRegex = /[\u0000-\u001F\u007F-\u009F]/g;
    let sanitizedInput = input.replace(disallowedRegex, '');

    // Escape special characters for XML
    const escapeXml = (str) => {
      return str.replace(/[<>&'"]/g, (char) => {
        switch (char) {
          case '<':
            return '&lt;';
          case '>':
            return '&gt;';
          case '&':
            return '&amp;';
          case '\'':
            return '&apos;';
          case '"':
            return '&quot;';
          default:
            return char;
        }
      });

    };

    sanitizedInput = escapeXml(sanitizedInput);

    // Further sanitize any remaining invalid sequences
    // If needed, add more logic here to validate input thoroughly

    return sanitizedInput;
  }
  else {
    return ""
  }
}

module.exports = { calculateCurrentTime, getCurrentTrackByBookTime, getCurrentTrackIndexByBookTime, getCurrentChapterByBookTime, getTrackAndOffsetFromBookTime, isoDurationToMilliseconds, sanitizeForSSML };
