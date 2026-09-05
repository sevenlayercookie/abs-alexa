'use strict';
const Alexa = require('ask-sdk-core');
const { ABS_API_KEY, SERVER_URL, baseheaders, resolveBackgroundUrl } = require('./lib/settings');
const { calculateCurrentTime, getCurrentTrackByBookTime, getCurrentTrackIndexByBookTime,
  getCurrentChapterByBookTime, getTrackAndOffsetFromBookTime, isoDurationToMilliseconds,
  sanitizeForSSML } = require('./lib/audio');
const { timers, timestamps, clearTimers, resetTimestamps } = require('./lib/timers');
const { getEntityData, fuzzyMatch, fuzzyStringMatch, searchBookWithAbsAPI, amazonCrossmatch,
  searchByTitleOnly } = require('./lib/search');
const { getLastPlayedLibraryItem, getItemById, startUserPlaySession, getExistingUserPlaySession,
  updateMediaProgress, updateUserPlaySession, closeUserPlaySession, getCoverUrl,
  getLibraryFilterData, getAllLibraries, getAllAudiobooks, getLibraryItems, getAuthor,
  searchFor } = require('./lib/abs-client');
const { createPlaybackToken, parsePlaybackToken } = require('./lib/playback-token');
//const { SsmlUtils } = require('ask-sdk-core');

let closedPlaySession = false

let localSessionAttributes = {
  playbackOwnerKey: null,
  userPlaySessionID: null,
  userPlaySession: null,
  offsetInMilliseconds: null,
  amazonToken: null,
  playUrl: null,
  currentBookTime: 0,
  nextStreamEnqueued: true
}

function playbackOwnerKey(handlerInput) {
  return handlerInput.requestEnvelope.context?.System?.user?.userId
    || handlerInput.requestEnvelope.session?.user?.userId
    || null;
}

function hasAlexaSession(handlerInput) {
  return Boolean(handlerInput.requestEnvelope.session);
}

function getAlexaSessionAttributes(handlerInput) {
  return hasAlexaSession(handlerInput)
    ? (handlerInput.attributesManager.getSessionAttributes() || {})
    : {};
}

function clearAlexaSessionAttributes(handlerInput) {
  if (hasAlexaSession(handlerInput)) {
    handlerInput.attributesManager.setSessionAttributes({});
  }
}

function incomingPlayerState(handlerInput) {
  const request = handlerInput.requestEnvelope.request || {};
  const player = handlerInput.requestEnvelope.context?.AudioPlayer || {};
  const rawToken = request.token ?? player.token ?? null;
  return {
    rawToken,
    token: parsePlaybackToken(rawToken),
    offsetInMilliseconds: request.offsetInMilliseconds ?? player.offsetInMilliseconds ?? null
  };
}

function isUsablePlaySession(value) {
  return Boolean(value?.libraryItemId && value?.id && Array.isArray(value.audioTracks) && value.audioTracks.length);
}

/**
 * Rebuild playback state after Alexa starts a new intent session or AWS moves
 * the request to a cold Lambda container. The opaque stream token identifies
 * the ABS play session; no separate database is required.
 */
function recoverPlaybackState(handlerInput) {
  const sessionAttributes = getAlexaSessionAttributes(handlerInput);
  const player = incomingPlayerState(handlerInput);
  const ownerKey = playbackOwnerKey(handlerInput);
  const ownedLocalAttributes = !localSessionAttributes.playbackOwnerKey
    || localSessionAttributes.playbackOwnerKey === ownerKey
    ? localSessionAttributes
    : {};
  let userPlaySession = sessionAttributes.userPlaySession || ownedLocalAttributes.userPlaySession;

  if (player.token?.libraryItemId && userPlaySession?.libraryItemId !== player.token.libraryItemId) {
    userPlaySession = null;
  }

  if (!isUsablePlaySession(userPlaySession) && player.token?.libraryItemId) {
    if (player.token.sessionId) {
      try {
        userPlaySession = getExistingUserPlaySession(player.token.sessionId);
      } catch (error) {
        console.log(`Playback recovery: ABS session unavailable (${error.message}); opening a replacement`);
      }
    }
    if (!isUsablePlaySession(userPlaySession)) {
      userPlaySession = startUserPlaySession(player.token.libraryItemId, handlerInput);
    }
  }

  if (!isUsablePlaySession(userPlaySession)) return null;
  delete userPlaySession.libraryItem;

  const fallbackToken = parsePlaybackToken(sessionAttributes.streamToken)
    || parsePlaybackToken(ownedLocalAttributes.streamToken)
    || parsePlaybackToken(sessionAttributes.amazonToken)
    || parsePlaybackToken(ownedLocalAttributes.amazonToken);
  const trackIndex = player.token?.trackIndex || fallbackToken?.trackIndex
    || getCurrentTrackIndexByBookTime(userPlaySession.currentTime || 0, userPlaySession);
  const currentTrack = userPlaySession.audioTracks.find((track) => track.index == trackIndex);
  if (!currentTrack) throw new Error(`Playback token refers to missing track ${trackIndex}`);

  const attributes = sessionAttributes;
  attributes.playbackOwnerKey = ownerKey;
  attributes.userPlaySession = userPlaySession;
  attributes.userPlaySessionID = userPlaySession.id;
  attributes.amazonToken = trackIndex;
  attributes.currentTrackIndex = trackIndex;
  attributes.currentTrack = currentTrack;
  attributes.streamToken = createPlaybackToken(userPlaySession, trackIndex);
  attributes.playUrl = SERVER_URL + currentTrack.contentUrl + "?token=" + ABS_API_KEY;
  attributes.nextStreamEnqueued = Boolean(
    userPlaySession.audioTracks[userPlaySession.audioTracks.indexOf(currentTrack) + 1]);
  if (player.offsetInMilliseconds !== null) {
    attributes.offsetInMilliseconds = player.offsetInMilliseconds;
  } else if (!Number.isFinite(attributes.offsetInMilliseconds)) {
    attributes.offsetInMilliseconds = 0;
  }

  updateLocalSessionAttributes(attributes);
  return {
    attributes,
    userPlaySession,
    trackIndex,
    rawToken: player.rawToken,
    offsetInMilliseconds: attributes.offsetInMilliseconds
  };
}

function noActivePlaybackResponse(handlerInput) {
  return handlerInput.responseBuilder
    .speak(sanitizeForSSML('Please ask me to play an audiobook first.'))
    .withShouldEndSession(true)
    .getResponse();
}

// Configuration resolves from the environment first, then config.js.
// config.js is gitignored; see config.example.js.

// const { off, title } = require('process');

// GLOBAL VARIABLES
//let playSession = null;

// AUDIOBOOKSHELF API CALL FUNCTIONS

/**
* Function to call the GET /api/items/:id endpoint
* @param {string} id - The ID of the item to retrieve
* @param {object} [options] - Optional query parameters
* @param {string[]} [options.include] - Entities to include (e.g., ['progress', 'rssfeed', 'downloads', 'share'])
* @param {number} [options.expanded] - Whether to expand the response (1 for true, undefined or 0 for false)
* @param {string} [options.episode] - Episode ID if including user media progress
* @returns {object} - The response body parsed as JSON
*/

/**
 * Update media progress for a library item or podcast episode.
 *
 * @param {string} baseUrl - The base URL of the API (e.g., "http://abs.example.com").
 * @param {string} libraryItemId - The ID of the library item.
 * @param {string} [episodeId] - (Optional) The ID of the podcast episode.
 * @param {object} data - The progress data to send in the PATCH request. Should include the following:
 *    - duration (Float): The total duration (in seconds) of the media.
 *    - progress (Float): The percentage completion progress of the media. Defaults to 0 or 1 (set to 1 if the media is finished).
 *    - currentTime (Float): The current time (in seconds) of your progress.
 *    - isFinished (Boolean): Whether the media is finished. Defaults to false.
 *    - hideFromContinueListening (Boolean): Whether the media will be hidden from the "Continue Listening" shelf. Defaults to false.
 *    - finishedAt (Integer|null): The time (in ms since POSIX epoch) when the user finished the media. Defaults to Date.now() if isFinished is true.
 *    - startedAt (Integer): The time (in ms since POSIX epoch) when the user started consuming the media. Defaults to finishedAt if isFinished is true.
 * @returns {object} - The API response.
 * @throws {Error} - Throws an error if the request fails.
 */

