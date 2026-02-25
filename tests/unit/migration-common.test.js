import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  parsePositiveInt,
  normalizeFingerprint,
  formatFingerprint,
  decodeBase64
} from '../../scripts/migration-common.js';

test('parseArgs parses flags and key-value pairs', () => {
  const args = parseArgs(['--ttl-minutes', '30', '--allow-expired', '--request', 'req.json']);
  assert.deepEqual(args, {
    'ttl-minutes': '30',
    'allow-expired': true,
    request: 'req.json'
  });
});

test('parsePositiveInt returns fallback for invalid values', () => {
  assert.equal(parsePositiveInt('25', 10), 25);
  assert.equal(parsePositiveInt('-1', 10), 10);
  assert.equal(parsePositiveInt('NaN', 10), 10);
});

test('fingerprint helpers normalize and format values', () => {
  const normalized = normalizeFingerprint('aa:bb-cc dd');
  assert.equal(normalized, 'AABBCCDD');
  assert.equal(formatFingerprint(normalized), 'AABB CCDD');
});

test('decodeBase64 decodes valid input and rejects corrupted base64', () => {
  const encoded = Buffer.from('hello', 'utf8').toString('base64');
  assert.equal(decodeBase64(encoded, 'field').toString('utf8'), 'hello');
  assert.throws(() => decodeBase64('@@@', 'field'));
});
