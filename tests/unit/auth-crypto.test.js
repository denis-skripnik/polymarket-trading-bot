import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';

import { encrypt, decrypt } from '../../src/modules/auth.js';

test('encrypt/decrypt performs round-trip with valid key', async () => {
  const key = randomBytes(32);
  const plaintext = 'secret-value';
  const encrypted = await encrypt(plaintext, key);
  const decrypted = await decrypt(encrypted, key);
  assert.equal(decrypted, plaintext);
});

test('encrypt rejects invalid key length', async () => {
  await assert.rejects(() => encrypt('value', randomBytes(16)));
});

test('decrypt rejects invalid payload format', async () => {
  const key = randomBytes(32);
  await assert.rejects(() => decrypt('invalid', key));
});