// INTENT HANDLERS

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    const speakOutput = 'Welcome to Audiobookshelf, you can say "play audiobook" to start listening.';

    console.log(" ~~~ LOGGED AT END OF LaunchRequestHandler ")
    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

/**
 * Intent handler to start playing an audio file.
 * By default, it will play a specific audio stream.
 * */
const PlayAudioIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'PlayAudioIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'PlayLastIntent');
  },
  async handle(handlerInput) {

    try {
      let timeStart = timestamps.PlayAudioIntentHandlerStartTime = new Date();
      let userPlaySession
      let lastPlayedLibraryItem
      let expandedItem
      let lastPlayedID

      let mediaProgress
      let currentTime

      const playBehavior = 'REPLACE_ALL';

      const sessionAttributes = getAlexaSessionAttributes(handlerInput); // cannot set sessionAttriubtes and localAttributes equal
      const recoveredState = recoverPlaybackState(handlerInput);
      // *** if user is just pausing and resuming, don't need to
      // start a new session everytime.
      // so check for existing and use that.

      const existingSession = recoveredState?.userPlaySession || sessionAttributes.userPlaySession
      let existingAttributes = (sessionAttributes && Object.keys(sessionAttributes).length > 0)
        ? sessionAttributes
        : recoveredState?.attributes || null;
      if (existingSession && existingAttributes) // if session in progress, just resume that
      {
        //userPlaySession = getExistingUserPlaySession(sessionAttributes.userPlaySession.id)
        userPlaySession = sessionAttributes.userPlaySession || localSessionAttributes.userPlaySession

      }
      // if no session already in progress, find last played audiobook
      else {
        lastPlayedLibraryItem = getLastPlayedLibraryItem()
        lastPlayedID = lastPlayedLibraryItem.id

        expandedItem = getItemById(lastPlayedID, { include: ['progress'], expanded: 1 });

      }

      if (!userPlaySession) { // open new playsession if needed
        userPlaySession = startUserPlaySession(lastPlayedID, handlerInput)
      }
      delete userPlaySession.libraryItem // this property is very large and not useful
      // playSession = userPlaySession
      if (!existingSession) {
        mediaProgress = expandedItem.userMediaProgress
        currentTime = mediaProgress.currentTime
        if (currentTime > userPlaySession.duration) { // validation
          currentTime = 0.0 // start at beginning
          //updateMediaProgress(SERVER_URL, lastPlayedID, mediaProgress.episodeId, { currentTime: 0.0, duration: userPlaySession.duration })
          updateUserPlaySession(userPlaySession, 0.0)
        }
      }
      else {
        currentTime = existingSession.currentTime

      }
      sessionAttributes.userPlaySession = userPlaySession

      sessionAttributes.userPlaySessionID = userPlaySession.id // can call API to pull the whole playSession again if needed

      let currentTrack = sessionAttributes.currentTrack = getCurrentTrackByBookTime(currentTime, userPlaySession)
      let currentTrackIndex = sessionAttributes.amazonToken = getCurrentTrackIndexByBookTime(currentTime, userPlaySession) // should start at 1
      sessionAttributes.streamToken = createPlaybackToken(userPlaySession, currentTrackIndex)

      sessionAttributes.currentTrackIndex = currentTrackIndex;
      let trackStartOffset = currentTrack.startOffset
      const offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = (currentTime - trackStartOffset) * 1000

      if (userPlaySession.audioTracks[currentTrackIndex]) { // if there is another track that exists after the current track
        sessionAttributes.nextStreamEnqueued = true
        localSessionAttributes.nextStreamEnqueued = true
      }
      else {
        sessionAttributes.nextStreamEnqueued = false
        localSessionAttributes.nextStreamEnqueued = false
      }
      const coverUrl = sessionAttributes.coverUrl = getCoverUrl(userPlaySession.libraryItemId)

      const chapterTitle = getCurrentChapterByBookTime(currentTime, userPlaySession).title
      const author = userPlaySession.displayAuthor
      const bookTitle = userPlaySession.displayTitle
      const playUrl = sessionAttributes.playUrl = SERVER_URL + userPlaySession.audioTracks[currentTrackIndex - 1].contentUrl + "?token=" + ABS_API_KEY
      // const playUrl = SERVER_URL + userPlaySession.audioTracks[0].contentUrl + "?token=" + ABS_API_KEY
      retainPlaybackStateLocally(handlerInput, sessionAttributes)

      let timeEnd = timestamps.PlayAudioIntentHandlerEndTime = new Date();
      let totalIntentTime = timeEnd - timeStart
      console.log("TIMER: Total Intent Time (PlayAudioIntent): " + totalIntentTime + " ms");

      const metadata = {
        title: chapterTitle,
        subtitle: bookTitle,
        art: {
          sources: [
            {
              url: coverUrl,
              widthPixels: 512, // these seem to be necessary even though docs say it's not
              heightPixels: 512
            }
          ]
        },
        backgroundImage: {
          sources: [
            {
              url: resolveBackgroundUrl(coverUrl),
              widthPixels: 1600,
              heightPixels: 900
            }
          ]
        }
      };
      let speakOutput
      if (existingSession) {
        //speakOutput = 'Resuming...';
      }
      else {
        speakOutput = 'Playing ' + bookTitle + " by " + author;
      }
      console.log(`Playing Audiobookshelf item ${userPlaySession.libraryItemId}, track ${currentTrackIndex}`)

      return handlerInput.responseBuilder
        .speak(sanitizeForSSML(speakOutput))
        .addAudioPlayerPlayDirective(
          playBehavior,
          playUrl,
          sessionAttributes.streamToken,
          offsetInMilliseconds, // offset in ms
          null,          // expected previous token (don't include if playBehavior is REPLACE)
          metadata
        )
        .withShouldEndSession(true)
        .getResponse();
    }
    catch (error) {
      console.error("Error during PlayAudioIntentHandler: " + error)
      throw error
    }
  }

};

// const { match } = require('assert');

// Function to perform fuzzy string matching, for simple strings 1 to 1

/**
 * function to search all ABS audiobook libraries for bookTitle
 * @param {*} bookTitle
 * @returns
 */

const PlayBookIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'PlayBookIntent');
  },
  async handle(handlerInput) {
    // using a custom handler allows me to use Amazon book and author matching,
    // but prevents the sessions from being remembered (so user will have to reinvoke the skill after this)

    // this will never be invoked to resume, so should start all variables from scratch
    clearAllMemory(handlerInput)

    let rawAuthor = handlerInput.requestEnvelope.request.intent.slots.author.value || null
    let rawTitle = handlerInput.requestEnvelope.request.intent.slots.title.value || null
    const accessToken = handlerInput.requestEnvelope.context.System.apiAccessToken // amazon API token
    const authorResolutions = handlerInput.requestEnvelope.request.intent.slots.author.resolutions?.resolutionsPerAuthority?.[0] || null
    const titleResolutions = handlerInput.requestEnvelope.request.intent.slots.title.resolutions?.resolutionsPerAuthority?.[0] || null
    let amazonAuthor = handlerInput.requestEnvelope.request.intent.slots.author.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name ?? null
    let amazonTitle = handlerInput.requestEnvelope.request.intent.slots.title.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name ?? null
    let author = handlerInput.requestEnvelope.request.intent.slots.author.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name
      ?? handlerInput.requestEnvelope.request.intent.slots.author.value;
    let bookTitle = handlerInput.requestEnvelope.request.intent.slots.title.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name
      ?? handlerInput.requestEnvelope.request.intent.slots.title.value;

    if (rawAuthor) { timers.context.authorProvided = true }
    if (rawTitle) { timers.context.titleProvided = true }
    timers.context.timestamp = timestamps.PlayBookIntentHandlerStartTime = new Date()

    // require a book title (could later implement playing by author I suppose, maybe in another intent)
    if (!bookTitle) {
      let speakOutput = 'I did not understand the request. For example, try saying "Play audiobook title by author".';
      console.log("Book and/or author slot undefined")
      return handlerInput.responseBuilder
        .speak(speakOutput)
        .reprompt(speakOutput)
        .getResponse();

    }
    // #region ******* SEARCH STUFF *******
    const amazonStuffStart = new Date();
    // quick fuzzy check here to make sure not getting other languages etc.
    let amazonResolutionFailed = false
    let quickFuzzyCheck = fuzzyStringMatch(bookTitle, rawTitle)
    if (!quickFuzzyCheck) {
      bookTitle = rawTitle // set it back to the user's request if it's way off (such as wrong language)
      amazonTitle = null // clear amazon's guess
      //amazonResolutionFailed = true
    }
    const quickFuzzyCheckAuthor = fuzzyStringMatch(author, rawAuthor)
    if (!quickFuzzyCheckAuthor) {
      author = rawAuthor // set it back to the user's request if it's way off
      amazonAuthor = null // clear amazon's guess
      //amazonResolutionFailed = true
    }

    // VALIDATION CROSS MATCH FUNCTION HERE (check Amazon returned title vs returned author)
    // should loop through all matched authors and compare against all matched books (by polling the Amazon API)
    // exit the loop as soon as a match is made

    // cross match function is working, but is it necessary? how should I use the result?
    // if it fails, should I throw out any title and author amazon resolved?
    if (authorResolutions && titleResolutions && authorResolutions.status.code == "ER_SUCCESS_MATCH"
      && titleResolutions.status.code == "ER_SUCCESS_MATCH") { // if Amazon found at least one match for both author and title

      const validItems = amazonCrossmatch(titleResolutions, authorResolutions, accessToken)

      if (!validItems.validAuthors.length || !validItems.validTitles.length) {
        let amazonCrossmatchFailed = true // amazon's proposed titles and authors did not match
        console.log("Amazon cross match failed")
      }
      else {
        console.log("Amazon cross match passed! " + validItems.validTitles[0] + " by " + validItems.validAuthors[0])
        // now use the matched title and author?
        amazonTitle = bookTitle = validItems.validTitles[0]
        amazonAuthor = author = validItems.validAuthors[0]
      }

    }

    if (amazonTitle && !amazonAuthor && bookTitle) { // if Amazon matched only a book title, then look up the Amazon author
      const bookUrl = handlerInput.requestEnvelope.request.intent.slots.title.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.id
        ?? null
      if (bookUrl) {
        const bookData = getEntityData(bookUrl, accessToken, "en-US")
        if (bookData) {
          amazonAuthor = author = bookData["entertainment:author"][0].name[0]["@value"] // grab main/first author
          // english ? set book name from here?
          amazonTitle = bookTitle = bookData.name[0]["@value"]

        }
      }
    }
    if (amazonAuthor && !amazonTitle && rawTitle) { // if Amazon matched only a book author, then look up their books
      const authorUrl = handlerInput.requestEnvelope.request.intent.slots.author.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.id
        ?? null
      if (authorUrl) {
        const authorData = getEntityData(authorUrl, accessToken, "en-US")
        if (authorData) {
          // attempt to match the amazon book title from the rawTitle
          const key = {
            name: 'title',
            getFn: (item) => item.name[0]["@value"]
          };
          const options = {
            searchData: authorData["entertainment:authorOf"],
            searchKey: rawTitle,
            key: key,
            threshold: 0.6,
            arrayOrBest: 'array',
            scoreThreshold: 0.4
          }

          let matchedTitles = fuzzyMatch(options)
          const matchedTitle = matchedTitles?.[0].item ?? null
          if (matchedTitle) {
            const matchedTitleString = matchedTitle.item.name[0]["@value"]
            console.log("Found title '" + matchedTitleString + "' that correlates to author '" + amazonAuthor + "'")
            amazonTitle = bookTitle = matchedTitleString
          }
        }
      }
    }
    if (!amazonTitle || !amazonAuthor) { amazonResolutionFailed = true }
    if (amazonResolutionFailed) {
      //logic to either return error or pursue other attempts to match book, like via ABS
      console.log("Could not Amazon match '" + bookTitle + "'. Moving on to ABS search")
    }

    const amazonStuffEnd = new Date();
    const amazonElapsedTime = amazonStuffEnd - amazonStuffStart
    console.log("TIMER: Amazon stuff: " + amazonElapsedTime + " ms")
    timers.amazonStuff = amazonElapsedTime
    // ~~~~~ END OF AMAZON RESOLUTION SECTION ~~~~~

    // ~~~~~ BEGING ABS SEARCH ~~~~~
    const ABSsearchStart = new Date();
    let libraryItem = null
    let absMatchedAuthor = null
    // SEARCH THROUGH ABS LIBRARY FIRST USING AMAZON RESOLUTION DATA, THEN AGAIN USING RAW DATA (if still needed)

    for (let i = 0; i < 2 && !libraryItem; i++) // up to two loops, and only if libraryItem not found
    {
      if (i == 0) // if first run through loop, try Amazon author and title
      {
        if (amazonAuthor || amazonTitle) // is there any amazon data?
        {
          console.log("Searching ABS with Amazon data")
          if (amazonAuthor) {
            author = amazonAuthor
            console.log("Amazon author: " + amazonAuthor)
          }
          else { console.log("Raw author: " + author) }
          if (amazonTitle) {
            bookTitle = amazonTitle
            console.log("Amazon title: " + amazonTitle)
          }
          else { console.log("Raw title: " + bookTitle) }

        }
        else { // if no amazon data in first loop, just use the raw data and skip repeating the loop
          i = 1
          bookTitle = rawTitle
          author = rawAuthor
          console.log("No Amazon data resolution. Start searching ABS with raw data")
        }
      }
      else // if second time through, just search raw data
      {
        bookTitle = rawTitle
        author = rawAuthor
        console.log("No Amazon data resolution. Start searching ABS with raw data")
      }

      if (bookTitle && author) { // if I'm given both author and book

        // START BY SEARCHING FOR THE AUTHOR FIRST, THEN MATCHING TITLES TO THAT AUTHOR
        const allLibraries = getAllLibraries()
        const bookLibraries = allLibraries.filter(library => library.mediaType === 'book');
        const audiobooksOnlyLibraries = bookLibraries.filter(library => library.settings.audiobooksOnly);
        const bookLibraryIDs = audiobooksOnlyLibraries.map(library => library.id);

        const filterdata = getLibraryFilterData(bookLibraryIDs[0]) // find all authors in library

        // fuzzy match author
        const options = {
          searchData: filterdata.authors,
          searchKey: author,
          key: 'name',
          threshold: 0.6, // fuzziness
          arrayOrBest: 'array',
          scoreThreshold: 0.6  // score cut off
        }
        const absMatchedAuthors = fuzzyMatch(options)
        absMatchedAuthor = absMatchedAuthors?.[0].item // take best match

        if (absMatchedAuthor) {
          console.log("Matched author: " + absMatchedAuthor.name + " in ABS library!")

          const authorResult = getAuthor(absMatchedAuthor.id)
          const libraryItems = authorResult.libraryItems

          // fuzzy match title
          const optionsTitle = {
            searchData: libraryItems,
            searchKey: bookTitle, // or rawTitle?
            key: 'media.metadata.title',
            threshold: 0.6, // fuzziness
            arrayOrBest: 'array',
            scoreThreshold: 0.6  // score cut off
          }
          const absMatchedTitles = fuzzyMatch(optionsTitle)
          const absMatchedTitle = absMatchedTitles?.[0].item // take best match

          libraryItem = absMatchedTitle || null;
        }
        if (!absMatchedAuthor || !libraryItem) {
          // IF CAN'T FIND AUTHOR (or still haven't found a book), TRY AND SEARCH BY BOOK TITLE ALONE
          if (!absMatchedAuthor) {
            console.log("Could not find author: " + author + " in ABS library")
          }
          // console.log("Search ABS by title: " + bookTitle) //function logs this
          const options =
          {
            bookTitle: bookTitle,
            APIsearch: true,
            fuzzySearch: true
          }
          libraryItem = searchByTitleOnly(options)
          if (libraryItem) {
            console.log("Found a book in ABS by title search only!")
          }
        }
      }
      else if (bookTitle && !author) { // if only given book title
        const options =
        {
          bookTitle: bookTitle,
          APIsearch: true,
          fuzzySearch: true
        }
        libraryItem = searchByTitleOnly(options)
      }
    }
    // if an author was found, could offer to play one of their other books instead?
    // Would probably need to forward it to another intent..
    if (libraryItem) {
      console.log("Found a book in the library!")
      console.log("Title: " + libraryItem.media.metadata.title);
      console.log("Author: " + libraryItem.media.metadata.authorName);
    }
    else {
      console.log("Could not find a playable book (" + rawTitle + " by " + rawAuthor + ")")
      let speakOutput = "Could not find a playable book matching: " + rawTitle + " by " + rawAuthor + ". Please try again."
      return handlerInput.responseBuilder
        .speak(sanitizeForSSML(speakOutput))
        .reprompt(sanitizeForSSML(speakOutput))
        .getResponse();
    }

    const ABSsearchEnd = new Date();
    const ABSsearchTime = ABSsearchEnd - ABSsearchStart
    console.log("TIMER: ABS search time: " + ABSsearchTime + " ms")
    timers.totalABSsearch = ABSsearchTime

    // #endregion 'Search Stuff'

    // START PLAYING THE BOOK
    let userPlaySession

    const playBehavior = 'REPLACE_ALL';

    const libraryItemID = libraryItem.id

    let expandedItem = getItemById(libraryItemID, { include: ['progress'], expanded: 1 });

    // *** this intent presumed to always start a new play session ***
    // *** OR: if I start using persistent attributes, I can keep track of all
    // prior play sessions and resume them over time
    userPlaySession = startUserPlaySession(libraryItemID, handlerInput)
    delete userPlaySession.libraryItem // this property very large and nothing useful
    // playSession = userPlaySession

    const sessionAttributes = getAlexaSessionAttributes(handlerInput); // cannot set sessionAttriubtes and localAttributes equal
    localSessionAttributes = JSON.parse(JSON.stringify(sessionAttributes)); // clone sessionAttriubtes (avoid pointer issue)

    let mediaProgress = expandedItem.userMediaProgress

    sessionAttributes.userPlaySession = userPlaySession
    sessionAttributes.userPlaySessionID = userPlaySession.id // can call API to pull the whole playSession again if needed

    let currentTime = mediaProgress?.currentTime ?? 0.0;
    if (currentTime > userPlaySession.duration) { // validation
      currentTime = 0.0 // start at beginning
      updateUserPlaySession(userPlaySession, currentTime) // update ABS with 0 time
    }
    let currentTrack = sessionAttributes.currentTrack = getCurrentTrackByBookTime(currentTime, userPlaySession)
    let currentTrackIndex = sessionAttributes.amazonToken = getCurrentTrackIndexByBookTime(currentTime, userPlaySession) // should start at 1
    sessionAttributes.streamToken = createPlaybackToken(userPlaySession, currentTrackIndex)
    sessionAttributes.currentTrackIndex = currentTrackIndex;
    let trackStartOffset = currentTrack.startOffset
    const offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = (currentTime - trackStartOffset) * 1000

    if (userPlaySession.audioTracks[currentTrackIndex]) { // if there's a next track, set a flag
      localSessionAttributes.nextStreamEnqueued = true
    }
    else {
      localSessionAttributes.nextStreamEnqueued = false
    }

    const playUrl = sessionAttributes.playUrl = SERVER_URL + userPlaySession.audioTracks[currentTrackIndex - 1].contentUrl + "?token=" + ABS_API_KEY

    const coverUrl = getCoverUrl(userPlaySession.libraryItemId)
    retainPlaybackStateLocally(handlerInput, sessionAttributes)

    let speakOutput = 'Playing ' + userPlaySession.displayTitle + ' by ' + userPlaySession.displayAuthor;
    console.log(`Playing Audiobookshelf item ${userPlaySession.libraryItemId}, track ${currentTrackIndex}`)

    let chapterTitle = getCurrentChapterByBookTime(currentTime, userPlaySession).title

    // chapterTitle = chapterTitle // remove any invalid characters

    const subtitle = userPlaySession.displayTitle

    const metadata = {
      title: chapterTitle,
      subtitle: subtitle,
      art: {
        sources: [
          {
            url: coverUrl,
            widthPixels: 512, // these seem to be necessary even though docs say it's not
            heightPixels: 512
          }
        ]
      },
      backgroundImage: {
        sources: [
          {
            url: resolveBackgroundUrl(coverUrl),
            widthPixels: 1600,
            heightPixels: 900
          }
        ]
      }
    };

    const timeBeforeResponse = timestamps.PlayBookIntentHandlerEndTime = new Date();
    const timeUntilResponse = timeBeforeResponse - ABSsearchEnd
    const totalIntentTime = timeBeforeResponse - amazonStuffStart
    console.log("TIMER: Time after ABS search until skill response: " + timeUntilResponse + " ms")
    console.log("TIMER: Total intent time (PlayBookIntent): " + totalIntentTime + " ms")
    timers.totalIntentTime = totalIntentTime
    timers.preparePlay = timeUntilResponse
    clearTimers();

    // ways to speed up the Intent:
    //  1) consider asynchronous functions (like maybe do API search and fuzzy search at same time?)
    //  2) triage better to avoid running all functions (like only do API search for amazon matched strings)
    //  3) maybe throw out API call completely (it's not as good as fuzzy search anyways)
    //    - only problem is not sure how well fuzzy will do with large libraries; might be really slow...
    return handlerInput.responseBuilder
      .speak(sanitizeForSSML(speakOutput))
      .addAudioPlayerPlayDirective(
        playBehavior,
        playUrl,
        sessionAttributes.streamToken,
        offsetInMilliseconds, // offset in ms
        null,          // expected previous token (don't include if playBehavior is REPLACE)
        metadata
      )
      .withShouldEndSession(true)
      .getResponse();
  }
};

const PauseAudioIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PauseIntent';
  },
  async handle(handlerInput) {
    try {
      const state = recoverPlaybackState(handlerInput)
      if (state && state.offsetInMilliseconds !== null) {
        const { attributes: sessionAttributes, userPlaySession,
          offsetInMilliseconds, trackIndex } = state
        const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, trackIndex)

        updateUserPlaySession(userPlaySession, currentBookTime)
        sessionAttributes.userPlaySession.updatedAt = Date.now()
        sessionAttributes.userPlaySession.currentTime = currentBookTime

        retainPlaybackStateLocally(handlerInput, sessionAttributes)
      }
      return handlerInput.responseBuilder
        .addAudioPlayerStopDirective()
        .withShouldEndSession(true)
        .getResponse();
    }
    catch (error) {
      // Stopping the Echo is more important than syncing progress. Returning a
      // valid Stop directive also prevents Alexa's INVALID_RESPONSE fallback.
      console.error(`PauseAudioIntentHandler: could not sync progress (${error.message})`)
      return handlerInput.responseBuilder
        .addAudioPlayerStopDirective()
        .withShouldEndSession(true)
        .getResponse();
    }

  }
};

/**
 * Seeks to beginning of either this chapter or of the previous chapter
 */
const PreviousIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PreviousIntent';
  },
  async handle(handlerInput) {
    const state = recoverPlaybackState(handlerInput)
    if (!state) return noActivePlaybackResponse(handlerInput)
    const { attributes: sessionAttributes, userPlaySession, offsetInMilliseconds, trackIndex } = state

    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, trackIndex)

    // default behavior: go to beginning of chapter. If within 5 seconds of beginning, go to previous chapter
    const currentChapter = getCurrentChapterByBookTime(currentBookTime, userPlaySession)
    const chapterIndex = userPlaySession.chapters.indexOf(currentChapter)
    const previousChapter = chapterIndex > 0 ? userPlaySession.chapters[chapterIndex - 1] : null
    const targetChapter = currentBookTime > currentChapter.start + 5
      ? currentChapter
      : (previousChapter || userPlaySession.chapters[0])
    const newBookTime = targetChapter.start
    updateUserPlaySession(userPlaySession, newBookTime)
    const playback = applyBookTimeToAttributes(sessionAttributes, userPlaySession, newBookTime)
    retainPlaybackStateLocally(handlerInput, sessionAttributes)

    return handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        playback.playUrl,
        playback.streamToken,
        playback.offsetInMilliseconds,
        null,
        buildPlaybackMetadata(userPlaySession, newBookTime)
      )
      .withShouldEndSession(true)
      .getResponse();
  }
}

