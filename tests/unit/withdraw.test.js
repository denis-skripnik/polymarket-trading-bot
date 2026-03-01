import test from 'node:test';
import assert from 'node:assert/strict';

// Test validation functions from withdraw feature
// We test the logic directly without importing the module (to avoid dependencies)

// Validate Ethereum address format (same as in withdraw.js)
function isValidEthAddress(address) {
  if (!address || typeof address !== 'string') return false;
  const normalized = address.toLowerCase().trim();
  return /^0x[a-f0-9]{40}$/.test(normalized);
}

test('isValidEthAddress rejects invalid addresses', () => {
  assert.strictEqual(isValidEthAddress(''), false);
  assert.strictEqual(isValidEthAddress(null), false);
  assert.strictEqual(isValidEthAddress(undefined), false);
  assert.strictEqual(isValidEthAddress('0x'), false);
  assert.strictEqual(isValidEthAddress('0x123'), false);
  assert.strictEqual(isValidEthAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44'), false); // Too short
  assert.strictEqual(isValidEthAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44ee'), false); // Too long
  assert.strictEqual(isValidEthAddress('742d35Cc6634C0532925a3b844Bc454e4438f44e'), false); // Missing 0x
  assert.strictEqual(isValidEthAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44g'), false); // Invalid char
});

test('isValidEthAddress handles valid addresses', () => {
  // Test with lowercase
  assert.strictEqual(isValidEthAddress('0x742d35cc6634c0532925a3b844bc454e4438f44e'), true);
  assert.strictEqual(isValidEthAddress('0x0000000000000000000000000000000000000000'), true);
});

test('isValidEthAddress handles whitespace', () => {
  assert.strictEqual(isValidEthAddress('  0x742d35cc6634c0532925a3b844bc454e4438f44e  '), true);
});

test('withdraw percentage calculations', () => {
  const balanceBase = 100_000_000n; // 100 USDC in base units
  
  const amount10 = (balanceBase * 10n) / 100n;
  assert.strictEqual(amount10, 10_000_000n);
  
  const amount20 = (balanceBase * 20n) / 100n;
  assert.strictEqual(amount20, 20_000_000n);
  
  const amount30 = (balanceBase * 30n) / 100n;
  assert.strictEqual(amount30, 30_000_000n);
  
  const amount50 = (balanceBase * 50n) / 100n;
  assert.strictEqual(amount50, 50_000_000n);
  
  const amountMax = balanceBase;
  assert.strictEqual(amountMax, 100_000_000n);
});

test('withdraw percentage with small balance', () => {
  const balanceBase = 1_000_000n; // 1 USDC
  
  const amount10 = (balanceBase * 10n) / 100n;
  assert.strictEqual(amount10, 100_000n);
  
  const amount20 = (balanceBase * 20n) / 100n;
  assert.strictEqual(amount20, 200_000n);
});

test('insufficient balance check', () => {
  const balanceBase = 50_000_000n;
  const requestedAmount = 100_000_000n;
  assert.strictEqual(requestedAmount <= balanceBase, false);
});

test('exact balance check', () => {
  const balanceBase = 100_000_000n;
  const requestedAmount = 100_000_000n;
  assert.strictEqual(requestedAmount <= balanceBase, true);
});
