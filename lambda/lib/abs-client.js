'use strict';
// Every HTTP call to Audiobookshelf. Stateless: these take what they need as
// arguments and return parsed responses.

const request = require('sync-request');
const { SERVER_URL, baseheaders } = require('./settings');

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

// Idempotent: it records where the user is in a book without opening or
// touching a play session, so it adds nothing to ABS listening history. That
// makes it the safe way to save a position when the play session is gone.
function updateMediaProgress(libraryItemId, episodeId, data) {
  if (!libraryItemId) throw new Error('Cannot update media progress without a library item id');
  const url = episodeId
    ? `${SERVER_URL}/api/me/progress/${libraryItemId}/${episodeId}`
    : `${SERVER_URL}/api/me/progress/${libraryItemId}`;

  // baseheaders carries the bearer token; without it ABS answers 401.
  const res = request('PATCH', url, { headers: baseheaders, json: data });
  console.log("updateMediaProgress - Response code: " + res.statusCode);
  if (res.statusCode !== 200) throw new Error(`Failed to update media progress: HTTP ${res.statusCode}`);
  return true;
}

function updateUserPlaySession(playSession, currentBookTime, timeListened) {
  if (!playSession?.id) throw new Error('Cannot sync an invalid play session');
  if (!Number.isFinite(Number(currentBookTime))) throw new Error('Cannot sync an invalid playback position');

  const payload = {
    currentTime: Number(currentBookTime),
    timeListened: Math.max(0, Number(timeListened) || 0),
    duration: playSession.duration,
  };
  console.log("Update ABS play session for book: " + playSession.mediaMetadata.title);
  const res = request('POST', SERVER_URL + `/api/session/${playSession.id}/sync`, {
    headers: { 'Content-Type': 'application/json', ...baseheaders },
    json: payload,
  });
  console.log("updateUserPlaySession - Response code: " + res.statusCode);
  if (res.statusCode !== 200) throw new Error(`Failed to sync play session: HTTP ${res.statusCode}`);
  console.log("updateUserPlaySession - Successfully synced play session with ABS");
  return true;
}

function closeUserPlaySession(userPlaySession, currentBookTime, timeListened) {
  if (!userPlaySession?.id) throw new Error('Cannot close an invalid play session');
  if (!Number.isFinite(Number(currentBookTime))) throw new Error('Cannot close at an invalid playback position');

  const payload = {
    currentTime: Number(currentBookTime),
    timeListened: Math.max(0, Number(timeListened) || 0),
    duration: userPlaySession.duration,
  };
  const apiUrl = SERVER_URL + `/api/session/${userPlaySession.id}/close`;
  console.log("Close ABS play session for book: " + userPlaySession.mediaMetadata.title);
  const res = request('POST', apiUrl, {
    headers: { 'Content-Type': 'application/json', ...baseheaders },
    json: payload,
  });
  console.log("closeUserPlaySession - Response code: " + res.statusCode);
  if (res.statusCode !== 200) throw new Error(`Failed to close play session: HTTP ${res.statusCode}`);
  console.log("closeUserPlaySession - Successfully synced and closed play session with ABS");
  return true;
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
