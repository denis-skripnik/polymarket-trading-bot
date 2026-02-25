import { runLoggerTests } from './unit/logger.test.js';
import { runMigrationCommonTests } from './unit/migration-common.test.js';
import { runPolymarketConversionTests } from './unit/polymarket-conversions.test.js';

const suites = [
  ['logger', runLoggerTests],
  ['migration-common', runMigrationCommonTests],
  ['polymarket-conversions', runPolymarketConversionTests]
];

let failures = 0;
let passed = 0;

for (const [suiteName, run] of suites) {
  try {
    const caseNames = run();
    for (const caseName of caseNames) {
      passed += 1;
      console.log(`PASS ${suiteName}: ${caseName}`);
    }
  } catch (error) {
    failures += 1;
    const message = error?.stack || error?.message || String(error);
    console.error(`FAIL ${suiteName}: ${message}`);
  }
}

console.log(`\nResult: ${passed} passed, ${failures} failed`);

if (failures > 0) {
  process.exitCode = 1;
}
