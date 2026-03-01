# Polymarket Trading Bot

Single-user Telegram bot for trading on Polymarket (Polygon), with market/limit orders, split/merge flows, strategy automation, and background monitoring workers.

## Features

- Single-user private access via `TELEGRAM_ALLOWED_USER_ID`
- Markets browser: categories -> events -> tradable submarkets
- Quick open by Polymarket URL (`/event/<event-slug>` or `/event/<event-slug>/<market-slug>`)
- Market orders (FOK) and limit orders (GTC)
- Split/merge via Conditional Tokens Framework contracts
- Withdraw USDC to external wallet
- Strategy flow from market screen: split USDC into YES/NO, place two take-profit SELL limit orders, and track strategy state in SQLite
- Positions, orders, and strategies views in Telegram
- Background workers for position sync, order reconciliation, price alerts, and strategy monitoring
- Strategy market alerts: watcher scans active markets and notifies when YES ask and NO ask are both below strategy max ask
- English/Russian UI, with optional RU AI label translation via OpenRouter
- Sensitive data redaction in logs and patched `console.*`

## Requirements

- Node.js `>=22.22.0`
- npm
- Telegram bot token from BotFather
- Your Telegram user ID

## Installation

1. Clone the repository.
2. Install dependencies.

```bash
npm install
```

3. Create `.env` from template.

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

4. Fill required variables in `.env`.

## Environment Variables

Required:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`

All optional parameters are listed below in a separate advanced section.

## Advanced Configuration (Optional)

RPC and explorer:

- `POLYGON_RPC_URL` (if empty, internal fallback RPC list is used)
- `ETHERSCAN_API_KEY` (used for on-chain positions fallback via explorer history; Etherscan V2 key works for Ethereum and Polygon)
- `POSITIONS_ONCHAIN_START_BLOCK` (start block for ERC-1155 history scan)

Trading and workers:

- `CLOB_MIN_LIMIT_ORDER_SHARES` (default `5`)
- `WORKERS_NOTIFICATIONS_CHAT_ID` (if empty, falls back to `TELEGRAM_ALLOWED_USER_ID`)
- `WORKER_SYNC_POSITIONS_MS` (default `3600000`)
- `WORKER_MONITOR_MS` (default `45000`)
- `WORKER_HEALTH_LOG_MS` (default `600000`)

Notification cooldown used by market/strategy alerts is configured in bot settings (`Settings -> Notifications -> Cooldown`, key `alertCooldownSeconds`, default `300` seconds).

Proxy/network:

- `PROXY` (optional outbound proxy for HTTP(S)/RPC/WebSocket traffic, format `https://login:password@ip:port`)
- `OUTBOUND_HTTP_TIMEOUT_MS` (optional timeout for axios/CLOB HTTP requests, default `20000`)

Strategy market watcher tuning:

- `STRATEGY_MARKETS_WATCHER_WS_URL` (default `wss://ws-subscriptions-clob.polymarket.com/ws/market`)
- `STRATEGY_MARKETS_WATCHER_PAGE_SIZE` (default `200`)
- `STRATEGY_MARKETS_WATCHER_PAGES` (default `3`)
- `STRATEGY_MARKETS_WATCHER_REFRESH_MS` (default `60000`)
- `STRATEGY_MARKETS_WATCHER_MAX_TRACKED_MARKETS` (default `2000`)
- `STRATEGY_MARKETS_WATCHER_SUBSCRIPTION_CHUNK` (default `400`)
- `STRATEGY_MARKETS_WATCHER_WS_RECONNECT_BASE_MS` (default `1000`)
- `STRATEGY_MARKETS_WATCHER_WS_RECONNECT_MAX_MS` (default `30000`)

Logging:

- `LOG_TO_FILE` (`true/false`, default `true`)
- `LOG_FILE_PATH` (default `data/logs/app.log`)

PM2/runtime:

- `PM2_NODE_INTERPRETER` (optional Node interpreter path for PM2, default `node`)

Translation:

- `TRANSLATION_ENABLED` (`true/false`, default `false`)
- `TRANSLATION_SERVICE` (currently expects `openrouter`)
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `OPENROUTER_FALLBACK_MODELS` (comma-separated)
- `OPENROUTER_BASE_URL` (required when `TRANSLATION_ENABLED=true`; for OpenRouter use `https://openrouter.ai/api/v1`)

Polygon approve gas tuning:

- `POLYGON_MIN_PRIORITY_FEE_GWEI` (default `30`)
- `POLYGON_MIN_MAX_FEE_GWEI` (default `60`)
- `POLYGON_APPROVE_GAS_RETRY_COUNT` (default `3`)
- `POLYGON_APPROVE_GAS_BUMP_MULTIPLIER` (default `1.5`)
- `POLYGON_MIN_USDC_ALLOWANCE_USDC` (default `1000`)

## Run

Bootstrap sanity check (auth/config only, does not start Telegram bot or workers):

```bash
npm run bootstrap
# same as:
node src/index.js --bootstrap
```

Run bot (foreground mode):

```bash
npm start
# alias:
npm run start:prod
# same as:
node src/index.js
```

These commands run in the foreground, so the terminal session must stay open.

