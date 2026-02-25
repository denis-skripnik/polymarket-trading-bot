import test from 'node:test';
import assert from 'node:assert/strict';

import {
  setBot,
  bot,
  setAllowedUserId,
  allowedUserId,
  setBotClientReady,
  botClientReady,
  setBotContractsReady,
  botContractsReady,
  setLocalesCache,
  localesCache,
  setCategoriesCatalogCache,
  categoriesCatalogCache
} from '../../src/modules/bot/runtime.js';

test('runtime setters update exported state holders', () => {
  setBot({ id: 'bot-1' });
  setAllowedUserId('123');
  setBotClientReady(true);
  setBotContractsReady(true);
  setLocalesCache({ en: { ok: 'OK' } });
  setCategoriesCatalogCache({ items: ['a'], timestamp: 1, language: 'en' });

  assert.deepEqual(bot, { id: 'bot-1' });
  assert.equal(allowedUserId, '123');
  assert.equal(botClientReady, true);
  assert.equal(botContractsReady, true);
  assert.deepEqual(localesCache, { en: { ok: 'OK' } });
  assert.deepEqual(categoriesCatalogCache, { items: ['a'], timestamp: 1, language: 'en' });
});
