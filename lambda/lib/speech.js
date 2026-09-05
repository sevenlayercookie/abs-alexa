'use strict';

function formatSpokenList(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}`;
}

module.exports = { formatSpokenList };