/**
 * Seeks to beginning of either this chapter or of the previous chapter
 */
const NextIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NextIntent';
  },
  async handle(handlerInput) {
    const state = recoverPlaybackState(handlerInput)
    if (!state) return noActivePlaybackResponse(handlerInput)
    const { attributes: sessionAttributes, userPlaySession, offsetInMilliseconds, trackIndex } = state
    const chapters = userPlaySession.chapters

    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, trackIndex)

    const currentChapter = getCurrentChapterByBookTime(currentBookTime, userPlaySession)
    const chapterIndex = chapters.indexOf(currentChapter)
    const nextChapter = chapters[chapterIndex + 1]
    if (!nextChapter) {
      console.log('NextIntent: already in the final chapter')
      retainPlaybackStateLocally(handlerInput, sessionAttributes)
      return handlerInput.responseBuilder
        .speak(sanitizeForSSML('This is the last chapter of ' + userPlaySession.displayTitle + '.'))
        .withShouldEndSession(true)
        .getResponse()
    }
    const newBookTime = nextChapter.start
    updateUserPlaySession(userPlaySession, newBookTime)
    const playback = applyBookTimeToAttributes(sessionAttributes, userPlaySession, newBookTime)
    retainPlaybackStateLocally(handlerInput, sessionAttributes)

    return handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        playback.playUrl,
        playback.streamToken,
        playback.offsetInMilliseconds,
        null,
        buildPlaybackMetadata(userPlaySession, newBookTime)
      )
      .withShouldEndSession(true)
      .getResponse();
  }
}

const GoBackXTimeIntentHandler = { // THIS LIKELY ENDS and FORGETS THE SESSION (custom intents do not "remember" session after it closes)
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GoBackXTimeIntent';
  },
  async handle(handlerInput) {
    const state = recoverPlaybackState(handlerInput)
    if (!state) return noActivePlaybackResponse(handlerInput)
    const { attributes: sessionAttributes, userPlaySession,
      offsetInMilliseconds: currentOffsetInMilliseconds, trackIndex: currentToken } = state

    const beforeBookTime = calculateCurrentTime(userPlaySession, currentOffsetInMilliseconds, currentToken)
    const timeCode = handlerInput.requestEnvelope.request.intent.slots.time.value
    const milliseconds = isoDurationToMilliseconds(timeCode)
    const afterBookTime = Math.max(0, beforeBookTime - milliseconds / 1000)
    const playback = applyBookTimeToAttributes(sessionAttributes, userPlaySession, afterBookTime)
    console.log("Before skip: " + beforeBookTime + " seconds")
    console.log("After skip: " + afterBookTime + " seconds")

    retainPlaybackStateLocally(handlerInput, sessionAttributes)

    return handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        playback.playUrl,
        playback.streamToken,
        playback.offsetInMilliseconds,
        null,
        buildPlaybackMetadata(userPlaySession, afterBookTime)
      )
      .withShouldEndSession(true)
      .getResponse();
  }
}

const GoForwardXTimeIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GoForwardXTimeIntent';
  },
  async handle(handlerInput) {
    const state = recoverPlaybackState(handlerInput)
    if (!state) return noActivePlaybackResponse(handlerInput)
    const { attributes: sessionAttributes, userPlaySession,
      offsetInMilliseconds: currentOffsetInMilliseconds, trackIndex: currentToken } = state

    const timeCode = handlerInput.requestEnvelope.request.intent.slots.time.value
    const milliseconds = isoDurationToMilliseconds(timeCode)
    const beforeBookTime = calculateCurrentTime(userPlaySession, currentOffsetInMilliseconds, currentToken)
    const requestedBookTime = beforeBookTime + milliseconds / 1000
    const afterBookTime = requestedBookTime >= userPlaySession.duration
      ? Math.max(0, userPlaySession.duration - 5)
      : requestedBookTime
    const playback = applyBookTimeToAttributes(sessionAttributes, userPlaySession, afterBookTime)
    console.log("Before skip: " + beforeBookTime + " seconds")
    console.log("After skip: " + afterBookTime + " seconds")
    console.log("Seconds skipped: " + (parseInt(afterBookTime) - parseInt(beforeBookTime)).toString() + " seconds");

    retainPlaybackStateLocally(handlerInput, sessionAttributes)

    return handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        playback.playUrl,
        playback.streamToken,
        playback.offsetInMilliseconds,
        null,
        buildPlaybackMetadata(userPlaySession, afterBookTime)
      )
      .withShouldEndSession(true)
      .getResponse();
  }
}

/**
 * Intent handler for built-in intents that aren't supported in this skill.
 * Regardless, the skill needs to handle this gracefully, which is why this handler exists.
 * */
const UnsupportedAudioIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (
        Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.LoopOffIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.LoopOnIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.RepeatIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ShuffleOffIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ShuffleOnIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StartOverIntent'
      );
  },
  async handle(handlerInput) {
    const speakOutput = 'Sorry, I can\'t support that yet.';

    return handlerInput.responseBuilder
      .speak(sanitizeForSSML(speakOutput))
      .getResponse();
  }
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    const speakOutput = 'You can say "play audio" to start playing your book! How can I help?';

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

/**
 * Handles "Cancel" and "Stop", but notably not "Exit" or "Quit", which are handled by SessionEndedHandler
 * This should end the skill completely
 */
const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
  },
  handle(handlerInput) {
    const speakOutput = 'Goodbye!';

    try {
      const state = recoverPlaybackState(handlerInput)
      if (state && state.offsetInMilliseconds !== null) {
        const currentBookTime = calculateCurrentTime(
          state.userPlaySession, state.offsetInMilliseconds, state.trackIndex)
        if (closeUserPlaySession(state.userPlaySession, currentBookTime) == 0) {
          closedPlaySession = true
        }
      } else {
        console.log("CancelAndStopIntentHandler: no recoverable playback state")
      }
    } catch (error) {
      console.error(`CancelAndStopIntentHandler: could not close ABS session (${error.message})`)
    }
    console.log("CancelAndStopIntentHandler: closing Alexa skill")
    const response = handlerInput.responseBuilder
      .speak(sanitizeForSSML(speakOutput))
      .addAudioPlayerStopDirective()
      .withShouldEndSession(true)
      .getResponse();
    clearAllMemory(handlerInput)
    return response
  }
};
/* *
 * AudioPlayer events can be triggered when users interact with your audio playback, such as stopping and
 * starting the audio, as well as when playback is about to finish playing or playback fails.
 * This handler will save the appropriate details for each event and log the details of the exception,
 * which can help troubleshoot issues with audio playback.
 * */
const AudioPlayerEventHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type.startsWith('AudioPlayer.');
  },
  async handle(handlerInput) {
    let audioPlayerEventName;
    let audioPlayerEventStartTime;
    try {
      // *** AudioPlayerEventHandler can NOT access sessionAttributes
      // need another way of communicating; localSessionAttributes? persistent attributes?

      // must use localSessionAttributes, and then update sessionAttributes when available

      // this offset isn't always being set; is offsetInMilliseconds passed in different
      // parts of handlerInput sometimes?
      audioPlayerEventStartTime = timestamps.AudioPlayerEventHandlerStartTime = new Date();

      audioPlayerEventName = handlerInput.requestEnvelope.request.type.split('.')[1];
      console.log(`AudioPlayer event encountered: ${handlerInput.requestEnvelope.request.type}`);

      const state = recoverPlaybackState(handlerInput);
      const offset = state?.offsetInMilliseconds;
      if (offset == null) {
        console.log("offsetInMilliseconds wasn't pulled from handlerInput correctly");
      }
      const amazonToken = state?.trackIndex;
      const streamToken = state?.rawToken || state?.attributes.streamToken;
      if (amazonToken == null) {
        console.log("amazonToken wasn't pulled from handlerInput correctly");
      }
      let currentBookTime
      const userPlaySession = state?.userPlaySession;
      if (!userPlaySession || offset == null || amazonToken == null) {
        console.log("userPlaySession, offset, or amazonToken was undefined; cannot sync progress");
      }
      else {
        currentBookTime = calculateCurrentTime(userPlaySession, offset, amazonToken);
      }

      let returnResponseFlag = false;
      let offsetInMilliseconds
      switch (audioPlayerEventName) {
        case 'PlaybackStarted':
          // NEW CODE
          // need to write just "token" to ABS here, at minimum
          //  token (filename? fileID?)
          // but maybe should sync with ABS anyways just to timestamp playback start time
          // could do this in the intent though
          //offsetInMilliseconds = handlerInput.requestEnvelope.request.offsetInMilliseconds
          //?? handlerInput.requestEnvelope.context.AudioPlayer?.offsetInMilliseconds
          //?? null

          // if (offsetInMilliseconds !== null) {
          //   const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)
          //   updateUserPlaySession(userPlaySession, currentBookTime)
          // }
          // else {
          //   console.log("PlaybackStopped: offsetInMilliseconds was null; couldn't update ABS")
          // }
          /// END NEW CODE
          console.log("PlaybackStarted")
          let PlaybackStartedTime = new Date();
          if (timestamps.PlayAudioIntentHandlerStartTime) {
            console.log("TIMER: Time from PlayAudioIntentHandlerStart to PlaybackStarted: " + (PlaybackStartedTime - timestamps.PlayAudioIntentHandlerStartTime) + " ms");
          }
          if (timestamps.PlayBookIntentHandlerStartTime) {
            console.log("TIMER: Time from PlayBookIntentHandlerStart to PlaybackStarted: " + (PlaybackStartedTime - timestamps.PlayBookIntentHandlerStartTime) + " ms");
          }

          if (!userPlaySession || currentBookTime === undefined) {
          }
          else {
            // updateUserPlaySession(userPlaySession, currentBookTime);
            localSessionAttributes.userPlaySession.updatedAt = Date.now();
            localSessionAttributes.userPlaySession.currentTime = currentBookTime;
          }

          returnResponseFlag = true;
          break;

        case 'PlaybackFinished': // run when playback finishes on its own
          if (localSessionAttributes.nextStreamEnqueued) {
            if (!userPlaySession || currentBookTime === undefined) {
            }
            else {
              updateUserPlaySession(userPlaySession, currentBookTime);
              localSessionAttributes.userPlaySession.updatedAt = Date.now();
              localSessionAttributes.userPlaySession.currentTime = currentBookTime;
            }
          } else { // if no stream enqueued, then likely the end of the book. Close the play session
            //const timeListened = (Date.now() - userPlaySession.updatedAt) / 1000;

            if (!userPlaySession || currentBookTime === undefined) {
            }
            else {
              closeUserPlaySession(userPlaySession, currentBookTime);
              // PlaybackFinished is the terminal handler -- it doesn't mvoe on to PlaybackStopped
            }
            // book end, clear all attributes
            console.log("PlaybackFinished (book end?): clearing all memory")
            clearAllMemory();

            // localSessionAttributes = {}
            // // actual session attributes should automatically be cleared by Alexa
            // closedPlaySession = false
            // nextStreamEnqueued = false
            // clearTimers();
            // resetTimestamps();
            break;
          }
          break;

        case 'PlaybackStopped': // run when user stops playback
          // NEW CODE
          // need to write "offset" and "token" to ABS here
          // but actually just writing currentBookTime and maybe just noting the token (filename? fileID?)
          offsetInMilliseconds = handlerInput.requestEnvelope.request.offsetInMilliseconds
            ?? handlerInput.requestEnvelope.context.AudioPlayer?.offsetInMilliseconds
            ?? null
          if (closedPlaySession) // if ABS play session is already closed, don't update again
          {
            console.log("PlaybackStopped: ABS session is closed, so will not update ABS again")
            closedPlaySession = false
          }
          else {
            if (offsetInMilliseconds !== null && userPlaySession && amazonToken !== null && !closedPlaySession) {
              currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)
              console.log("PlaybackStopped: attempt to update ABS")
              updateUserPlaySession(userPlaySession, currentBookTime)

            }
            else {
              console.log("PlaybackStopped: offsetInMilliseconds was null; couldn't update ABS")
            }
          }
          /// END NEW CODE

          if (!userPlaySession || currentBookTime === undefined) {
          }
          else {
            //updateUserPlaySession(userPlaySession, currentBookTime);
            localSessionAttributes.userPlaySession.updatedAt = Date.now();
            localSessionAttributes.userPlaySession.currentTime = currentBookTime;
          }
          break;

        case 'PlaybackNearlyFinished':
          if (!userPlaySession || currentBookTime === undefined) {
            console.log("PlaybackNearlyFinished, but userPlaySession or currentBookTime was undefined");
          }
          else {
            updateUserPlaySession(userPlaySession, currentBookTime);
            localSessionAttributes.userPlaySession.updatedAt = Date.now();
            localSessionAttributes.userPlaySession.currentTime = currentBookTime;

            const currentToken = streamToken;
            const nextTrackIndex = amazonToken + 1;
            const nextAudioTrack = userPlaySession.audioTracks.find((track) => track.index == nextTrackIndex);
            if (nextAudioTrack) {
              localSessionAttributes.nextStreamEnqueued = true;
              let nextUrl = SERVER_URL + nextAudioTrack.contentUrl + "?token=" + ABS_API_KEY;
              const nextToken = createPlaybackToken(userPlaySession, nextTrackIndex);
              const currentChapterID = getCurrentChapterByBookTime(currentBookTime, userPlaySession).id;

              const coverUrl = getCoverUrl(userPlaySession.libraryItemId);
              // The final chapter has no successor; fall back to the book title rather
        // than throwing while enqueuing the next track.
        const nextChapterTitle = (userPlaySession.chapters[currentChapterID + 1] || {}).title
          || userPlaySession.displayTitle;
              const metadata = {
                title: nextChapterTitle,
                subtitle: userPlaySession.displayTitle,
                art: {
                  sources: [{ url: coverUrl, widthPixels: 512, heightPixels: 512 }],
                },
                backgroundImage: {
                  sources: [{ url: resolveBackgroundUrl(coverUrl), widthPixels: 1600, heightPixels: 900 }],
                },
              };
              let response = handlerInput.responseBuilder
                .addAudioPlayerPlayDirective(
                  "ENQUEUE",
                  nextUrl,
                  nextToken,
                  0,
                  currentToken,
                  metadata
                )
                .getResponse();
              break;
            } else {
              localSessionAttributes.nextStreamEnqueued = false;
              break;
            }
          }
          localSessionAttributes.nextStreamEnqueued = false;
          break;

        case 'PlaybackFailed':
          console.error('Playback failed:', JSON.stringify({
            type: handlerInput.requestEnvelope.request.error?.type
          }));
          if (!userPlaySession || currentBookTime === undefined) {
            console.log("PlaybackFailed, but userPlaySession or currentBookTime was undefined, so could not sync or close ABS play session.");
            clearAllMemory()
          }
          else {
            closeUserPlaySession(userPlaySession, currentBookTime);
            clearAllMemory()
          }
          break;

        default:
          break;
      }
      timestamps.AudioPlayerEventHandlerEndTime = new Date();
      console.log("TIMER: AudioPlayer event " + audioPlayerEventName + " handler time: " + (timestamps.AudioPlayerEventHandlerEndTime - audioPlayerEventStartTime) + "ms");
      if (timestamps.PlaybackControllerHandlerStartTime && audioPlayerEventName === "PlaybackStarted") {
        console.log("TIMER: time from button push to PlaybackStartedEnd: " + (timestamps.AudioPlayerEventHandlerEndTime - timestamps.PlaybackControllerHandlerStartTime) + "ms");
        timestamps.PlaybackControllerHandlerStartTime = null
      }

      if (audioPlayerEventName === "PlaybackStarted") {
        // RESET TIMESTAMPS
        resetTimestamps()
      }

      clearAlexaSessionAttributes(handlerInput)
      return handlerInput.responseBuilder.getResponse();

    } catch (error) {
      console.error("Error handling AudioPlayer event:", error);
      timestamps.AudioPlayerEventHandlerEndTime = new Date();
      console.log("TIMER: AudioPlayer event " + audioPlayerEventName + " handler time: " + (timestamps.AudioPlayerEventHandlerEndTime - audioPlayerEventStartTime) + "ms");
      if (timestamps.PlaybackControllerHandlerStartTime && audioPlayerEventName === "PlaybackStarted") {
        console.log("TIMER: time from button push to PlaybackStartedEnd: " + (timestamps.AudioPlayerEventHandlerEndTime - timestamps.PlaybackControllerHandlerStartTime) + "ms");
        timestamps.PlaybackControllerHandlerStartTime = null
      }

      if (audioPlayerEventName === "PlaybackStarted") {
        // RESET TIMESTAMPS
        resetTimestamps()
      }

      clearAlexaSessionAttributes(handlerInput)
      return handlerInput.responseBuilder.getResponse();
    }
  },
};

