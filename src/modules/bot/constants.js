import { parseUSDCToBase, parseSharesToBase } from '../polymarket.js';

export const RATE_LIMIT_MS = 2000; // 2 seconds between commands
export const MIN_SPLIT_USDC_BASE = parseUSDCToBase('1');
export const MIN_PERCENT_SELL_SHARES_BASE = parseSharesToBase('0.01');
export const MIN_MARKET_SELL_NOTIONAL_USDC_BASE = parseUSDCToBase('1');
export const MIN_LIMIT_SELL_NOTIONAL_USDC_BASE = parseUSDCToBase('5');
export const DEFAULT_MIN_LIMIT_ORDER_SHARES = '5';
export const MIN_LIMIT_ORDER_SHARES_BASE = (() => {
  const raw = process.env.CLOB_MIN_LIMIT_ORDER_SHARES;
  if (raw !== undefined && String(raw).trim() !== '') {
    try {
      return parseSharesToBase(String(raw));
    } catch {}
  }
  return parseSharesToBase(DEFAULT_MIN_LIMIT_ORDER_SHARES);
})();
export const CATEGORY_ALL_KEY = 'all';
export const CATEGORY_CATALOG_TTL_MS = 5 * 60 * 1000;
export const BUTTON_LABEL_MAX_LEN = 50;
export const EVENT_DETAILS_SUBMARKETS_PAGE_SIZE = 8;
export const EVENTS_LIST_PAGE_SIZE = 8;
export const EVENTS_FILTER_LOOKAHEAD_PAGES = 2;
export const EVENTS_FILTER_MAX_SCANNED_EVENTS =
  EVENTS_LIST_PAGE_SIZE * (1 + EVENTS_FILTER_LOOKAHEAD_PAGES);
export const EVENTS_FILTER_CACHE_TTL_MS = 30 * 1000;
export const STRATEGY_MARKETS_CACHE_TTL_MS = 60 * 1000;
export const STRATEGY_MARKETS_PAGE_SIZE = 5;
export const POST_TX_POSITIONS_RETRY_DELAY_MS = 2500;
export const STRATEGY_MARKETS_TARGET_ITEMS = 30;
export const STRATEGY_MARKETS_FETCH_LIMIT = 200;
export const STRATEGY_MARKETS_MAX_FETCHED = 400;
export const STRATEGY_MARKETS_MAX_DEEP_SCAN = 120;
export const STRATEGY_MARKETS_SCAN_STEP = 30;
export const STRATEGY_MARKETS_ORDERBOOK_CONCURRENCY = 20;
