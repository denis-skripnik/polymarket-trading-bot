import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  parsePercentInput,
  parsePositiveNumberInput,
  parseUnitIntervalInput,
  parseEventsFilterRangeInput,
  parseNonNegativeIntegerInput,
  formatTxHashLink,
  normalizeOutcomeSideHint
} from '../../src/modules/bot/ui/formatters.js';

test('escapeHtml escapes reserved HTML characters', () => {
  assert.equal(
    escapeHtml(`a&<b>"'`),
    'a&amp;&lt;b&gt;&quot;&#39;'
  );
});

test('parsePercentInput parses signed decimal input and rejects invalid values', () => {
  assert.equal(parsePercentInput(' -12,345 '), -12.35);
  assert.equal(parsePercentInput('abc'), null);
});

test('parsePositiveNumberInput parses valid positive input', () => {
  assert.equal(parsePositiveNumberInput('10,5'), 10.5);
  assert.equal(parsePositiveNumberInput('-1'), null);
});

test('parseUnitIntervalInput rounds to requested precision', () => {
  assert.equal(parseUnitIntervalInput('0.123456', 4), 0.1235);
  assert.equal(parseUnitIntervalInput('0', 4), null);
});

test('parseEventsFilterRangeInput parses valid range and rejects invalid one', () => {
  assert.deepEqual(parseEventsFilterRangeInput('0.1 - 0.9'), { min: 0.1, max: 0.9 });
  assert.equal(parseEventsFilterRangeInput('0.9 - 0.1'), null);
});

test('parseNonNegativeIntegerInput parses integer and rejects non-integer', () => {
  assert.equal(parseNonNegativeIntegerInput(' 42 '), 42);
  assert.equal(parseNonNegativeIntegerInput('4.2'), null);
});

test('formatTxHashLink formats Polygonscan link', () => {
  const hash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const link = formatTxHashLink(hash);
  assert.ok(link.includes('https://polygonscan.com/tx/'));
  assert.ok(link.includes('<a href='));
});

test('normalizeOutcomeSideHint recognizes YES/NO variants', () => {
  assert.equal(normalizeOutcomeSideHint('yes'), 'YES');
  assert.equal(normalizeOutcomeSideHint('нет'), 'NO');
  assert.equal(normalizeOutcomeSideHint('maybe'), null);
});