Dev mode (Node watch):

```bash
npm run dev
```

Production (PM2):

```bash
npm run pm2:start
```

## Tests

Run all tests:

```bash
npm run test
```

Run only unit tests:

```bash
npm run test:unit
```

Useful PM2 commands:

```bash
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
npm run pm2:delete
```

Secure wallet migration scripts:

See [Secure Device Migration (No Bot Import)](#secure-device-migration-no-bot-import) for full commands and options.

## First-Time Setup in Bot

1. Send `/start`.
2. Select language (EN/RU).
3. Open `Settings -> Initialize Wallet`.
4. Fund generated wallet with USDC on Polygon.
5. Open `Settings -> Set Allowances`.
6. Start trading from `Markets`.

Notes:

- Wallet and L2 credentials are encrypted and stored in `data/config.json`.
- Encryption key is derived from machine ID.
- If machine ID is unavailable, startup is aborted for security reasons.

## Secure Device Migration (No Bot Import)

This project supports offline migration of wallet credentials from one machine to another without adding Telegram/private-key import flow.

### 1) On target server (new machine): prepare migration request

```bash
npm run migrate:prepare -- --ttl-minutes 30
```

This creates:

- `data/migration/request-<id>.json` (safe to transfer)
- `data/migration/request-<id>.private.pem` (must stay on target server)

Save the printed public-key fingerprint.

### 2) On source machine (old machine): export encrypted migration bundle

Copy only `request-<id>.json` to source machine, verify the fingerprint out-of-band, then run:

```bash
npm run migrate:export -- --request <path-to-request.json> --fingerprint <printed_fingerprint>
```

This creates `migration-bundle-<id>.json`. Transfer this bundle to target server.

### 3) On target server: apply bundle

```bash
npm run migrate:apply -- --request <path-to-request.json> --bundle <path-to-bundle.json>
```

On success, script:

- re-encrypts credentials under target machine key,
- writes `data/config.json`,
- verifies decrypt round-trip,
- removes one-time private key `request-<id>.private.pem` by default.

Optional flags:

- `--allow-expired` for expired request usage (not recommended)
- `--private-key` to explicitly specify private key path if auto-detection is not suitable
- `--keep-private-key` to keep one-time private key (not recommended)
- `--delete-request` to also remove request JSON after apply

### Security notes for migration

- No background migration daemon is used.
- Fingerprint confirmation is mandatory in export step.
- Keep `request-<id>.private.pem` only on target server.
- If source machine is compromised, migration cannot protect secrets already exposed there.

## Usage Overview

Markets screen:

- Browse categories and events.
- Apply optional Events price filter (YES range presets/custom).
- Open market details.
- Actions available for active tradable markets: Market Buy, Market Sell, Limit Buy, Limit Sell, Start Strategy, Split, Merge

Other menus:

- `Strategy Markets`: browse markets where YES ask and NO ask are both <= configured strategy max ask
- `Positions`: view current positions, open sell/merge/redeem actions from a position
- `Orders`: view and cancel cancellable orders
- `My Strategies`: inspect strategy legs and close a strategy manually
- `Settings`: language, strategy params, notification params, allowances, collateral status, withdraw funds, private key export

Open by URL:

- Send `https://polymarket.com/event/<event-slug>` to open event details
- Send `https://polymarket.com/event/<event-slug>/<market-slug>` to open market details directly
- Locale-prefixed URLs are also supported (example: `https://polymarket.com/ru/event/<event-slug>`)

## Workers

Workers start automatically with the bot (`src/index.js` -> `startWorkers()`):

- `syncPositionsWorker`: periodically replaces local positions snapshot from API
- `monitorPricesWorker`: sends alerts on configured price move threshold and cooldown
- `monitorStrategyMarketsWatcherWorker`: discovers recent active markets and monitors YES/NO asks over CLOB WebSocket
- `monitorOrdersWorker`: reconciles tracked GTC limit orders with CLOB/Data API
- `monitorStrategiesWorker`: manages strategy lifecycle and fallback behavior
- `healthLogWorker`: periodically writes worker runtime health snapshot to logs

## Data and Storage

- `data/config.json`: encrypted credentials + bot settings
- `data/database.sqlite`: SQLite DB for markets cache, positions, orders, strategies, alerts, and optional UI translation cache (`market_translations`)
- `data/logs/app.log`: structured JSON logs from `logger.js` (`LOG_TO_FILE=true`)
- `data/logs/pm2-out.log`, `data/logs/pm2-error.log`: PM2 process logs (when using PM2)

## Security Notes

- Access is restricted to one Telegram user ID.
- Sensitive fields are redacted in logs and console output.
- Private key export message is auto-deleted after 90 seconds.
- Use a dedicated wallet, not your primary wallet.

## Project Structure

```text
src/index.js
src/modules/auth.js
src/modules/bot/bot.js
src/modules/config.js
src/modules/constants.js
src/modules/database.js
src/modules/ai.js
src/modules/i18n.js
src/modules/logger.js
src/modules/polymarket.js
src/modules/strategyMarketWatcher.js
src/modules/workers.js
src/locales/en.json
src/locales/ru.json
ecosystem.config.cjs
data/config.json
```
