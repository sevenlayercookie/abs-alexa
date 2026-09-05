'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const settingsPath = require.resolve('../lambda/lib/settings');
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: {
    ABS_API_KEY: 'TEST_API_KEY',
    SERVER_URL: 'https://abs.example',
    baseheaders: {},
  },
};

const { firstBookFromAbsSearch } = require('../lambda/lib/search');
const { buildLibrarySearchUrl } = require('../lambda/lib/abs-client');

describe('Audiobookshelf search', () => {
  test('uses a match from a later library when the first has none', () => {
    const wanted = { libraryItem: { id: 'book-in-second-library' } };
    const result = firstBookFromAbsSearch([
      { book: [] },
      { book: [wanted] },
    ]);

    assert.strictEqual(result, wanted);
  });

  test('handles no audiobook libraries', () => {
    assert.strictEqual(firstBookFromAbsSearch([]), null);
  });

  test('encodes titles and library ids as URL components', () => {
    const url = buildLibrarySearchUrl('Dune & Messiah #1?', 'library/one');

    assert.strictEqual(
      url,
      'https://abs.example/api/libraries/library%2Fone/search?q=Dune%20%26%20Messiah%20%231%3F');
  });
});
