'use strict';
// Every HTTP call to Audiobookshelf. Stateless: these take what they need as
// arguments and return parsed responses.

const request = require('sync-request');
const { SERVER_URL, ABS_API_KEY, baseheaders } = require('./settings');
const { calculateCurrentTime } = require('./audio');

function getRecentLibraryItems(limit = 3) {
  try {
    const requestedLimit = Number.isInteger(limit) && limit > 0 ? limit : 3;
    let res = request('GET', `${SERVER_URL}/api/me/items-in-progress?limit=${requestedLimit}`, { headers: baseheaders });
    if (res.statusCode !== 200) {
      throw new Error(`Failed to fetch recent library items: HTTP ${res.statusCode}`);
    }
    let data = JSON.parse(res.getBody('utf8'));
    const libraryItems = Array.isArray(data.libraryItems) ? data.libraryItems : [];
    return libraryItems
      .filter(item => item?.media?.metadata?.title)
      .slice(0, requestedLimit);
  } catch (error) {
    console.error('Error during getRecentLibraryItems:', error);
    throw error;
  }
}

function getLastPlayedLibraryItem() {
  return getRecentLibraryItems(1)[0];
}

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
  let res;
  try {
    console.log("startUserPlaySession")
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



    res = request('POST', SERVER_URL + `/api/items/${libraryID}/play`, { headers: baseheaders, json: bodyParameters });
    if (res.statusCode !== 200) {
      throw new Error(`Failed to start play session: HTTP ${res.statusCode}`);
    }

    let data = JSON.parse(res.getBody('utf8'));

    return data;
  } catch (error) {
    console.error('Error retrieving play session:', error.message);
    throw error;
  }
}

function getExistingUserPlaySession(sessionID) {
  try {
    console.log("getExistingUserPlaySession")
    const res = request('GET', SERVER_URL + `/api/session/${encodeURIComponent(sessionID)}`, { headers: baseheaders });
    if (res.statusCode !== 200) {
      throw new Error(`Failed to fetch play session: HTTP ${res.statusCode}`);
    }
    let data = JSON.parse(res.getBody('utf8'));

    return data;
  } catch (error) {
    console.error('Error retrieving play session:', error.message);
    throw error;
  }
}

function updateMediaProgress(baseUrl = SERVER_URL, libraryItemId, episodeId = "", data) {
  // Construct the URL based on the presence of episodeId
  const url = episodeId
      ? `${baseUrl}/api/me/progress/${libraryItemId}/${episodeId}`
      : `${baseUrl}/api/me/progress/${libraryItemId}`;

  try {
      // Make the PATCH request
      const res = request('PATCH', url, {
          json: data,
          headers: {
              'Content-Type': 'application/json',
          },
      });

      // Parse and return the response
      return JSON.parse(res.getBody('utf8'));
  } catch (error) {
      throw new Error(`Failed to update media progress: ${error.message}`);
  }
}

function updateUserPlaySession(playSession, currentBookTime) {
  let res;
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
    console.log("Update ABS play session for book: " + playSession.mediaMetadata.title);

    res = request('POST', SERVER_URL + `/api/session/${playSessionID}/sync`, { headers: baseheaders, body: body });
    console.log("updateUserPlaySession - Response code: " + res.statusCode);
    if (res.statusCode == 200) {
      console.log("updateUserPlaySession - Successfully synced play session with ABS");
    }
    if (res.statusCode == 404) {
      console.log("updateUserPlaySession - ABS: No listening session with the provided ID is open, or the session belongs to another user.");
      throw new Error(`Failed to sync play session: HTTP ${res.statusCode}`);
    }
    if (res.statusCode == 500) {
      console.log("updateUserPlaySession - ABS: Internal Server Error:There was an error syncing the session.");
      throw new Error(`Failed to sync play session: HTTP ${res.statusCode}`);
    }
    return // docs say this returns playSession, but not in my experience

    //let playSession = JSON.parse(res.getBody('utf8')); this doesn't seem to return the session...
    // let playbackURL = data.audioTracks[0].contentUrl

    //return playSession;

  } catch (error) {
    console.error('updateUserPlaySession - Error updating play session:', error.message);
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
    console.log("Close ABS play session for book: " + userPlaySession.mediaMetadata.title);
    let res = request('POST', apiUrl, { headers: baseheaders, body: body });
    console.log("closeUserPlaySession - Response code: " + res.statusCode);

    if (res.statusCode == 200) {
      console.log("closeUserPlaySession - Successfully synced and closed play session with ABS");
      return 0;
    }
    if (res.statusCode == 404) {
      console.log("closeUserPlaySession - ABS: No listening session with the provided ID is open, or the session belongs to another user.");
      throw new Error(`Failed to close play session: HTTP ${res.statusCode}`);
    }
    if (res.statusCode !== 200) {
      throw new Error(`Failed to close play session: HTTP ${res.statusCode}`);
    }
  } catch (error) {
    console.error('closeUserPlaySession - Error closing play session:', error.message);
    return
  }
}

function getCoverUrl(libraryItemId) {
  // as of 11/28/24, retrieving cover does not require authentication
  return SERVER_URL + `/api/items/${libraryItemId}/cover`
}

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

function buildLibrarySearchUrl(query, libraryID) {
  return `${SERVER_URL}/api/libraries/${encodeURIComponent(libraryID)}/search?q=${encodeURIComponent(query)}`;
}

function searchFor(query, libraryID) {
  try {
    const url = buildLibrarySearchUrl(query, libraryID);
    let res = request('GET', url, { headers: baseheaders });
    let data = JSON.parse(res.getBody('utf8'));
    return data;
  } catch (error) {
    console.error('Error during searchFor:', error);
    throw error;
  }
}

module.exports = { getRecentLibraryItems, getLastPlayedLibraryItem, getItemById, startUserPlaySession,
  getExistingUserPlaySession, updateMediaProgress, updateUserPlaySession,
  closeUserPlaySession, getCoverUrl, getLibraryFilterData, getAllLibraries,
  getAllAudiobooks, getLibraryItems, getAuthor, buildLibrarySearchUrl, searchFor };
