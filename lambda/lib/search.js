'use strict';
// Finding the right book: Amazon's entity resolution, the Audiobookshelf
// search API, and a fuzzy fallback over the whole library.

const Fuse = require('fuse.js');
const request = require('sync-request'); // getEntityData calls Amazon, not ABS
const { getAllLibraries, getAllAudiobooks, searchFor } = require('./abs-client');
const { timers } = require('./timers');

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

module.exports = { getEntityData, fuzzyMatch, fuzzyStringMatch, searchBookWithAbsAPI, amazonCrossmatch, searchByTitleOnly };
