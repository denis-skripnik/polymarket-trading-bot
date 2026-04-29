# Polymarket collateral wrap-flow plan

## Goal
Add a minimal production-safe flow for wallets that hold USDC.e but do not have enough pUSD collateral to trade, split, or withdraw.

## Confirmed onchain references
- `CollateralOnramp` (Polygon): `0x93070a847efEf7F70739046A929D47a521F5B8ee`
- `CollateralOnramp.wrap(address _asset, address _to, uint256 _amount)` is the permissionless wrap entrypoint from `Polymarket/ctf-exchange-v2/src/collateral/CollateralOnramp.sol`.
- pUSD collateral token: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- Native USDC accepted by pUSD: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
- USDC.e accepted by pUSD / wrap source asset: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- Neg-risk wrapped collateral (`wcol()` on adapter): `0x3A3BD7bb9528E159577F7C2e685CC81A765002E2`

## Scope
1. Keep the current V2 pUSD trading integration intact.
2. Surface both pUSD and USDC.e balances in bot UX where collateral status matters.
3. Add an onchain wrap action for `USDC.e -> pUSD` via `CollateralOnramp.wrap(...)`.
4. Expose the wrap flow from Settings / Collateral Status with the smallest callback surface.
5. Improve shortage hints so lack of pUSD points users toward the wrap path.
6. Validate with targeted unit tests plus bootstrap sanity check.

## Assumptions
- Existing `USDC_ADDRESS` references in the code remain as the V2 pUSD collateral alias unless a broader refactor is explicitly approved.
- Wrap UX can stay intentionally narrow (`wrap all available USDC.e`) to avoid adding new amount-entry state and extra callback complexity.
- CLOB collateral balance still comes from the V2 client cache, while USDC.e balance / onramp allowance are read directly onchain.

## Impacted areas
- `src/modules/constants.js`
- `src/modules/polymarket.js`
- `src/modules/bot/features/security.js`
- `src/modules/bot/features/settings.js`
- `src/modules/bot/routing/callback-router.js`
- `src/modules/bot/bot.js`
- `src/locales/en.json`
- `src/locales/ru.json`
- `README.md`

## Non-goals
- No live-chain smoke trade with production funds.
- No broad refactor of legacy helper names like `withdrawUSDC` / `USDC_ADDRESS`.
- No manual wrap amount UI, unwrap flow, or bridge/deposit redesign.
- No redesign of unrelated trading UX.
- No database/schema changes.

## Validation strategy
1. Run targeted unit tests for collateral/wrap-related behavior.
2. Run full unit suite if targeted checks pass.
3. Run `npm run bootstrap` to catch runtime/import regressions.
4. If live onchain execution is not possible in this environment, document the limit explicitly.

## Done criteria
- Bot can read pUSD + USDC.e collateral context for the configured wallet.
- Bot can call `CollateralOnramp.wrap(USDCE_ADDRESS, wallet, amount)` after ensuring allowance.
- User can trigger the wrap path from Telegram settings/callbacks.
- Collateral shortage messaging points to the new flow.
- Relevant tests/bootstrap run successfully or blockers are documented with evidence.
