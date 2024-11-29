
const Alexa = require('ask-sdk-core');
//const AWS = require('aws-sdk');
const request = require('sync-request');
const fs = require('fs');
//const { SsmlUtils } = require('ask-sdk-core');
// const xml2js = require('xml2js');

let closedPlaySession = false

let localSessionAttributes = {
  userPlaySessionID: null,
  userPlaySession: null,
  offsetInMilliseconds: null,
  amazonToken: null,
  playUrl: null,
  currentBookTime: 0,
  nextStreamEnqueued: true
}

//const ddbAdapter = require('ask-sdk-dynamodb-persistence-adapter');
// const Util = require('./util.js');

const { ABS_API_KEY, SERVER_URL, CFAccessClientId, CFAccessClientSecret } = require('./config.js');
// const { off, title } = require('process');

const baseheaders = {
  "Content-Type": 'application/json',
  "Authorization": 'Bearer ' + ABS_API_KEY,
  "CF-Access-Client-Id": CFAccessClientId,
  "cf-access-client-id": CFAccessClientId,
  "CF-Access-Client-Secret": CFAccessClientSecret,
  "User-Agent": "HarrisonAlexaSkill"
}

// GLOBAL VARIABLES
//let playSession = null;
let timers = {
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

let backgroundUrl = "https://images.steelcase.com/image/upload/c_fill,q_auto,f_auto,h_900,w_1600/v1567243086/6130_1000.jpg"

// AUDIOBOOKSHELF API CALL FUNCTIONS
function getLastPlayedLibraryItem() {
  try {
    let res = request('GET', `${SERVER_URL}/api/me/items-in-progress`, { headers: baseheaders });
    let data = JSON.parse(res.getBody('utf8'));

    let mostRecentProgressUpdatedItem = data.libraryItems[0] // this should be the most recent (ABS automatically sorts)
    return mostRecentProgressUpdatedItem;
  } catch (error) {
    console.error('Error during getLastPlayedLibraryItem:', error);
    throw error;
  }

}

/**
* Function to call the GET /api/items/:id endpoint
* @param {string} id - The ID of the item to retrieve
* @param {object} [options] - Optional query parameters
* @param {string[]} [options.include] - Entities to include (e.g., ['progress', 'rssfeed', 'downloads', 'share'])
* @param {number} [options.expanded] - Whether to expand the response (1 for true, undefined or 0 for false)
* @param {string} [options.episode] - Episode ID if including user media progress
* @returns {object} - The response body parsed as JSON
*/
function getItemById(id, options = {}) {
  const baseUrl = SERVER_URL + '/api/items/'; // Replace with your actual base URL
  let url = `${baseUrl}${id}`;

  const queryParams = [];
  if (options.include) {
    queryParams.push(`include=${options.include.join(',')}`);
  }
  if (options.expanded) {
    queryParams.push(`expanded=${options.expanded}`);
  }
  if (options.episode) {
    queryParams.push(`episode=${options.episode}`);
  }

  if (queryParams.length > 0) {
    url += `?${queryParams.join('&')}`;
  }

  const response = request('GET', url, {
    headers: {
      'Content-Type': 'application/json',
      ...baseheaders
    }
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to fetch item: ${response.statusCode} ${response.body.toString()}`);
  }

  return JSON.parse(response.body.toString());
}

function startUserPlaySession(libraryID, handlerInput) {
  try {
    let deviceInfo = {
      deviceId: handlerInput.requestEnvelope.context.System.device.deviceId,
      clientName: "Alexa Device",
      clientVersion: "1.0",
      manufacturer: "Amazon",
      model: "Echo",
      sdkVersion: 1
    }
    let bodyParameters = {
      deviceInfo: deviceInfo,
      forceDirectPlay: false,
      forceTranscode: false,
      supportedMimeTypes: [
        "audio/flac",
        "audio/mpeg",
        "audio/mp4",
        "audio/aac",
        "audio/x-aiff"
      ],
      mediaPlayer: "unknown"
    }



    let res = request('POST', SERVER_URL + `/api/items/${libraryID}/play`, { headers: baseheaders, json: bodyParameters });
    console.log(res)
    let data = JSON.parse(res.getBody('utf8'));

    return data;
  } catch (error) {
    console.error('Error retrieving play session:', error);
    throw error;
  }
}

function getExistingUserPlaySession(sessionID) {
  try {
    let res = request('GET', SERVER_URL + `/api/session/${sessionID}`, { headers: baseheaders });
    console.log(res)
    let data = JSON.parse(res.getBody('utf8'));

    return data;
  } catch (error) {
    console.error('Error retrieving play session:', error);
    throw error;
  }
}

function calculateCurrentTime(playSession, currentTrackOffset, currentToken) {
  let currentIndex = currentToken;
  let currentTrack = playSession.audioTracks.filter(track => track.index == currentIndex)[0];

  if (!currentTrack) {
    return 0.0; // Return a default value if no track is found
  }

  let currentTime = currentTrack.startOffset + currentTrackOffset / 1000;

  // Ensure the result is a non-null float
  return (typeof currentTime === 'number' && !isNaN(currentTime)) ? parseFloat(currentTime) : 0.0;
}

function updateUserPlaySession(playSession, currentBookTime) {
  try {
    // currentTime = calculateCurrentTime(playSession, currentTrackOffsetMS, currentToken)

    if (!playSession) {
      console.log("updateUserPlaySession: Empty userPlaySession")
      return 1
    }

    const playSessionID = playSession.id
    if (!playSessionID) {
      console.log("updateUserPlaySession: Invalid userPlaySessionID")
      return 1
    }
    // Ensure currentBookTime is a float and not null
    if (currentBookTime == null || isNaN(currentBookTime)) {
      console.log("updateUserPlaySession: Invalid currentBookTime");
      return 2;
    }

    currentBookTime = parseFloat(currentBookTime);
    const timeListened = (Date.now() - playSession.updatedAt) / 1000

    const body = JSON.stringify({
      currentTime: currentBookTime,
      // duration:
      timeListened: timeListened
      // !!! if I want ABS to save session, have to return timeListened
      // timeListened = number of seconds since last update
      // duration = length of currently playing item....
    });

    // update user play session
    let res = request('POST', SERVER_URL + `/api/session/${playSessionID}/sync`, { headers: baseheaders, body: body });
    console.log("updateUserPlaySession: ")
    console.log(res)
    if (res.statusCode == 200) {
      console.log("updateUserPlaySession - Successfully synced play session with ABS");
    }
    if (res.statusCode == 404) {
      console.log("updateUserPlaySession - ABS: No listening session with the provided ID is open, or the session belongs to another user.");
      throw new Error(`Failed to sync play session: ${res.statusCode} ${res.body.toString()}`);
    }
    if (res.statusCode == 500) {
      console.log("updateUserPlaySession - ABS: Internal Server Error:There was an error syncing the session.");
      throw new Error(`updateUserPlaySession - Failed to sync play session: ${res.statusCode} ${res.body.toString()}`);
    }
    return // docs say this returns playSession, but not in my experience

    //let playSession = JSON.parse(res.getBody('utf8')); this doesn't seem to return the session...
    // let playbackURL = data.audioTracks[0].contentUrl

    //return playSession;

  } catch (error) {
    console.error('updateUserPlaySession - Error updating play session:', error);
    return
  }
}

function closeUserPlaySession(userPlaySession, currentBookTime) {
  try {
    //const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
    //currentTime = calculateCurrentTime(playSession, currentTrackOffsetMS, currentToken)

    if (!userPlaySession) {
      console.log("closeUserPlaySession: Empty userPlaySession")
      return 1
    }
    const userPlaySessionID = userPlaySession.id


    if (!userPlaySessionID) {
      console.log("closeUserPlaySession: Invalid userPlaySessionID")
      return 1
    }

    // Ensure currentBookTime is a float and not null
    if (currentBookTime == null || isNaN(currentBookTime)) {
      console.log("closeUserPlaySession: Invalid currentBookTime");
      return 2;
    }

    currentBookTime = parseFloat(currentBookTime);

    const timeListened = (Date.now() - userPlaySession.updatedAt) / 1000

    const body = JSON.stringify({
      currentTime: currentBookTime,
      // duration:
      timeListened: timeListened
      // !!! if I want ABS to save session, have to return timeListened
      // timeListened = time (in seconds) since last update
    });



    const apiUrl = SERVER_URL + `/api/session/${userPlaySessionID}/close`

    let res = request('POST', apiUrl, { headers: baseheaders, body: body });
    console.log("closeUserPlaySession: ")

    if (res.statusCode == 200) {
      console.log("closeUserPlaySession - Successfully synced and closed play session with ABS");
      return 0;
    }
    if (res.statusCode == 404) {
      console.log("closeUserPlaySession - ABS: No listening session with the provided ID is open, or the session belongs to another user.");
      throw new Error(`closeUserPlaySession - Failed to close play session: ${res.statusCode} ${res.body.toString()}`);
    }
    if (res.statusCode !== 200) {
      throw new Error(`closeUserPlaySession - Failed to close play session: ${res.statusCode} ${res.body.toString()}`);
    }
  } catch (error) {
    console.error('closeUserPlaySession - Error closing play session:', error);
    return
  }
}

function getCurrentTrack(currentTime, audioTracks) {
  return audioTracks.find(track => track.startOffset <= currentTime && (track.startOffset + track.duration) > currentTime);
}


function getCurrentTrackIndex(currentTime, audioTracks) {
  return audioTracks.findIndex(track => track.startOffset <= currentTime && (track.startOffset + track.duration) > currentTime) + 1;
}

function getCoverUrl(libraryItemId) {
  // as of 11/28/24, retrieving cover does not require authentication
  return SERVER_URL + `/api/items/${libraryItemId}/cover`
}

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

function getCurrentChapter(currentBookTime, playSession) {
  const chapters = playSession.chapters
  for (let i = 0; i < chapters.length; i++) {
    if (currentBookTime >= chapters[i].start && currentBookTime <= chapters[i].end) {
      return chapters[i];
    }
  }
  return null; // Return null if no chapter is found
}


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
      let timeStart = new Date();
      let userPlaySession
      let lastPlayedLibraryItem
      let expandedItem
      let lastPlayedID

      let mediaProgress
      let currentTime

      const playBehavior = 'REPLACE_ALL';

      const sessionAttributes = handlerInput.attributesManager.getSessionAttributes(); // cannot set sessionAttriubtes and localAttributes equal
      // *** if user is just pausing and resuming, don't need to 
      // start a new session everytime.
      // so check for existing and use that.

      const existingSession = sessionAttributes.userPlaySession || localSessionAttributes.userPlaySession
      let existingAttributes = (sessionAttributes && Object.keys(sessionAttributes).length > 0)
        ? sessionAttributes
        : (localSessionAttributes && Object.keys(localSessionAttributes).length > 0)
          ? localSessionAttributes
          : null;
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
      playSession = userPlaySession
      if (!existingSession) {
        mediaProgress = expandedItem.userMediaProgress
        currentTime = mediaProgress.currentTime
      }
      else {
        currentTime = existingSession.currentTime

      }
      sessionAttributes.userPlaySession = userPlaySession


      sessionAttributes.userPlaySessionID = userPlaySession.id // can call API to pull the whole playSession again if needed

      let currentTrack = sessionAttributes.currentTrack = getCurrentTrack(currentTime, userPlaySession.audioTracks)
      let currentTrackIndex = sessionAttributes.amazonToken = getCurrentTrackIndex(currentTime, userPlaySession.audioTracks) // should start at 1

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


      const chapterTitle = getCurrentChapter(currentTime, userPlaySession).title
      const author = userPlaySession.displayAuthor
      const bookTitle = userPlaySession.displayTitle
      const playUrl = sessionAttributes.playUrl = SERVER_URL + userPlaySession.audioTracks[currentTrackIndex - 1].contentUrl + "?token=" + ABS_API_KEY
      // const playUrl = SERVER_URL + userPlaySession.audioTracks[0].contentUrl + "?token=" + ABS_API_KEY
      handlerInput.attributesManager.setSessionAttributes(sessionAttributes)
      updateLocalSessionAttributes(sessionAttributes)

      let timeEnd = new Date();
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
              url: backgroundUrl,
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
      console.log("Playing: " + playUrl)

      return handlerInput.responseBuilder
        .speak(sanitizeForSSML(speakOutput))
        .addAudioPlayerPlayDirective(
          playBehavior,
          playUrl,
          currentTrackIndex, // for amazon's token system 
          offsetInMilliseconds, // offset in ms
          null,          // expected previous token (don't include if playBehavior is REPLACE)
          metadata
        )
        .getResponse();
    }
    catch (error) {
      console.log(error)
    }
  }

};

function getLibraryFilterData(libraryID) {
  try {
    let res = request('GET', `${SERVER_URL}/api/libraries/${libraryID}/filterdata`, { headers: baseheaders });
    let data = JSON.parse(res.getBody('utf8'));
    return data;
  } catch (error) {
    console.error('Error during getLibraryFilterData:', error);
    throw error;
  }
}

function getAllLibraries() {
  try {
    let res = request('GET', `${SERVER_URL}/api/libraries`, { headers: baseheaders });
    let data = JSON.parse(res.getBody('utf8'));
    return data.libraries;
  } catch (error) {
    console.error('Error during getAllLibraries:', error);
    throw error;
  }
}
function getAllAudiobooks() {
  const allLibraries = getAllLibraries()
  const bookLibraries = allLibraries.filter(library => library.mediaType === 'book');
  const audiobooksOnlyLibraries = bookLibraries.filter(library => library.settings.audiobooksOnly);
  const bookLibraryIDs = audiobooksOnlyLibraries.map(library => library.id);
  const allLibraryItems = [];


  // Loop through each library and get the items
  for (let i = 0; i < bookLibraryIDs.length; i++) {
    const libraryID = bookLibraryIDs[i];
    const options =
    {
      libraryID: libraryID,
      sort: 'media.metadata.title',
      minified: 1
      // limit = 500
    }
    const items = getLibraryItems(options);
    Array.prototype.push.apply(allLibraryItems, items.results);
  }

  return allLibraryItems;
}


function getLibraryItems(options = {}) {

  const {
    libraryID,
    limit = 0,
    page = 0,
    sort = '',
    desc = 0,
    filter = '',
    minified = 0,
    collapseseries = 0,
    include = ''
  } = options;

  const baseUrl = `${SERVER_URL}/api/libraries/${libraryID}/items`;

  const queryParams = [];

  if (limit !== undefined && limit !== null) {
    queryParams.push(`limit=${limit}`);
  }
  if (page !== undefined && page !== null) {
    queryParams.push(`page=${page}`);
  }
  if (sort) {
    queryParams.push(`sort=${sort}`);
  }
  if (desc !== undefined && desc !== null) {
    queryParams.push(`desc=${desc}`);
  }
  if (filter) {
    queryParams.push(`filter=${filter}`);
  }
  if (minified !== undefined && minified !== null) {
    queryParams.push(`minified=${minified}`);
  }
  if (collapseseries !== undefined && collapseseries !== null) {
    queryParams.push(`collapseseries=${collapseseries}`);
  }
  if (include) {
    queryParams.push(`include=${include}`);
  }

  // Construct the final URL with query parameters
  const url = `${baseUrl}?${queryParams.join('&')}`;

  try {

    const response = request('GET', url, { headers: baseheaders });

    if (response.statusCode === 200) {
      return JSON.parse(response.getBody('utf8'));
    } else {
      console.error(`Error: Received status code ${response.statusCode}`);
      return null;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return null;
  }
}

function getAuthor(authorID) {
  try {
    let res = request('GET', `${SERVER_URL}/api/authors/${authorID}?include=items`, { headers: baseheaders });
    let data = JSON.parse(res.getBody('utf8'));
    return data;
  } catch (error) {
    console.error('Error during getAuthor:', error);
    throw error;
  }
}

function searchFor(query, libraryID) {
  try {
    let res = request('GET', `${SERVER_URL}/api/libraries/${libraryID}/search?q=${query}`, { headers: baseheaders });
    let data = JSON.parse(res.getBody('utf8'));
    return data;
  } catch (error) {
    console.error('Error during searchFor:', error);
    throw error;
  }
}

const Fuse = require('fuse.js');
// const { match } = require('assert');

const PlaybackBookHandler = { // this handler is not currently used (has limitations)
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PlaybackAction<object@Book>');
  },
  async handle(handlerInput) {
    // this function is mainly limited by the poor intent slots that are returned. May only be 
    // actually useful if I were to upload the catalogue for Alexa to analyze.....
    // it doesn't do any entity resolution, which is stupid
    // created a custom handler that does entity resolution through amazon
    console.log("Intent: PlaybackBookHandler Triggered")
    const bookTitle = handlerInput.requestEnvelope.request.intent.slots["object.name"].value
    const author = handlerInput.requestEnvelope.request.intent.slots["object.author.name"].value


    let libraryItem
    console.log("Title: " + bookTitle)
    console.log("Author: " + author)
    if (!bookTitle) {
      let speakOutput = 'I did not understand the request. For example, try saying "Play audiobook title by author".';
      console.log("Book and/or author slot undefined")
      return handlerInput.responseBuilder
        .speak(speakOutput)
        .reprompt(speakOutput)
        .getResponse();
    }
    else if (bookTitle && author) { // if I'm given both author and book
      const allLibraries = getAllLibraries()
      const bookLibraries = allLibraries.filter(library => library.mediaType === 'book');
      const audiobooksOnlyLibraries = bookLibraries.filter(library => library.settings.audiobooksOnly);
      const bookLibraryIDs = audiobooksOnlyLibraries.map(library => library.id);

      const filterdata = getLibraryFilterData(bookLibraryIDs[0])
      let authorEntry

      // fuzzy match author
      const optionsAuthor = {
        keys: ['name'],
        threshold: 0.3 // Adjust the threshold according to your needs
      };

      const fuseAuthor = new Fuse(filterdata.authors, optionsAuthor);
      authorEntry = fuseAuthor.search(author)[0].item;
      const authorResult = getAuthor(authorEntry.id)
      const libraryItems = authorResult.libraryItems

      // fuzzy match title
      const optionsTitle = {
        keys: ['media.metadata.title'],  // Specify the keys to search within the nested structure
        includeScore: true,              // Include score in the results
        threshold: 0.3,                  // Adjust the threshold to control the fuzzy matching sensitivity
      };

      // Create a Fuse instance
      const fuseTitle = new Fuse(libraryItems, optionsTitle);

      // Perform the search
      libraryItem = fuseTitle.search(bookTitle)[0].item;

      // Log the results
      console.log("Found a book in the library!")
      console.log("Title: " + libraryItem.media.metadata.title);
      console.log("Author: " + libraryItem.media.metadata.authorName);
    }
    else if (bookTitle && !author) { // if only given book title
      const allLibraries = getAllLibraries()
      const bookLibraries = allLibraries.filter(library => library.mediaType === 'book');
      const audiobooksOnlyLibraries = bookLibraries.filter(library => library.settings.audiobooksOnly);
      const bookLibraryIDs = audiobooksOnlyLibraries.map(library => library.id);
      let results = []
      bookLibraryIDs.forEach(function (libraryID, i) {
        results[i] = searchFor(bookTitle, libraryID)
      });
      if (results[0].book.length == 0) {
        console.log("No book of title '" + bookTitle + "' found")
        const speakOutput = "No book of title '" + bookTitle + "' found. Please try again.";
        return handlerInput.responseBuilder
          .speak(sanitizeForSSML(speakOutput))
          .reprompt(sanitizeForSSML(speakOutput))
          .getResponse();
      }

      const firstMatchingBook = absSearchResults[0].book[0] //just take the first item
      // const firstMatchingBook = bookResults.find(book => book.matchKey === "title"); DEFUNCT NOW that matchKey was removed
      console.log("Matched a book using ABS search API!")
      //absSearchResults[0].book[0].libraryItem.media.metadata.title

      libraryItem = firstMatchingBook.libraryItem

      console.log("Found a book in the library!")
      console.log("Title: " + libraryItem.media.metadata.title);
      console.log("Author: " + libraryItem.media.metadata.authorName);
    }

    let userPlaySession

    const playBehavior = 'REPLACE_ALL';

    const libraryItemID = libraryItem.id


    let expandedItem = getItemById(lastPlayedID, { include: ['progress'], expanded: 1 });

    userPlaySession = startUserPlaySession(libraryItemID, handlerInput)
    delete userPlaySession.libraryItem // this property very large and nothing useful
    playSession = userPlaySession

    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes(); // cannot set sessionAttriubtes and localAttributes equal
    localSessionAttributes = JSON.parse(JSON.stringify(sessionAttributes)); // clone sessionAttriubtes (avoid pointer issue)

    let mediaProgress = expandedItem.userMediaProgress


    sessionAttributes.userPlaySessionID = userPlaySession.id // can call API to pull the whole playSession again if needed

    let currentTime = mediaProgress.currentTime
    let currentTrack = sessionAttributes.currentTrack = getCurrentTrack(currentTime, playSession.audioTracks)
    let currentTrackIndex = sessionAttributes.amazonToken = getCurrentTrackIndex(currentTime, playSession.audioTracks) // should start at 1
    sessionAttributes.currentTrackIndex = currentTrackIndex;
    let trackStartOffset = currentTrack.startOffset
    const offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = (currentTime - trackStartOffset) * 1000

    if (playSession.audioTracks[currentTrackIndex]) {
      localSessionAttributes.nextStreamEnqueued = true
    }
    else {
      localSessionAttributes.nextStreamEnqueued = false
    }

    const playUrl = sessionAttributes.playUrl = SERVER_URL + userPlaySession.audioTracks[currentTrackIndex - 1].contentUrl + "?token=" + ABS_API_KEY

    // const playUrl = SERVER_URL + userPlaySession.audioTracks[0].contentUrl + "?token=" + ABS_API_KEY 

    const coverUrl = getCoverUrl(userPlaySession.libraryItemId)

    handlerInput.attributesManager.setSessionAttributes(sessionAttributes)
    // sync localSessionAttributes to sessionAttributes
    updateLocalSessionAttributes(sessionAttributes)

    let speakOutput = 'Playing ' + playSession.displayTitle + ' by ' + playSession.displayAuthor;
    console.log("Playing: " + playUrl)

    const chapterTitle = getCurrentChapter(currentTime, playSession).title
    const metadata = {
      title: chapterTitle,
      subtitle: playSession.displayTitle,
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
            url: backgroundUrl,
            widthPixels: 1600,
            heightPixels: 900
          }
        ]
      }
    };

    return handlerInput.responseBuilder
      .speak(sanitizeForSSML(speakOutput))
      .addAudioPlayerPlayDirective(
        playBehavior,
        playUrl,
        currentTrackIndex, // for amazon's token system 
        offsetInMilliseconds, // offset in ms
        null,          // expected previous token (don't include if playBehavior is REPLACE)
        metadata
      )
      .getResponse();
  }
};

function getEntityData(entityUrl, accessToken, locale) {
  try {
    const res = request('GET', entityUrl, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Accept-Language': locale,
        'Accept': 'application/ld+json'
      }
    });

    if (res.statusCode === 200) {
      const entityData = JSON.parse(res.getBody('utf8'));
      return entityData;
    } else {
      console.error(`Amazon entity check failed with status code: ${res.statusCode}`);
      return null;
    }
  } catch (error) {
    console.error(`Request failed: ${error.message}`);
    return null;
  }
}

function fuzzyMatch(
  { searchData, // what array am I searching through?
    searchKey, // what string am I looking for?
    key, // e.g. 'media.title' or a getFn
    threshold = 0.6, // fuzziness
    arrayOrBest = 'best', // return array of all scores, or just the single best score
    scoreThreshold = 1 // scoreThreshold (if score worse than this, then return null. Default return all.)
  }) {
  const options = {
    keys: [key],
    includeScore: true,
    threshold: threshold
  };
  const fuse = new Fuse(searchData, options);
  const results = fuse.search(searchKey);
  const bestResult = results[0];

  if (bestResult && bestResult.score < scoreThreshold) { // only return a score better than scoreThreshold (lower is better)
    if (arrayOrBest === "best") {
      return bestResult ? bestResult.item : null;
    } else {
      return results || null;
    }
  }
  return null;
}

// Function to perform fuzzy string matching, for simple strings 1 to 1
function fuzzyStringMatch(string1, string2, includeScore = true, threshold = 0.6) {
  const scoreThreshold = 0.6
  const options = {
    includeScore: includeScore,
    threshold: threshold,
  };
  if (!string1 || !string2) {
    return null;
  }
  const fuse = new Fuse([string1], options);
  const result = fuse.search(string2)[0];
  if (!result) {
    return null
  }
  if (result.score < scoreThreshold) // only return a score better than 0.6 (lower is better)
  {
    return result ? { item: result.item, score: result.score } : null;
  }
  return null
}

/**
 * function to search all ABS audiobook libraries for bookTitle
 * @param {*} bookTitle 
 * @returns 
 */
function searchBookWithAbsAPI(bookTitle) {
  const allLibraries = getAllLibraries();

  // Filter libraries to only include those with mediaType 'book'
  const bookLibraries = allLibraries.filter(library => library.mediaType === 'book');

  // Further filter libraries to include only those with audiobooksOnly settings
  const audiobooksOnlyLibraries = bookLibraries.filter(library => library.settings.audiobooksOnly);

  const bookLibraryIDs = audiobooksOnlyLibraries.map(library => library.id);

  let results = [];
  // Iterate over each library ID and perform the search
  // maybe I could do this asynchronously?
  bookLibraryIDs.forEach(function (libraryID, i) {
    // Perform a search for the given book title in the current library
    results[i] = searchFor(bookTitle, libraryID);
  });

  return results;
}

function amazonCrossmatch(titleResolutions, authorResolutions, accessToken) {
  let checkedTitles = [] // avoid redundant checks
  let validAuthors = []// authors that have matching titles
  let validTitles = []// titles that have matching authors

  let callFailed = false
  for (let j = 0; j < titleResolutions.values.length; j++) {
    let resolutionTitle = titleResolutions.values[j].value.name;
    if (checkedTitles.includes(resolutionTitle)) {
      continue; // Skip to the next resolutionTitle if it's already checked
    }

    const apiUrl = titleResolutions.values[j].value.id
    const titleData = getEntityData(apiUrl, accessToken, "en-US") || null;
    if (!titleData) {
      callFailed = true
    }

    let authors = null
    if (titleData) {
      authors = titleData["entertainment:author"] || null;
    }

    if (authors) {
      for (let i = 0; i < authorResolutions.values.length; i++) {
        const value = authorResolutions.values[i].value;
        const authorName = value.name;

        for (let x = 0; x < authors.length; x++) {
          if (authors[x].name[0]["@value"] === authorName) {
            validTitles.push(resolutionTitle);
            validAuthors.push(authorName);
            //break; // Assuming a title can only have one author in validAuthors
          }
          else { // if no exact match, try fuzzy match
            const matchResult = fuzzyStringMatch(authors[x].name[0]["@value"], authorName)
            if (matchResult) {
              validTitles.push(resolutionTitle);
              validAuthors.push(authorName);
              //break; // Assuming a title can only have one author in validAuthors
            }
          }
        }
      }
    }
    if (!callFailed) {
      checkedTitles.push(resolutionTitle)
    }
    callFailed = false
  }
  return { validAuthors: validAuthors, validTitles: validTitles }
}

function searchByTitleOnly(
  { bookTitle,
    APIsearch = true, //perform API search?
    fuzzySearch = true // perform fuzzy?
  }) {
  const start = new Date()
  if (APIsearch) {
    console.log("Performing ABS API search for '" + bookTitle + "'")
    const absSearchResults = searchBookWithAbsAPI(bookTitle)
    if (absSearchResults[0].book.length > 0) {
      const firstMatchingBook = absSearchResults[0].book[0] //just take the first item
      // const firstMatchingBook = bookResults.find(book => book.matchKey === "title"); DEFUNCT NOW that matchKey was removed
      console.log("Matched a book using ABS search API!")
      //absSearchResults[0].book[0].libraryItem.media.metadata.title
      return firstMatchingBook.libraryItem
    }
    else {
      console.log("No book of title '" + bookTitle + "' found via ABS API search")
    }
    console.log(`TIMER: Time to perform ABS API search of all audiobooks: ${new Date() - start} ms`);
    timers.ABSapi = new Date() - start
  }
  if (fuzzySearch) {
    const startFuzzy = new Date()
    console.log("Fuzzy matching all ABS audiobooks for '" + bookTitle + "'")
    const allAudiobooks = getAllAudiobooks() // get all audiobooks from all audiobook libraries
    timers.context.absDatabaseSize = allAudiobooks.length
    const options = {
      searchData: allAudiobooks,
      searchKey: bookTitle,
      key: 'media.metadata.title',
      threshold: 0.6, // fuzziness
      arrayOrBest: 'array',
      scoreThreshold: 0.6  // score cut off
    }
    const matchResults = fuzzyMatch(options)
    const matchResult = matchResults?.[0] || null //the best score
    console.log(`TIMER: Time to perform fuzzy search of all audiobooks: ${new Date() - startFuzzy} ms`);
    timers.fuzzySearch = new Date() - startFuzzy
    if (matchResult) {
      console.log("Matched a book in ABS library using fuzzy matching!")
      return matchResult.item
    }
  }
  return null; // return null if all search methods fail
}

const PlayBookIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'PlayBookIntent');
  },
  async handle(handlerInput) {
    // using a custom handler allows me to use Amazon book and author matching,
    // but prevents the sessions from being remembered (so user will have to reinvoke the skill after this)


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
    timers.context.timestamp = new Date() // milliseconds since 1970

    // require a book title (could later implement playing by author I suppose, maybe in another intent)
    if (!bookTitle) {
      let speakOutput = 'I did not understand the request. For example, try saying "Play audiobook title by author".';
      console.log("Book and/or author slot undefined")
      return handlerInput.responseBuilder
        .speak(speakOutput)
        .reprompt(speakOutput)
        .getResponse();

    }

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
        amazonCrossmatchFailed = true // amazon's proposed titles and authors did not match
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

    for (i = 0; i < 2 && !libraryItem; i++) // up to two loops, and only if libraryItem not found
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
    playSession = userPlaySession

    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes(); // cannot set sessionAttriubtes and localAttributes equal
    localSessionAttributes = JSON.parse(JSON.stringify(sessionAttributes)); // clone sessionAttriubtes (avoid pointer issue)

    let mediaProgress = expandedItem.userMediaProgress

    sessionAttributes.userPlaySession = userPlaySession
    sessionAttributes.userPlaySessionID = userPlaySession.id // can call API to pull the whole playSession again if needed


    let currentTime = mediaProgress?.currentTime ?? 0;
    let currentTrack = sessionAttributes.currentTrack = getCurrentTrack(currentTime, playSession.audioTracks)
    let currentTrackIndex = sessionAttributes.amazonToken = getCurrentTrackIndex(currentTime, playSession.audioTracks) // should start at 1
    sessionAttributes.currentTrackIndex = currentTrackIndex;
    let trackStartOffset = currentTrack.startOffset
    const offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = (currentTime - trackStartOffset) * 1000

    if (playSession.audioTracks[currentTrackIndex]) {
      localSessionAttributes.nextStreamEnqueued = true
    }
    else {
      localSessionAttributes.nextStreamEnqueued = false
    }

    const playUrl = sessionAttributes.playUrl = SERVER_URL + userPlaySession.audioTracks[currentTrackIndex - 1].contentUrl + "?token=" + ABS_API_KEY

    const coverUrl = getCoverUrl(userPlaySession.libraryItemId)
    handlerInput.attributesManager.setSessionAttributes(sessionAttributes)
    // sync localSessionAttributes to sessionAttributes
    updateLocalSessionAttributes(sessionAttributes)

    let speakOutput = 'Playing ' + playSession.displayTitle + ' by ' + playSession.displayAuthor;
    console.log("Playing: " + playUrl)


    let chapterTitle = getCurrentChapter(currentTime, playSession).title

    // chapterTitle = chapterTitle // remove any invalid characters

    const subtitle = playSession.displayTitle

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
            url: backgroundUrl,
            widthPixels: 1600,
            heightPixels: 900
          }
        ]
      }
    };


    const timeBeforeResponse = new Date();
    const timeUntilResponse = timeBeforeResponse - ABSsearchEnd
    const totalIntentTime = timeBeforeResponse - amazonStuffStart
    console.log("TIMER: Time after ABS search until skill response: " + timeUntilResponse + " ms")
    console.log("TIMER: Total intent time (PlayBookIntent): " + totalIntentTime + " ms")
    timers.totalIntentTime = totalIntentTime
    timers.preparePlay = timeUntilResponse
    // log timers to file
    const timersString = JSON.stringify(timers, null, 2);
    fs.appendFile('timers.json', timersString + '\n', (err) => {
      if (err) {
        console.error('Failed to append timers object:', err);
      } else {
        console.log('Timers object appended successfully.');
      }
    });
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
        currentTrackIndex, // for amazon's token system 
        offsetInMilliseconds, // offset in ms
        null,          // expected previous token (don't include if playBehavior is REPLACE)
        metadata
      )
      .getResponse();
  }
};

function clearTimers() {
  timers = {
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
}

const PauseAudioIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PauseIntent';
  },
  async handle(handlerInput) {
    try {
      let sessionAttributes = handlerInput.attributesManager.getSessionAttributes()
      if (Object.keys(sessionAttributes).length === 0) {
        sessionAttributes = localSessionAttributes
        // !! what to do if both sets of attributes are undefined?? does that mean
        // i've lost all playback info and have to recall the whole skill?
        // maybe this is why i need persistent attributes....
      }

      if (handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds != undefined && sessionAttributes.offsetInMilliseconds != undefined) {

        const userPlaySession = sessionAttributes.userPlaySession

        const offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
        const amazonToken = sessionAttributes.amazonToken = handlerInput.requestEnvelope.context.AudioPlayer.token

        const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)

        updateUserPlaySession(userPlaySession, currentBookTime)
        // manually set the new currentBookTime and updatedAt to local attributes
        sessionAttributes.userPlaySession.updatedAt = localSessionAttributes.userPlaySession.updatedAt = Date.now()
        sessionAttributes.userPlaySession.currentTime = localSessionAttributes.userPlaySession.currentTime = currentBookTime

        handlerInput.attributesManager.setSessionAttributes(sessionAttributes)
        updateLocalSessionAttributes(sessionAttributes)
      }
      return handlerInput.responseBuilder
        .addAudioPlayerStopDirective()
        .getResponse();
    }
    catch (error) {
      console.log("Error during PauseAudioIntentHandler: " + error)
    }

  }
};

function getTrackAndOffsetFromBookTime(bookTime, audioTracks) {
  const currentTrack = getCurrentTrack(bookTime, audioTracks)
  const goalOffset = (bookTime - currentTrack.startOffset) * 1000
  return {
    currentTrack: currentTrack,
    goalOffset: goalOffset
  }
}

/**
 * Seeks to beginning of either this chapter or of the previous chapter
 */
const PreviousIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PreviousIntent';
  },
  async handle(handlerInput) {
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes()
    sessionAttributes.offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
    sessionAttributes.amazonToken = localSessionAttributes.amazonToken = handlerInput.requestEnvelope.context.AudioPlayer.token
    localSessionAttributes = JSON.parse(JSON.stringify(sessionAttributes)); // clone sessionAttriubtes (avoid pointer issue)
    let offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
    let amazonToken = localSessionAttributes.amazonToken = handlerInput.requestEnvelope.context.AudioPlayer.token
    const userPlaySession = sessionAttributes.userPlaySession

    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)

    // default behavior: go to beginning of chapter. If within 2 seconds of beginning, go to previous chapter
    let currentChapter = getCurrentChapter(currentBookTime, userPlaySession)
    let previousChapter = getCurrentChapter(currentChapter.start - 1, userPlaySession)
    let newBookTime


    if (offsetInMilliseconds > currentChapter.start * 1000 + 2000) { // go to beginning of current chapter
      newBookTime = currentChapter.start
      const result = getTrackAndOffsetFromBookTime(newBookTime, userPlaySession.audioTracks).currentTrack

      const offset = result.goalOffset

      offsetInMilliseconds = offset
    }
    else { // go to beginning of prior chapter

      newBookTime = previousChapter.start
      const result = getTrackAndOffsetFromBookTime(newBookTime, userPlaySession.audioTracks)
      const offset = result.goalOffset

      currentChapter = previousChapter
      offsetInMilliseconds = offset
    }


    amazonToken = localSessionAttributes.amazonToken = getCurrentTrackIndex(newBookTime, userPlaySession.audioTracks)

    playUrl = localSessionAttributes.playUrl = SERVER_URL + localSessionAttributes.userPlaySession.audioTracks[amazonToken - 1].contentUrl + "?token=" + ABS_API_KEY

    let newChapterTitle = currentChapter.title
    let coverUrl = getCoverUrl(userPlaySession.libraryItemId)

    updateUserPlaySession(userPlaySession, newBookTime)
    // manually set the new currentBookTime and updatedAt to local attributes
    sessionAttributes.userPlaySession.updatedAt = localSessionAttributes.userPlaySession.updatedAt = Date.now()
    sessionAttributes.userPlaySession.currentTime = localSessionAttributes.userPlaySession.currentTime = currentBookTime

    handlerInput.attributesManager.setSessionAttributes(sessionAttributes)

    metadata = {
      title: newChapterTitle,
      subtitle: userPlaySession.displayTitle,
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
            url: backgroundUrl,
            widthPixels: 1600,
            heightPixels: 900
          }
        ]
      }
    };
    response = handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",               // but then will metadata still be applied?
        playUrl,
        amazonToken,
        offsetInMilliseconds,
        null,
        metadata
      )
      .getResponse();

    return response
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
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes()
    const userPlaySession = sessionAttributes.userPlaySession
    sessionAttributes.offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
    sessionAttributes.amazonToken = localSessionAttributes.amazonToken = handlerInput.requestEnvelope.context.AudioPlayer.token
    localSessionAttributes = JSON.parse(JSON.stringify(sessionAttributes)); // clone sessionAttriubtes (avoid pointer issue)
    const chapters = sessionAttributes.userPlaySession.chapters

    let offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
    let amazonToken = localSessionAttributes.amazonToken = handlerInput.requestEnvelope.context.AudioPlayer.token

    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)

    // default behavior: go to beginning of chapter. If within 2 seconds of beginning, go to previous chapter
    let currentChapter = getCurrentChapter(currentBookTime, userPlaySession)
    let nextChapter = chapters[currentChapter.id + 1]
    let newBookTime
    let currentTrack = getCurrentTrack(currentBookTime, userPlaySession.audioTracks)
    // go to beginning of next chapter

    newBookTime = nextChapter.start

    if (newBookTime >= currentTrack.duration) {
      offsetInMilliseconds = 0
    }
    else {
      offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = nextChapter.start * 1000
    }



    amazonToken = localSessionAttributes.amazonToken = getCurrentTrackIndex(newBookTime, userPlaySession.audioTracks)

    playUrl = localSessionAttributes.playUrl = SERVER_URL + localSessionAttributes.userPlaySession.audioTracks[amazonToken - 1].contentUrl + "?token=" + ABS_API_KEY

    let newChapterTitle = nextChapter.title

    let coverUrl = getCoverUrl(userPlaySession.libraryItemId)

    updateUserPlaySession(userPlaySession, newBookTime)
    // manually set the new currentBookTime and updatedAt to local attributes
    sessionAttributes.userPlaySession.updatedAt = localSessionAttributes.userPlaySession.updatedAt = Date.now()
    sessionAttributes.userPlaySession.currentTime = localSessionAttributes.userPlaySession.currentTime = currentBookTime

    handlerInput.attributesManager.setSessionAttributes(sessionAttributes)

    metadata = {
      title: newChapterTitle,
      subtitle: userPlaySession.displayTitle,
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
            url: backgroundUrl,
            widthPixels: 1600,
            heightPixels: 900
          }
        ]
      }
    };
    response = handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",               // but then will metadata still be applied?
        playUrl,
        amazonToken,
        offsetInMilliseconds,
        null,
        metadata
      )
      .getResponse();

    return response
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

const GoBackXTimeIntentHandler = { // THIS LIKELY ENDS and FORGETS THE SESSION (custom intents do not "remember" session after it closes)
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GoBackXTimeIntent';
  },
  async handle(handlerInput) {


    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes()
    const currentOffsetInMilliseconds = sessionAttributes.offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
    const currentToken = sessionAttributes.amazonToken = localSessionAttributes.amazonToken = handlerInput.requestEnvelope.context.AudioPlayer.token
    const userPlaySession = sessionAttributes.userPlaySession

    const beforeBookTime = calculateCurrentTime(userPlaySession, currentOffsetInMilliseconds, currentToken)

    const currentUrl = sessionAttributes.playUrl
    const currentTrack = sessionAttributes.currentTrack
    const currentTrackIndex = currentTrack.index
    const currentTrackArrayIndex = currentTrack.index - 1 // the tracks array index (such as audioTracks[arrayIndex] is one less than its index property)

    let newOffsetInMilliseconds = currentOffsetInMilliseconds
    let newUrl = currentUrl
    let newToken = currentToken
    let newTrack = currentTrack

    const timeCode = handlerInput.requestEnvelope.request.intent.slots.time.value
    const milliseconds = isoDurationToMilliseconds(timeCode)
    let tickerMilliseconds = milliseconds

    if (milliseconds <= currentOffsetInMilliseconds) { // just seek back on current track
      newOffsetInMilliseconds = currentOffsetInMilliseconds - milliseconds
    }
    else if (milliseconds > currentOffsetInMilliseconds) { // skip to previous track
      if (currentTrack == 1) { // if first track, then just go to offset 0
        newOffsetInMilliseconds = 0
      }
      else if (currentTrackIndex > 1) { // if there's a previous track..
        let checkTrack = currentTrack
        let remainingDurationInMS = currentOffsetInMilliseconds
        let tickerArrayIndex = currentTrackArrayIndex
        let goToBeginning = false
        while (tickerMilliseconds > remainingDurationInMS && !goToBeginning) {
          if (tickerArrayIndex == 0) // if attempting to go before first track, then..
          {
            newToken = 1
            newOffsetInMilliseconds = 0 // go to beginning of the first track
            newTrack = userPlaySession.audioTracks[0]
            // newUrl = SERVER_URL + newTrack.contentUrl
            goToBeginning = true
          }
          else {
            tickerMilliseconds -= remainingDurationInMS
            tickerArrayIndex -= 1 // move to previous track
            checkTrack = userPlaySession.audioTracks[tickerArrayIndex]
            remainingDurationInMS = checkTrack.duration * 1000
          }
        }
        if (goToBeginning) { }
        else {
          newTrack = checkTrack
          newOffsetInMilliseconds = newTrack.duration * 1000 - tickerMilliseconds
        }
        newUrl = SERVER_URL + sessionAttributes.userPlaySession.audioTracks[newTrack.index - 1].contentUrl + "?token=" + ABS_API_KEY

        newToken = newTrack.index

      }


    }

    const afterBookTime = calculateCurrentTime(userPlaySession, newOffsetInMilliseconds, newToken)
    console.log("Before skip: " + beforeBookTime + " seconds")
    console.log("After skip: " + afterBookTime + " seconds")
    // update all important variables
    sessionAttributes.currentTrackIndex = sessionAttributes.amazonToken = localSessionAttributes.currentTrackIndex = localSessionAttributes.amazonToken = newToken
    sessionAttributes.currentTrack = localSessionAttributes.currentTrack = newTrack
    sessionAttributes.offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = newOffsetInMilliseconds
    sessionAttributes.playUrl = localSessionAttributes.playUrl = newUrl


    handlerInput.attributesManager.setSessionAttributes(sessionAttributes)
    updateLocalSessionAttributes(sessionAttributes)

    const coverUrl = getCoverUrl(userPlaySession.libraryItemId)
    // const coverUrl = sessionAttributes.coverUrl

    const chapterTitle = getCurrentChapter(afterBookTime, userPlaySession).title
    const metadata = {
      title: chapterTitle,
      subtitle: userPlaySession.displayTitle,
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
            url: backgroundUrl,
            widthPixels: 1600,
            heightPixels: 900
          }
        ]
      }
    };
    // THIS LIKELY ENDS and FORGETS THE SESSION (custom intents do not "remember" session after it closes)
    return response = handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        newUrl,
        newToken, // for amazon's token system 
        newOffsetInMilliseconds,
        null,
        metadata
      )
      .getResponse();
  }
}

const GoForwardXTimeIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GoForwardXTimeIntent';
  },
  async handle(handlerInput) {
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes()
    const currentOffsetInMilliseconds = sessionAttributes.offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
    const currentToken = sessionAttributes.amazonToken = localSessionAttributes.amazonToken = handlerInput.requestEnvelope.context.AudioPlayer.token
    // !!!need to handle if this is null
    const userPlaySession = sessionAttributes.userPlaySession

    const currentUrl = sessionAttributes.playUrl
    const currentTrack = sessionAttributes.currentTrack
    const currentTrackDurationInMS = currentTrack.duration * 1000

    const currentTrackArrayIndex = currentTrack.index - 1 // the tracks array index (such as audioTracks[arrayIndex] is one less than its index property)

    let newOffsetInMilliseconds = currentOffsetInMilliseconds
    let newUrl = currentUrl
    let newToken = currentToken
    let newTrackArrayIndex = currentTrackArrayIndex
    let newTrack = currentTrack

    const timeCode = handlerInput.requestEnvelope.request.intent.slots.time.value
    const milliseconds = isoDurationToMilliseconds(timeCode)
    let tickerMilliseconds = milliseconds
    let atTheEnd = false
    const beforeBookTime = calculateCurrentTime(userPlaySession, currentOffsetInMilliseconds, currentToken)


    if (currentOffsetInMilliseconds + milliseconds < currentTrackDurationInMS) { // just seek forward on current track
      newOffsetInMilliseconds = currentOffsetInMilliseconds + milliseconds
    }
    else if (currentOffsetInMilliseconds + milliseconds >= currentTrackDurationInMS) { // skip to next tracks
      if (!userPlaySession.audioTracks[currentTrackArrayIndex]) { // if already on last track, then go to end minus 5 seconds
        newOffsetInMilliseconds = currentTrackDurationInMS - 5000
        // sessionAttributes.nextStreamEnqueued = false
      }
      else {
        let checkTrack = currentTrack
        let remainingDurationInMS = currentTrack.duration * 1000 - currentOffsetInMilliseconds
        let tickerArrayIndex = currentTrackArrayIndex

        while (tickerMilliseconds > remainingDurationInMS && !atTheEnd) {
          // if attempting to go past last track, then..
          if (milliseconds > (userPlaySession.duration - beforeBookTime) * 1000) {
            newTrackArrayIndex = userPlaySession.audioTracks.length - 1
            newToken = userPlaySession.audioTracks.length
            newTrack = userPlaySession.audioTracks[newTrackArrayIndex]
            // newUrl = SERVER_URL + newTrack.contentUrl
            atTheEnd = true
            newOffsetInMilliseconds = newTrack.duration * 1000 - 5000
          }
          else {
            tickerMilliseconds -= remainingDurationInMS
            tickerArrayIndex += 1 // move to next track
            checkTrack = userPlaySession.audioTracks[tickerArrayIndex]
            remainingDurationInMS = checkTrack.duration * 1000
          }
        }
        if (atTheEnd) { }
        else {
          newTrack = checkTrack
          newTrackArrayIndex = tickerArrayIndex
          newOffsetInMilliseconds = tickerMilliseconds
        }

        newUrl = SERVER_URL + sessionAttributes.userPlaySession.audioTracks[newTrack.index - 1].contentUrl + "?token=" + ABS_API_KEY

        newToken = newTrack.index

      }

    }

    const afterBookTime = calculateCurrentTime(userPlaySession, newOffsetInMilliseconds, newToken)
    console.log("Before skip: " + beforeBookTime + " seconds")
    console.log("After skip: " + afterBookTime + " seconds")
    console.log("Seconds skipped: " + (parseInt(afterBookTime) - parseInt(beforeBookTime)).toString() + " seconds");
    // update all important variables
    sessionAttributes.currentTrackIndex = sessionAttributes.amazonToken = localSessionAttributes.currentTrackIndex = localSessionAttributes.amazonToken = newToken
    sessionAttributes.currentTrack = localSessionAttributes.currentTrack = newTrack
    sessionAttributes.offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = newOffsetInMilliseconds
    sessionAttributes.playUrl = localSessionAttributes.playUrl = newUrl


    handlerInput.attributesManager.setSessionAttributes(sessionAttributes)
    updateLocalSessionAttributes(sessionAttributes)

    const coverUrl = getCoverUrl(userPlaySession.libraryItemId)
    // const coverUrl = sessionAttributes.coverUrl

    const chapterTitle = getCurrentChapter(afterBookTime, userPlaySession).title
    const metadata = {
      title: chapterTitle,
      subtitle: userPlaySession.displayTitle,
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
            url: backgroundUrl,
            widthPixels: 1600,
            heightPixels: 900
          }
        ]
      }
    };

    return response = handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        newUrl,
        newToken, // for amazon's token system 
        newOffsetInMilliseconds,
        null,
        metadata
      )
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

    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes()
    const userPlaySession = sessionAttributes.userPlaySession
    const offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
    const amazonToken = sessionAttributes.amazonToken = handlerInput.requestEnvelope.context.AudioPlayer.token
    if (userPlaySession && offsetInMilliseconds !== null && amazonToken !== null) {
      const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)
      //const timeListened = (Date.now() - userPlaySession.updatedAt) / 1000
      // timeListened = the time (in seconds) since session last updated (or created)
      if (closeUserPlaySession(userPlaySession, currentBookTime) == 0) {
        closedPlaySession = true
      }

    }
    else {
      console.log("CancelAndStopIntentHandler: userPlaySession or offsetInMilliseconds or amazonToken is null; could not close ABS play session")
    }
    console.log("CancelAndStopIntentHandler: closing Alexa skill")
    return handlerInput.responseBuilder
      .speak(sanitizeForSSML(speakOutput))
      .addAudioPlayerStopDirective()
      .withShouldEndSession(true)
      .getResponse();
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
    try {
      // *** AudioPlayerEventHandler can NOT access sessionAttributes
      // need another way of communicating; localSessionAttributes? persistent attributes?

      // must use localSessionAttributes, and then update sessionAttributes when available

      // this offset isn't always being set; is offsetInMilliseconds passed in different
      // parts of handlerInput sometimes?

      const audioPlayerEventName = handlerInput.requestEnvelope.request.type.split('.')[1];
      console.log(`AudioPlayer event encountered: ${handlerInput.requestEnvelope.request.type}`);

      let offset = localSessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.request.offsetInMilliseconds;
      if (offset == undefined) {
        offset = localSessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds;
      }
      if (offset == undefined) {
        console.log("offsetInMilliseconds wasn't pulled from handlerInput correctly");
      }
      const amazonToken = localSessionAttributes.amazonToken = handlerInput.requestEnvelope.request.token;
      if (amazonToken == undefined) {
        console.log("amazonToken wasn't pulled from handlerInput correctly");
      }
      let currentBookTime
      const userPlaySession = localSessionAttributes.userPlaySession;
      if (!userPlaySession || offset == undefined || amazonToken == undefined) {
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
          //?? handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds 
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
            break;
          }
          break;

        case 'PlaybackStopped': // run when user stops playback
          // NEW CODE
          // need to write "offset" and "token" to ABS here
          // but actually just writing currentBookTime and maybe just noting the token (filename? fileID?)
          offsetInMilliseconds = handlerInput.requestEnvelope.request.offsetInMilliseconds
            ?? handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
            ?? null
          if (closedPlaySession) // if ABS play session is already closed, don't update again
          {
            console.log("PlaybackStopped: ABS session is closed, so will not update ABS again")
          }
          else {
            if (offsetInMilliseconds !== null && userPlaySession && amazonToken !== null && !closedPlaySession) {
              const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)
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


            let currentToken = amazonToken;
            let nextToken = (parseInt(currentToken) + 1).toString();
            const nextAudioTrack = localSessionAttributes.userPlaySession.audioTracks[nextToken - 1];
            if (nextAudioTrack) {
              localSessionAttributes.nextStreamEnqueued = true;
              let nextUrl = SERVER_URL + nextAudioTrack.contentUrl + "?token=" + ABS_API_KEY;
              const currentChapterID = getCurrentChapter(currentBookTime, userPlaySession).id;

              const coverUrl = getCoverUrl(userPlaySession.libraryItemId);
              const nextChapterTitle = userPlaySession.chapters[currentChapterID + 1].title;
              const metadata = {
                title: nextChapterTitle,
                subtitle: userPlaySession.displayTitle,
                art: {
                  sources: [{ url: coverUrl, widthPixels: 512, heightPixels: 512 }],
                },
                backgroundImage: {
                  sources: [{ url: backgroundUrl, widthPixels: 1600, heightPixels: 900 }],
                },
              };
              response = handlerInput.responseBuilder
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
          console.log('Playback Failed : %j', handlerInput.requestEnvelope.request.error);
          if (!userPlaySession || currentBookTime === undefined) {
            console.log("PlaybackFailed, but userPlaySession or currentBookTime was undefined, so could not sync or close ABS play session.");
          }
          else {
            closeUserPlaySession(userPlaySession, currentBookTime);
          }
          break;

        default:
          break;
      }
      return handlerInput.responseBuilder.getResponse();
    } catch (error) {
      console.error("Error handling AudioPlayer event:", error);
      return handlerInput.responseBuilder.getResponse();
    }
  },
};


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

// This is for devices with external play controls -- probably need to test this more
const PlaybackControllerHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type.startsWith('PlaybackController.');
  },
  async handle(handlerInput) {
    const playbackControllerEventName = handlerInput.requestEnvelope.request.type.split('.')[1];

    // can NOT use sessionAttributes here; need to use local
    const userPlaySession = localSessionAttributes.userPlaySession
    let offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds
    let amazonToken = localSessionAttributes.amazonToken
    let metadata

    if (handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds != undefined) {
      offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds
      amazonToken = localSessionAttributes.amazonToken = handlerInput.requestEnvelope.context.AudioPlayer.token
    }


    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)

    let response;
    switch (playbackControllerEventName) {
      case 'PlayCommandIssued':
        updateUserPlaySession(userPlaySession, currentBookTime)
        // manually set the new currentBookTime and updatedAt to local attributes
        localSessionAttributes.userPlaySession.updatedAt = Date.now()
        localSessionAttributes.userPlaySession.currentTime = currentBookTime

        const coverUrl = getCoverUrl(userPlaySession.libraryItemId)
        // const coverUrl = localSessionAttributes.coverUrl

        const chapterTitle = getCurrentChapter(currentBookTime, userPlaySession).title
        metadata = {
          title: chapterTitle,
          subtitle: userPlaySession.displayTitle,
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
                url: backgroundUrl,
                widthPixels: 1600,
                heightPixels: 900
              }
            ]
          }
        };

        response = handlerInput.responseBuilder
          .addAudioPlayerPlayDirective(/* // seems like over kill to do all of the parameters
                playBehavior,               // but then will metadata still be applied?
                podcastUrl,
                token,
                offset
                */)
          .getResponse();
        break;
      case 'PauseCommandIssued':
        updateUserPlaySession(userPlaySession, currentBookTime)
        // manually set the new currentBookTime and updatedAt to local attributes
        localSessionAttributes.userPlaySession.updatedAt = Date.now()
        localSessionAttributes.userPlaySession.currentTime = currentBookTime

        response = handlerInput.responseBuilder
          .addAudioPlayerStopDirective()
          .getResponse();
        break;
      case 'PreviousCommandIssued':
        // default behavior: go to beginning of chapter. If within 2 seconds of beginning, go to previous chapter
        let currentChapter = getCurrentChapter(currentBookTime, userPlaySession)
        let previousChapter = getCurrentChapter(currentChapter.start - 1, userPlaySession)
        let newBookTime

        if (offsetInMilliseconds > currentChapter.start * 1000 + 2000) { // go to beginning of current chapter
          newBookTime = currentChapter.start
          offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = currentChapter.start * 1000
        }
        else { // go to beginning of prior chapter

          newBookTime = previousChapter.start
          currentChapter = previousChapter
          offsetInMilliseconds = localSessionAttributes.offsetInMilliseconds = previousChapter.start * 1000
        }


        amazonToken = localSessionAttributes.amazonToken = getCurrentTrackIndex(newBookTime, userPlaySession.audioTracks)

        playUrl = localSessionAttributes.playUrl = SERVER_URL + localSessionAttributesuserPlaySession.audioTracks[amazonToken - 1].contentUrl + "?token=" + ABS_API_KEY

        let newChapterTitle = currentChapter.title

        updateUserPlaySession(userPlaySession, newBookTime)
        // manually set the new currentBookTime and updatedAt to local attributes
        localSessionAttributes.userPlaySession.updatedAt = Date.now()
        localSessionAttributes.userPlaySession.currentTime = currentBookTime


        metadata = {
          title: newChapterTitle,
          subtitle: userPlaySession.displayTitle,
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
                url: backgroundUrl,
                widthPixels: 1600,
                heightPixels: 900
              }
            ]
          }
        };
        response = handlerInput.responseBuilder
          .addAudioPlayerPlayDirective(
            "REPLACE_ALL",               // but then will metadata still be applied?
            playUrl,
            amazonToken,
            offsetInMilliseconds
          )
          .getResponse();
        break
      case 'NextCommandIssued':

        break
      default:
        break;
    }

    console.log(`PlayCommandIssued event encountered: ${handlerInput.requestEnvelope.request.type}`);
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
    console.log(`System exception encountered: ${JSON.stringify(handlerInput.requestEnvelope.request)}`);
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
      console.log('SessionEndedRequest reason:', request.reason);
      if (request.error) {
        console.error('SessionEndedRequest error:', request.error);
      }
      let sessionAttributes = handlerInput.attributesManager.getSessionAttributes()
      const userPlaySession = sessionAttributes.userPlaySession
      const offsetInMilliseconds =
        handlerInput.requestEnvelope.context.AudioPlayer?.offsetInMilliseconds || // Try AudioPlayer first
        handlerInput.requestEnvelope.session?.attributes?.offsetInMilliseconds || // Fallback to session attributes
        localSessionAttributes.offsetInMilliseconds || // Fallback to localsessionAttributes
        null; // Default to null if all else fails

      const amazonToken =
        handlerInput.requestEnvelope.context?.AudioPlayer?.token || // Try AudioPlayer first
        handlerInput.requestEnvelope.session?.attributes?.amazonToken || // Fallback to session attributes
        localSessionAttributes.amazonToken || // Fallback to local sessionAttributes
        null; // Default to null if all else fails

      if (amazonToken !== null && offsetInMilliseconds !== null && userPlaySession) {
        const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken)
        if (closeUserPlaySession(userPlaySession, currentBookTime) == 0) { // if session closed successfully
          closedPlaySession = true
          console.log("SessionEndedRequest: successfully closed ABS session")
        }
      }
      if (handlerInput.requestEnvelope.request.reason == 'USER_INITIATED') {
        sessionAttributes = {}
        localSessionAttributes = {}
        handlerInput.attributesManager.setSessionAttributes(sessionAttributes)
      }


      console.log(`~~~~ Session ended: ${JSON.stringify(handlerInput.requestEnvelope)}`);
      console.log(`~~~~ Session ended reason: ${handlerInput.requestEnvelope.request.reason}`);
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
    const speakOutput = `You just triggered ${intentName}`;

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
    const speakOutput = 'Sorry, I had trouble doing what you asked. Please try again.';
    console.log(`~~~~ Error handled: ${JSON.stringify(error)}`);

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

/* HELPER FUNCTIONS */

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
    PlaybackBookHandler,
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
  //  .addRequestInterceptors(LoadPersistentAttributesRequestInterceptor)
  //  .addResponseInterceptors(SavePersistentAttributesResponseInterceptor)
  .withCustomUserAgent('HarrisonAlexaSkill')
  /*
  .withPersistenceAdapter(
      new ddbAdapter.DynamoDbPersistenceAdapter({
          tableName: process.env.DYNAMODB_PERSISTENCE_TABLE_NAME,
          createTable: false,
          dynamoDBClient: new AWS.DynamoDB({apiVersion: 'latest', region: process.env.DYNAMODB_PERSISTENCE_REGION})
      })
  )
      */
  .lambda();