function applyBookTimeToAttributes(attributes, userPlaySession, bookTime) {
  const result = getTrackAndOffsetFromBookTime(bookTime, userPlaySession)
  if (!result.currentTrack || !Number.isFinite(result.goalOffset)) {
    throw new Error(`Could not map book time ${bookTime} to an audio track`)
  }

  const currentTrack = result.currentTrack
  const amazonToken = currentTrack.index
  const trackArrayIndex = userPlaySession.audioTracks.indexOf(currentTrack)
  const playback = {
    currentTrack: currentTrack,
    currentTrackIndex: amazonToken,
    amazonToken: amazonToken,
    streamToken: createPlaybackToken(userPlaySession, amazonToken),
    offsetInMilliseconds: result.goalOffset,
    playUrl: SERVER_URL + currentTrack.contentUrl + "?token=" + ABS_API_KEY,
    nextStreamEnqueued: Boolean(userPlaySession.audioTracks[trackArrayIndex + 1])
  }

  Object.assign(attributes, playback)
  attributes.userPlaySession = userPlaySession
  attributes.userPlaySession.updatedAt = Date.now()
  attributes.userPlaySession.currentTime = bookTime
  return playback
}

function buildPlaybackMetadata(userPlaySession, bookTime) {
  const chapter = getCurrentChapterByBookTime(bookTime, userPlaySession)
  const coverUrl = getCoverUrl(userPlaySession.libraryItemId)
  return {
    title: chapter ? chapter.title : userPlaySession.displayTitle,
    subtitle: userPlaySession.displayTitle,
    art: {
      sources: [{ url: coverUrl, widthPixels: 512, heightPixels: 512 }]
    },
    backgroundImage: {
      sources: [{ url: resolveBackgroundUrl(coverUrl), widthPixels: 1600, heightPixels: 900 }]
    }
  }
}

function clearAllMemory(handlerInput = null) {
  try {
  const ownerKey = handlerInput ? playbackOwnerKey(handlerInput) : null
  if (handlerInput && localSessionAttributes.playbackOwnerKey
    && localSessionAttributes.playbackOwnerKey !== ownerKey) {
    clearAlexaSessionAttributes(handlerInput)
    return
  }
  // book end, clear all attributes
  console.log("Clearing all memory")
  localSessionAttributes = {}
  if (handlerInput?.requestEnvelope?.session?.attributes) {
    if (hasAlexaSession(handlerInput)) {
      handlerInput.attributesManager.setSessionAttributes(localSessionAttributes);
    }
  }
  closedPlaySession = false
  clearTimers();
  resetTimestamps();
  } catch (error) {
    console.error("Error clearing all memory:", error);
  }
}
/* *
 * PlaybackController events can be triggered when users interact with the audio controls on a device screen.
 * starting the audio, as well as when playback is about to finish playing or playback fails.
 * This handler will save the appropriate details for each event and log the details of the exception,
 * which can help troubleshoot issues with audio playback.
 * */

function updateLocalSessionAttributes(sessionAttributes) {
  // Delete all keys in localSessionAttributes
  for (let key in localSessionAttributes) {
    if (localSessionAttributes.hasOwnProperty(key)) {
      delete localSessionAttributes[key];
    }
  }

  // Assign new keys from sessionAttributes
  for (let key in sessionAttributes) {
    if (sessionAttributes.hasOwnProperty(key)) {
      localSessionAttributes[key] = sessionAttributes[key];
    }
  }
  return localSessionAttributes
}

function retainPlaybackStateLocally(handlerInput, sessionAttributes) {
  sessionAttributes.playbackOwnerKey = playbackOwnerKey(handlerInput)
  updateLocalSessionAttributes(sessionAttributes)
  // Audio playback outlives the conversational session. Returning this large
  // object adds no durability and can exceed Alexa's response-size limit.
  clearAlexaSessionAttributes(handlerInput)
}

// This is for devices with external play controls (such as Echo Show)
// This handler will always be followed by AudioPlayer events (stopped -> started),
// so not necessary to update ABS here
const PlaybackControllerHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type.startsWith('PlaybackController.');
  },
  async handle(handlerInput) {
    const playbackControllerEventName = handlerInput.requestEnvelope.request.type.split('.')[1];
    console.log(`PlaybackControllerHandler event: ${handlerInput.requestEnvelope.request.type}`);
    timestamps.PlaybackControllerHandlerStartTime = Date.now();
    const state = recoverPlaybackState(handlerInput)
    if (!state) {
      console.log('PlaybackControllerHandler: no active play session')
      clearAlexaSessionAttributes(handlerInput)
      return handlerInput.responseBuilder.getResponse()
    }

    const { userPlaySession, offsetInMilliseconds, trackIndex: amazonToken } = state
    const chapters = userPlaySession.chapters

    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)

    let response;
    switch (playbackControllerEventName) {
      case 'PlayCommandIssued': {
        const playback = applyBookTimeToAttributes(localSessionAttributes, userPlaySession, currentBookTime)
        response = handlerInput.responseBuilder
          .addAudioPlayerPlayDirective(
            'REPLACE_ALL',
            playback.playUrl,
            playback.streamToken,
            playback.offsetInMilliseconds,
            null,
            buildPlaybackMetadata(userPlaySession, currentBookTime)
          )
          .getResponse();
        break;
      }
      case 'PauseCommandIssued':
        localSessionAttributes.userPlaySession.updatedAt = Date.now()
        localSessionAttributes.userPlaySession.currentTime = currentBookTime

        response = handlerInput.responseBuilder
          .addAudioPlayerStopDirective()
          .getResponse();
        break;
      case 'PreviousCommandIssued': {
        const currentChapter = getCurrentChapterByBookTime(currentBookTime, userPlaySession)
        const chapterIndex = chapters.indexOf(currentChapter)
        const previousChapter = chapterIndex > 0 ? chapters[chapterIndex - 1] : null
        const targetChapter = currentBookTime > currentChapter.start + 5
          ? currentChapter
          : (previousChapter || chapters[0])
        const newBookTime = targetChapter.start
        const playback = applyBookTimeToAttributes(localSessionAttributes, userPlaySession, newBookTime)
        response = handlerInput.responseBuilder
          .addAudioPlayerPlayDirective(
            'REPLACE_ALL',
            playback.playUrl,
            playback.streamToken,
            playback.offsetInMilliseconds,
            null,
            buildPlaybackMetadata(userPlaySession, newBookTime)
          )
          .getResponse();
        break
      }
      case 'NextCommandIssued': {
        const currentChapter = getCurrentChapterByBookTime(currentBookTime, userPlaySession)
        const chapterIndex = chapters.indexOf(currentChapter)
        const nextChapter = chapters[chapterIndex + 1]
        if (!nextChapter) {
          console.log('NextCommandIssued: already in the final chapter')
          clearAlexaSessionAttributes(handlerInput)
          return handlerInput.responseBuilder.getResponse()
        }
        const newBookTime = nextChapter.start
        const playback = applyBookTimeToAttributes(localSessionAttributes, userPlaySession, newBookTime)
        response = handlerInput.responseBuilder
          .addAudioPlayerPlayDirective(
            'REPLACE_ALL',
            playback.playUrl,
            playback.streamToken,
            playback.offsetInMilliseconds,
            null,
            buildPlaybackMetadata(userPlaySession, newBookTime)
          )
          .getResponse();

        break
      }
      default:
        response = handlerInput.responseBuilder.getResponse()
        break
    }

    timestamps.PlaybackControllerHandlerEndTime = Date.now();
    console.log(`TIMER: Time to handle ${playbackControllerEventName} intent: ${timestamps.PlaybackControllerHandlerEndTime - timestamps.PlaybackControllerHandlerStartTime} ms`);
    clearAlexaSessionAttributes(handlerInput)
    return response;
  },
};
/* *
 * SystemExceptions can be triggered if there is a problem with the audio that is trying to be played.
 * This handler will log the details of the exception and can help troubleshoot issues with audio playback.
 * */
const SystemExceptionHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type === 'System.ExceptionEncountered';
  },
  handle(handlerInput) {
    const request = handlerInput.requestEnvelope.request
    console.error('System exception encountered:', JSON.stringify({
      type: request.error?.type,
      requestId: request.cause?.requestId
    }));
    return handlerInput.responseBuilder.getResponse();
  },
};

/* *
 * FallbackIntent triggers when a customer says something that doesn’t map to any intents in your skill
 * It must also be defined in the language model (if the locale supports it)
 * This handler can be safely added but will be ignored in locales that do not support it yet
 * */
const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(handlerInput) {
    const speakOutput = 'Sorry, I don\'t know about that. Please try again.';

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};
/**
 * A SessionEndedRequest is an object that represents a request made to an Alexa skill to notify that a session was ended. Your service receives a SessionEndedRequest when a currently open session is closed for one of the following reasons:
 *
 * 1. The user says "exit" or "quit".
 * 2. The user does not respond or says something that does not match an intent defined in your voice interface while the device is listening for the user's response.
 * 3. An error occurs.
 *
 * Kind of a last chance to save any data and clean up because Alexa has decided to end everything.
 *
 */
const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    try {
      const request = handlerInput.requestEnvelope.request;
      const playerActivity = handlerInput.requestEnvelope.context?.AudioPlayer?.playerActivity;
      console.log('SessionEndedRequest:', JSON.stringify({
        reason: request.reason,
        errorType: request.error?.type,
        playerActivity
      }));

      // A voice intent that starts audio ends its conversational session while
      // AudioPlayer continues independently. That is normal and must not close
      // the ABS session or erase the warm-container playback cache.
      if (['PLAYING', 'PAUSED', 'BUFFER_UNDERRUN'].includes(playerActivity)) {
        console.log(`SessionEndedRequest: preserving ${playerActivity.toLowerCase()} playback state`);
        return handlerInput.responseBuilder.getResponse();
      }

      let sessionAttributes = getAlexaSessionAttributes(handlerInput)
      const ownsLocalState = !localSessionAttributes.playbackOwnerKey
        || localSessionAttributes.playbackOwnerKey === playbackOwnerKey(handlerInput)
      const ownedLocalAttributes = ownsLocalState ? localSessionAttributes : {}
      const userPlaySession = sessionAttributes.userPlaySession || ownedLocalAttributes.userPlaySession
      const offsetInMilliseconds =
        handlerInput.requestEnvelope.context?.AudioPlayer?.offsetInMilliseconds ?? // Try AudioPlayer first
        handlerInput.requestEnvelope.session?.attributes?.offsetInMilliseconds ?? // Fallback to session attributes
        ownedLocalAttributes.offsetInMilliseconds ?? // Fallback to localsessionAttributes
        null; // Default to null if all else fails

      const amazonToken =
        handlerInput.requestEnvelope.context?.AudioPlayer?.token ?? // Try AudioPlayer first
        handlerInput.requestEnvelope.session?.attributes?.amazonToken ?? // Fallback to session attributes
        ownedLocalAttributes.amazonToken ?? // Fallback to local sessionAttributes
        null; // Default to null if all else fails

      if (amazonToken !== null && offsetInMilliseconds !== null && userPlaySession) {
        const trackIndex = parsePlaybackToken(amazonToken)?.trackIndex
        const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, trackIndex)
        if (closeUserPlaySession(userPlaySession, currentBookTime) == 0) { // if session closed successfully
          closedPlaySession = true
          console.log("SessionEndedRequest: successfully closed ABS session")
        }
      }
      // clear all
      console.log("SessionEndedRequest: clearing all memory")
      clearAllMemory(handlerInput);
      localSessionAttributes = sessionAttributes = {}
      // closedPlaySession = false
      // nextStreamEnqueued = false
      // clearTimers();
      // resetTimestamps();
      // handlerInput.attributesManager.setSessionAttributes(sessionAttributes) // this is probably already handled by Alexa

      // Any cleanup logic goes here.
      return handlerInput.responseBuilder.getResponse() // notice we send an empty response
    }
    catch (error) {
      console.error('Error during SessionEndedRequestHandler:', error);
      throw error;
    }
  }

};
/* *
 * The intent reflector is used for interaction model testing and debugging.
 * It will simply repeat the intent the user said. You can create custom handlers for your intents
 * by defining them above, then also adding them to the request handler chain below
 * */
const IntentReflectorHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
  },
  handle(handlerInput) {
    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
    console.log(`Unhandled intent reached IntentReflectorHandler: ${intentName}`);
    const speakOutput = "Sorry, I can't do that yet.";

    return handlerInput.responseBuilder
      .speak(speakOutput)
      //.reprompt('add a reprompt if you want to keep the session open for the user to respond')
      .getResponse();
  }
};
/**
 * Generic error handling to capture any syntax or routing errors. If you receive an error
 * stating the request handler chain is not found, you have not implemented a handler for
 * the intent being invoked or included it in the skill builder below
 * */
const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    // JSON.stringify(error) is always "{}" for an Error, which is why every failure in this skill used to be opaque. Log the stack.
    console.error('~~~~ Error handled:', (error && (error.stack || error.message)) || error);

    const requestType = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (!['IntentRequest', 'LaunchRequest'].includes(requestType)) {
      // AudioPlayer, PlaybackController, SessionEnded, and System requests are
      // out of session. Speech, reprompts, and session attributes are invalid.
      return handlerInput.responseBuilder.getResponse();
    }

    const speakOutput = 'Sorry, I had trouble doing what you asked. Please try again.';
    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

/* HELPER FUNCTIONS */

/**
 * This handler acts as the entry point for your skill, routing all request and response
 * payloads to the handlers above. Make sure any new handlers or interceptors you've
 * defined are included below. The order matters - they're processed top to bottom
 * */
exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    PlayAudioIntentHandler,
    PlayBookIntentHandler,
    PauseAudioIntentHandler,
    PreviousIntentHandler,
    NextIntentHandler,
    GoForwardXTimeIntentHandler,
    GoBackXTimeIntentHandler,
    UnsupportedAudioIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    AudioPlayerEventHandler,
    PlaybackControllerHandler,
    SystemExceptionHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler,
    IntentReflectorHandler)
  .addErrorHandlers(
    ErrorHandler)
  .withCustomUserAgent('AlexaSkill')
  .lambda();
