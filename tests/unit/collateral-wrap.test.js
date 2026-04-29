import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLATERAL_ONRAMP_ADDRESS,
  NEG_RISK_WRAPPED_COLLATERAL_ADDRESS,
  PUSD_ADDRESS,
  USDCE_ADDRESS
} from '../../src/modules/constants.js';
import { mapErrorToUserMessage } from '../../src/modules/polymarket.js';

test('Polygon collateral constants match confirmed wrap-flow contracts', () => {
  assert.strictEqual(PUSD_ADDRESS, '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB');
  assert.strictEqual(USDCE_ADDRESS, '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174');
  assert.strictEqual(COLLATERAL_ONRAMP_ADDRESS, '0x93070a847efEf7F70739046A929D47a521F5B8ee');
  assert.strictEqual(NEG_RISK_WRAPPED_COLLATERAL_ADDRESS, '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2');
});

test('mapErrorToUserMessage keeps wrap guidance for pUSD shortage errors', () => {
  const error = new Error(
    'Insufficient balance. Balance: 0.5 pUSD, Required: 2 pUSD. Wallet also has 4.2 USDC.e available to wrap into pUSD via Settings → Collateral Status.'
  );

  const mapped = mapErrorToUserMessage(error);
  assert.equal(mapped.key, 'error_order_failed');
  assert.match(mapped.params.message, /USDC\.e/);
  assert.match(mapped.params.message, /wrap/i);
  assert.match(mapped.params.message, /pUSD/);
});

test('mapErrorToUserMessage keeps explicit USDC.e wrap errors user-visible', () => {
  const mapped = mapErrorToUserMessage(new Error('Insufficient USDC.e balance. Available: 0.9 USDC.e'));
  assert.equal(mapped.key, 'error_order_failed');
  assert.match(mapped.params.message, /USDC\.e/);
});
