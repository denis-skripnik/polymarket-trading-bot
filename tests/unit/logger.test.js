import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeNumericInput,
  isRetryableError,
  formatError,
  redactSensitive
} from '../../src/modules/logger.js';

test('normalizeNumericInput normalizes comma and spaces', () => {
  assert.equal(normalizeNumericInput(' 1 234,56 '), '1234.56');
});

test('normalizeNumericInput rejects invalid values', () => {
  assert.throws(() => normalizeNumericInput('abc'));
  assert.throws(() => normalizeNumericInput('1.1234567'));
});

test('isRetryableError marks transient errors as retryable', () => {
  assert.equal(isRetryableError({ status: 429 }), true);
  assert.equal(isRetryableError({ response: { status: 503 } }), true);
  assert.equal(isRetryableError(new Error('network timeout')), true);
  assert.equal(isRetryableError({ status: 400, message: 'bad request' }), false);
});

test('formatError localizes common cases', () => {
  const insufficientRu = formatError(new Error('insufficient balance'), 'ru');
  assert.equal(insufficientRu.title, 'Недостаточно средств');
  const allowanceEn = formatError(new Error('allowance too low'), 'en');
  assert.equal(allowanceEn.title, 'Insufficient allowance');
});

test('redactSensitive removes secret-like fields recursively', () => {
  const input = {
    safe: 'ok',
    secret: 'abc',
    nested: {
      apiKey: 'top-secret',
      amount: 42n
    }
  };

  const output = redactSensitive(input);
  assert.equal(output.safe, 'ok');
  assert.equal(output.secret, '[REDACTED]');
  assert.equal(output.nested.apiKey, '[REDACTED]');
  assert.equal(output.nested.amount, '42');
});
