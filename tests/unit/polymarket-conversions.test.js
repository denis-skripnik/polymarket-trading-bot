import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseUSDCToBase,
  formatUSDCFromBase,
  parseSharesToBase,
  formatSharesFromBase,
  parsePriceToMicro,
  formatPriceFromMicro,
  computeSharesFromUSDC,
  computeUSDCFromShares,
  calculateMarketablePriceMicro
} from '../../src/modules/polymarket.js';

test('USDC conversion round-trip uses 6-decimal base units', () => {
  const base = parseUSDCToBase('12,345678');
  assert.equal(base, 12345678n);
  assert.equal(formatUSDCFromBase(base), '12.345678');
});

test('shares conversion round-trip uses 6-decimal base units', () => {
  const base = parseSharesToBase('61.3');
  assert.equal(base, 61300000n);
  assert.equal(formatSharesFromBase(base), '61.300000');
});

test('price conversion round-trip uses micro precision', () => {
  const micro = parsePriceToMicro('0.1234');
  assert.equal(micro, 123400n);
  assert.equal(formatPriceFromMicro(micro), '0.123400');
});

test('computeSharesFromUSDC and computeUSDCFromShares use floor integer math', () => {
  const shares = computeSharesFromUSDC(1_000_000n, 500_000n);
  assert.equal(shares, 2_000_000n);

  const usdc = computeUSDCFromShares(2_000_000n, 500_000n);
  assert.equal(usdc, 1_000_000n);
});

test('computeSharesFromUSDC rejects zero and negative price', () => {
  assert.throws(() => computeSharesFromUSDC(1_000_000n, 0n));
  assert.throws(() => computeSharesFromUSDC(1_000_000n, -1n));
});

test('calculateMarketablePriceMicro applies BUY/SELL buffers with clamping', () => {
  assert.equal(calculateMarketablePriceMicro(980_000n, 'BUY'), 990_000n);
  assert.equal(calculateMarketablePriceMicro(20_000n, 'SELL'), 10_000n);
  // Unknown side currently follows SELL branch.
  assert.equal(calculateMarketablePriceMicro(500_000n, 'UNKNOWN'), 480_000n);
});
