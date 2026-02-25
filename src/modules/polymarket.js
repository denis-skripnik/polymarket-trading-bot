import { ClobClient, Side, OrderType, AssetType, createL2Headers } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { getPolygonRpcUrl } from './config.js';
import { patchProviderSendForProxy } from './proxy.js';
import {
  POLYGON_CHAIN_ID,
  CLOB_API_URL,
  GAMMA_API_URL,
  DATA_API_URL,
  USDC_ADDRESS,
  CTF_ADDRESS,
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_CTF_EXCHANGE,
  NEG_RISK_ADAPTER,
  CTF_ABI,
  ERC20_ABI,
  USDC_DECIMALS,
  PARENT_COLLECTION_ID,
  BINARY_PARTITION
} from './constants.js';
import { safeLogError, safeLogWarn, safeLogInfo, createContext, normalizeNumericInput } from './logger.js';
import { getCachedMarkets } from './database.js';

// ============================================================================
// Part A: CLOB Operations (via SDK)
// ============================================================================

let clobClient = null;
let clobUserAddress = null;
let onchainReadProvider = null;
const onchainPositionsCache = new Map();
const onchainConditionMarketCache = new Map();
const onchainExplorerTxCache = new Map();
const OPEN_ORDERS_INITIAL_CURSOR = 'MA==';
const OPEN_ORDERS_END_CURSOR = 'LTE=';
const OPEN_ORDERS_MAX_FALLBACK_PAGES = 20;
const ONCHAIN_FALLBACK_MIN_SHARES_BASE = 10_000n; // 0.01 shares
const ONCHAIN_FALLBACK_CACHE_TTL_MS = 30_000;
const ONCHAIN_FALLBACK_CONDITION_CACHE_TTL_MS = 5 * 60 * 1000;
const ONCHAIN_FALLBACK_TX_CACHE_TTL_MS = 5 * 60 * 1000;
const ONCHAIN_FALLBACK_DEFAULT_START_BLOCK = 82780788; // 2026-02-10 00:00:00 UTC
const ONCHAIN_FALLBACK_MAX_PAGES = 200;
const ONCHAIN_FALLBACK_PAGE_SIZE = 1000;
const ONCHAIN_FALLBACK_REQUEST_DELAY_MS = 120;
const ONCHAIN_FALLBACK_RATE_LIMIT_DELAY_MS = 900;
const ONCHAIN_FALLBACK_AUX_REQUEST_DELAY_MS = 80;
const ONCHAIN_FALLBACK_MAX_SPLIT_TX_LOOKUPS = 80;
const ONCHAIN_FALLBACK_BALANCE_BATCH_SIZE = 200;
const ETHERSCAN_V2_API_URL = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_CHAIN_ID = '137';

function normalizeApiCreds(apiCreds) {
  if (!apiCreds || typeof apiCreds !== 'object') {
    throw new Error('Invalid L2 API credentials: credentials object is missing');
  }

  // Backward compatibility: older project code stores `apiKey`,
  // while clob-client expects `key`.
  const key = apiCreds.key ?? apiCreds.apiKey;
  const secret = apiCreds.secret;
  const passphrase = apiCreds.passphrase;

  if (!key || !secret || !passphrase) {
    throw new Error('Invalid L2 API credentials: key/secret/passphrase are required');
  }

  return { key, secret, passphrase };
}

// Initialize CLOB client
export async function initClient(privateKey, apiCreds) {
  const signer = new ethers.Wallet(privateKey);
  const normalizedCreds = normalizeApiCreds(apiCreds);
  clobUserAddress = signer.address.toLowerCase();
  
  clobClient = new ClobClient(
    CLOB_API_URL,
    POLYGON_CHAIN_ID,
    signer,
    normalizedCreds,
    0, // signature_type: EOA
    signer.address // funder: same as signer
  );
  
  return clobClient;
}

function toNonEmptyString(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeListResponse(data, listKeys = []) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== 'object') {
    return [];
  }

  for (const key of listKeys) {
    if (Array.isArray(data[key])) {
      return data[key];
    }
  }

  return [];
}

function normalizeTagFilterCandidates(tagValue) {
  if (tagValue === null || tagValue === undefined) {
    return [];
  }

  const candidates = [];
  if (typeof tagValue === 'object') {
    candidates.push(
      tagValue.tagId,
      tagValue.tag_id,
      tagValue.id,
      tagValue.filterValue,
      tagValue.slug,
      tagValue.name,
      tagValue.value,
      tagValue.key
    );
  } else {
    candidates.push(tagValue);
  }

  const normalized = [];
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!text) continue;
    if (!normalized.includes(text)) normalized.push(text);
  }
  return normalized;
}

async function fetchGammaList(pathname, params = {}, listKeys = [], errorLabel = 'request') {
  const url = new URL(`${GAMMA_API_URL}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    const error = new Error(`Failed to ${errorLabel}: ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  return normalizeListResponse(data, listKeys);
}

async function fetchGammaListWithTagFallback({
  pathname,
  baseParams = {},
  tagValue = null,
  listKeys = [],
  errorLabel = 'request',
  listMatchesTag = null
}) {
  const tagCandidates = normalizeTagFilterCandidates(tagValue);
  if (!tagCandidates.length) {
    return fetchGammaList(pathname, baseParams, listKeys, errorLabel);
  }

  let firstSuccessfulEmpty = null;
  let lastError = null;
  const paramNames = ['tag_id', 'tagId', 'tag'];

  for (const candidate of tagCandidates) {
    for (const paramName of paramNames) {
      try {
        const list = await fetchGammaList(
          pathname,
          { ...baseParams, [paramName]: candidate },
          listKeys,
          errorLabel
        );
        const isMatch = typeof listMatchesTag === 'function'
          ? listMatchesTag(list, candidate, paramName)
          : true;

        if (list.length > 0 && isMatch) {
          return list;
        }
        if (list.length === 0 && firstSuccessfulEmpty === null) {
          firstSuccessfulEmpty = list;
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (firstSuccessfulEmpty !== null) {
    return firstSuccessfulEmpty;
  }
  if (lastError) {
    throw lastError;
  }
  return [];
}

function normalizeTagComparable(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function eventHasTagMatch(event, candidate) {
  const expected = normalizeTagComparable(candidate);
  if (!expected) return true;

  const tags = Array.isArray(event?.tags) ? event.tags : [];
  for (const tag of tags) {
    const comparisons = [
      normalizeTagComparable(tag?.id),
      normalizeTagComparable(tag?.slug),
      normalizeTagComparable(tag?.label),
      normalizeTagComparable(tag?.name)
    ];
    if (comparisons.includes(expected)) {
      return true;
    }
  }
  return false;
}

// Get list of markets - does NOT require initialized clobClient (uses Gamma API)
export async function getMarkets(category, page = 1, limit = 8) {
  const offset = (page - 1) * limit;
  return fetchGammaListWithTagFallback({
    pathname: '/markets',
    baseParams: { active: true, closed: false, limit, offset },
    tagValue: category,
    listKeys: ['markets'],
    errorLabel: 'fetch markets'
  });
}

// Get market details by ID - Does NOT require initialized clobClient
export async function getMarketDetailsById(marketId) {
  const url = `${GAMMA_API_URL}/markets/${marketId}`;

  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Failed to fetch market details: ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

// Get market details by slug - Does NOT require initialized clobClient
export async function getMarketDetailsBySlug(slug) {
  const url = `${GAMMA_API_URL}/markets/slug/${encodeURIComponent(slug)}`;

  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Failed to fetch market details: ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

// Get market details by slug or ID - Does NOT require initialized clobClient
// Supports both numeric ID (as string or number) and slug
export async function getMarketDetails(marketRef) {
  const isObjectRef = marketRef && typeof marketRef === 'object';
  const slug = isObjectRef ? marketRef.slug : marketRef;
  const id = isObjectRef ? marketRef.id : marketRef;
  const isNumericRef = typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id));

  // If caller passed an object with slug, prefer slug first.
  if (isObjectRef && slug) {
    try {
      return await getMarketDetailsBySlug(slug);
    } catch (slugError) {
      if (slugError.status !== 404 || !isNumericRef) throw slugError;
      return getMarketDetailsById(id);
    }
  }

  // For primitive numeric refs, try ID first, then slug fallback.
  if (isNumericRef) {
    try {
      return await getMarketDetailsById(id);
    } catch (idError) {
      if (idError.status !== 404) throw idError;
      return getMarketDetailsBySlug(String(slug));
    }
  }

  // For non-numeric primitive refs, treat as slug.
  return getMarketDetailsBySlug(String(slug));
}

// ============================================================================
// Events API (via Gamma API) - Does NOT require initialized clobClient
// ============================================================================

// Get list of available event tags (categories) from Gamma API.
// Tries multiple known endpoints for compatibility across deployments.
export async function getEventTags(limit = 100, offset = 0) {
  const endpoints = ['/tags', '/events/tags', '/event-tags'];
  let firstSuccessfulEmpty = null;
  let lastError = null;

  for (const pathname of endpoints) {
    try {
      const tags = await fetchGammaList(
        pathname,
        { limit, offset },
        ['tags', 'eventTags', 'data'],
        'fetch event tags'
      );
      if (tags.length > 0) {
        return tags;
      }
      if (firstSuccessfulEmpty === null) {
        firstSuccessfulEmpty = tags;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (firstSuccessfulEmpty !== null) {
    return firstSuccessfulEmpty;
  }
  if (lastError) {
    throw lastError;
  }
  return [];
}

// Get list of events - uses Gamma API /events endpoint
// Returns events with their markets array
export async function getEvents(limit = 8, offset = 0, tagId = null, order = 'id', ascending = false) {
  return fetchGammaListWithTagFallback({
    pathname: '/events',
    baseParams: {
      closed: false,
      order,
      ascending,
      limit,
      offset
    },
    tagValue: tagId,
    listKeys: ['events'],
    errorLabel: 'fetch events',
    listMatchesTag: (list, candidate) => list.every((event) => eventHasTagMatch(event, candidate))
  });
}

// Get categories taxonomy from Gamma API.
// Endpoint returns root categories (e.g. Crypto/Politics/Sports) and subcategories.
export async function getCategories() {
  return fetchGammaList('/categories', {}, ['categories', 'data'], 'fetch categories');
}

// Get event by ID - uses Gamma API /events/{id} endpoint
// Returns event with its markets array (submarkets)
export async function getEventById(id) {
  const url = `${GAMMA_API_URL}/events/${id}`;

  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Failed to fetch event: ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

// Get event by slug - uses Gamma API /events/slug endpoint
// Returns event with its markets array (submarkets)
export async function getEventBySlug(slug) {
  const url = `${GAMMA_API_URL}/events/slug/${encodeURIComponent(slug)}`;

  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Failed to fetch event: ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

// Get event by ID or slug - tries ID first if numeric, then slug
export async function getEvent(eventRef) {
  const isObjectRef = eventRef && typeof eventRef === 'object';
  const slug = isObjectRef ? eventRef.slug : eventRef;
  const id = isObjectRef ? eventRef.id : eventRef;
  const isNumericRef = typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id));

  // If caller passed an object with slug, prefer slug first.
  if (isObjectRef && slug) {
    try {
      return await getEventBySlug(slug);
    } catch (slugError) {
      if (slugError.status !== 404 || !isNumericRef) throw slugError;
      return getEventById(id);
    }
  }

  // For primitive numeric refs, try ID first, then slug fallback only on 404.
  if (isNumericRef) {
    try {
      return await getEventById(id);
    } catch (idError) {
      if (idError.status !== 404) throw idError;
      return getEventBySlug(String(slug));
    }
  }

  // For non-numeric primitive refs, treat as slug.
  return getEventBySlug(String(slug));
}

// Filter submarkets from event - returns only tradeable markets
export function filterTradeableSubmarkets(event) {
  if (!event || !event.markets || !Array.isArray(event.markets)) {
    return [];
  }

  return event.markets.filter(market => {
    // Only show markets that are accepting orders and have order book enabled
    if (market.enableOrderBook !== true) return false;
    if (market.acceptingOrders === false) return false;
    return true;
  });
}

// Get orderbook for token - REQUIRES clobClient
export async function getOrderBook(tokenId) {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }
  
  return await clobClient.getOrderBook(tokenId);
}

// Get best bid/ask from orderbook - REQUIRES clobClient
// Returns price strings directly from orderbook (NO float conversion)
export async function getBestBidAsk(tokenId) {
  const orderbook = await getOrderBook(tokenId);

  let bestBidStr = null;
  let bestAskStr = null;

  if (orderbook.bids?.length) {
    bestBidStr = orderbook.bids.reduce((best, x) => {
      if (!best) return x.price;
      return parsePriceToMicro(x.price) > parsePriceToMicro(best) ? x.price : best;
    }, null);
  }

  if (orderbook.asks?.length) {
    bestAskStr = orderbook.asks.reduce((best, x) => {
      if (!best) return x.price;
      return parsePriceToMicro(x.price) < parsePriceToMicro(best) ? x.price : best;
    }, null);
  }

  return { bestBidStr, bestAskStr };
}

// ============================================================================
// CRITICAL: Integer-based money handling - NO FLOATS for money or onchain units
// ============================================================================

const USDC_MICRO = 1_000_000n; // 1e6 for USDC decimals
const PRICE_MICRO = 1_000_000n; // 1e6 for price precision
const SHARES_MICRO = 1_000_000n; // 1e6 for shares decimals

/**
 * Parse USDC string to base units (micro USDC)
 * Example: "12.345678" or "12,345678" -> 12345678n
 * @param {string} amountStr - USDC amount as string (e.g., "12.345678" or "12,345678")
 * @returns {bigint} - Amount in micro USDC (base units)
 */
export function parseUSDCToBase(amountStr) {
  if (typeof amountStr !== 'string') {
    throw new Error('Amount must be a string');
  }
  
  // Normalize input (handles comma/dot, whitespace)
  const normalized = normalizeNumericInput(amountStr);
  
  const parts = normalized.split('.');
  const whole = parts[0] || '0';
  const fraction = (parts[1] || '').padEnd(6, '0').slice(0, 6);
  
  // Combine: whole * 1e6 + fraction
  const wholeBig = BigInt(whole) * USDC_MICRO;
  const fractionBig = BigInt(fraction);
  
  return wholeBig + fractionBig;
}

/**
 * Format USDC base units to display string
 * Example: 12345678n -> "12.345678"
 * @param {bigint} baseAmount - Amount in micro USDC
 * @returns {string} - Formatted string for display
 */
export function formatUSDCFromBase(baseAmount) {
  if (typeof baseAmount !== 'bigint') {
    throw new Error('baseAmount must be bigint');
  }
  
  const whole = baseAmount / USDC_MICRO;
  const fraction = baseAmount % USDC_MICRO;
  
  // Pad fraction to 6 digits
  const fractionStr = fraction.toString().padStart(6, '0');
  
  return `${whole}.${fractionStr}`;
}

/**
 * Parse shares string to base units (micro shares)
 * Example: "61.3" or "61,3" -> 61300000n
 * @param {string} sharesStr - Shares amount as string (e.g., "61.3" or "61,3")
 * @returns {bigint} - Amount in micro shares (base units)
 */
export function parseSharesToBase(sharesStr) {
  if (typeof sharesStr !== 'string') {
    throw new Error('Shares must be a string');
  }
  
  // Normalize input (handles comma/dot, whitespace)
  const normalized = normalizeNumericInput(sharesStr);
  
  const parts = normalized.split('.');
  const whole = parts[0] || '0';
  const fraction = (parts[1] || '').padEnd(6, '0').slice(0, 6);
  
  const wholeBig = BigInt(whole) * SHARES_MICRO;
  const fractionBig = BigInt(fraction);
  
  return wholeBig + fractionBig;
}

/**
 * Format shares base units to display string
 * Example: 61300000n -> "61.300000"
 * @param {bigint} baseAmount - Amount in micro shares
 * @returns {string} - Formatted string for display
 */
export function formatSharesFromBase(baseAmount) {
  if (typeof baseAmount !== 'bigint') {
    throw new Error('baseAmount must be bigint');
  }
  
  const whole = baseAmount / SHARES_MICRO;
  const fraction = baseAmount % SHARES_MICRO;
  
  const fractionStr = fraction.toString().padStart(6, '0');
  
  return `${whole}.${fractionStr}`;
}

/**
 * Parse price string to micro units
 * Example: "0.1234" -> 123400n
 * @param {string} priceStr - Price as string (e.g., "0.1234")
 * @returns {bigint} - Price in micro units
 */
export function parsePriceToMicro(priceStr) {
  if (typeof priceStr !== 'string') {
    throw new Error('Price must be a string');
  }
  
  priceStr = priceStr.trim();
  
  if (!/^0?\.\d+$|^\d+\.?\d*$/.test(priceStr)) {
    throw new Error('Invalid price format');
  }
  
  const parts = priceStr.split('.');
  const whole = parts[0] || '0';
  const fraction = (parts[1] || '').padEnd(6, '0').slice(0, 6);
  
  const wholeBig = BigInt(whole) * PRICE_MICRO;
  const fractionBig = BigInt(fraction);
  
  return wholeBig + fractionBig;
}

/**
 * Format price micro units to display string
 * Example: 123400n -> "0.123400"
 * @param {bigint} priceMicro - Price in micro units
 * @returns {string} - Formatted price string
 */
export function formatPriceFromMicro(priceMicro) {
  if (typeof priceMicro !== 'bigint') {
    throw new Error('priceMicro must be bigint');
  }
  
  const whole = priceMicro / PRICE_MICRO;
  const fraction = priceMicro % PRICE_MICRO;
  
  const fractionStr = fraction.toString().padStart(6, '0');
  
  return `${whole}.${fractionStr}`;
}

/**
 * Compute shares from USDC amount and price
 * shares = floor(amountUSDCBase / (priceMicro / 1e6))
 *        = floor(amountUSDCBase * 1e6 / priceMicro)
 * @param {bigint} amountUSDCBase - USDC amount in base units (micro)
 * @param {bigint} priceMicro - Price in micro units
 * @returns {bigint} - Shares in base units
 */
export function computeSharesFromUSDC(amountUSDCBase, priceMicro) {
  if (typeof amountUSDCBase !== 'bigint' || typeof priceMicro !== 'bigint') {
    throw new Error('Both arguments must be bigint');
  }
  
  if (priceMicro <= 0n) {
    throw new Error('Price must be positive');
  }
  
  // shares = floor(amountUSDCBase * 1e6 / priceMicro)
  return (amountUSDCBase * USDC_MICRO) / priceMicro;
}

/**
 * Compute USDC value from shares and price
 * usdc = floor(sharesBase * priceMicro / 1e6)
 * @param {bigint} sharesBase - Shares in base units
 * @param {bigint} priceMicro - Price in micro units
 * @returns {bigint} - USDC amount in base units
 */
export function computeUSDCFromShares(sharesBase, priceMicro) {
  if (typeof sharesBase !== 'bigint' || typeof priceMicro !== 'bigint') {
    throw new Error('Both arguments must be bigint');
  }
  
  return (sharesBase * priceMicro) / USDC_MICRO;
}

// Calculate marketable price with safety buffer using integer math
// Returns price in micro units, clamped to [0.01, 0.99]
// For BUY: use bestAsk + buffer (up to 0.99)
// For SELL: use bestBid - buffer (down to 0.01)
const MIN_PRICE_MICRO = 10_000n; // 0.01 * 1e6
const MAX_PRICE_MICRO = 990_000n; // 0.99 * 1e6
const BUFFER_MICRO = 20_000n; // 0.02 * 1e6
const RETRY_PRICE_ADVERSE_LIMIT_BPS = 100n; // 1%
const RETRY_PRICE_ABSOLUTE_LIMIT_BPS = 500n; // 5%

export function calculateMarketablePriceMicro(referencePriceMicro, side) {
  if (typeof referencePriceMicro !== 'bigint') {
    throw new Error('referencePriceMicro must be bigint');
  }
  
  let priceMicro;
  
  if (side === 'BUY') {
    // BUY: add buffer, cap at 0.99
    priceMicro = referencePriceMicro + BUFFER_MICRO;
    if (priceMicro > MAX_PRICE_MICRO) {
      priceMicro = MAX_PRICE_MICRO;
    }
  } else { // SELL
    // SELL: subtract buffer, floor at 0.01
    priceMicro = referencePriceMicro - BUFFER_MICRO;
    if (priceMicro < MIN_PRICE_MICRO) {
      priceMicro = MIN_PRICE_MICRO;
    }
  }
  
  return priceMicro;
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

function getPriceMoveBps(referencePriceMicro, nextPriceMicro) {
  if (referencePriceMicro <= 0n) return 0n;
  return (absBigInt(nextPriceMicro - referencePriceMicro) * 10_000n) / referencePriceMicro;
}

function formatBpsPercent(moveBps) {
  return (Number(moveBps) / 100).toFixed(2);
}

function enforceRetryPriceMovementLimits(side, initialPriceMicro, nextPriceMicro) {
  const moveBps = getPriceMoveBps(initialPriceMicro, nextPriceMicro);
  if (moveBps > RETRY_PRICE_ABSOLUTE_LIMIT_BPS) {
    throw new Error(
      `Price changed by ${formatBpsPercent(moveBps)}% since first attempt. ` +
      `Retry cancelled because movement exceeds 5.00%.`
    );
  }

  const adverseMove = (side === 'BUY' && nextPriceMicro > initialPriceMicro) ||
    (side === 'SELL' && nextPriceMicro < initialPriceMicro);

  if (adverseMove && moveBps > RETRY_PRICE_ADVERSE_LIMIT_BPS) {
    throw new Error(
      `Price moved ${formatBpsPercent(moveBps)}% in adverse direction since first attempt. ` +
      `Retry cancelled because movement exceeds 1.00%.`
    );
  }

  return moveBps;
}

function extractErrorMessage(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        const parsed = JSON.parse(trimmed);
        const parsedMessage = extractErrorMessage(parsed, depth + 1);
        if (parsedMessage) return parsedMessage;
      }
    } catch {
      // Keep original string when JSON parsing fails.
    }
    return trimmed;
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  const candidates = [
    value.response?.data?.error,
    value.response?.data?.errorMsg,
    value.response?.data?.message,
    value.data?.error,
    value.data?.errorMsg,
    value.data?.message,
    value.error,
    value.errorMsg,
    value.reason,
    value.details,
    value.message,
    value.response?.statusText,
    value.statusText
  ];

  for (const candidate of candidates) {
    const message = extractErrorMessage(candidate, depth + 1);
    if (message) return message;
  }

  const fallback = value?.toString?.();
  if (fallback && fallback !== '[object Object]') {
    return String(fallback);
  }

  return null;
}

function normalizeErrorMessageForUser(value, fallback = 'Unknown error') {
  const extracted = extractErrorMessage(value) || fallback;
  const normalized = extracted.replace(/\s+/g, ' ').trim();
  return normalized.substring(0, 220);
}

function resolveOrderPlacementResult(rawResult) {
  const orderId = toNonEmptyString(rawResult?.orderID ?? rawResult?.id ?? rawResult?.orderId);
  const explicitFailure = rawResult?.success === false;

  // Treat placement as successful only when backend returned a concrete order id.
  const success = !explicitFailure && Boolean(orderId);

  const error = success
    ? null
    : normalizeErrorMessageForUser(rawResult, 'Order placement failed');

  return {
    success,
    orderId,
    error
  };
}

// Map common API errors to user-friendly messages
export function mapErrorToUserMessage(error) {
  const message = normalizeErrorMessageForUser(error);
  const lower = message.toLowerCase();

  if (lower.includes('auto_allowance_setup_failed')) {
    return {
      key: 'error_order_failed',
      params: { message: 'Auto allowance setup failed (RPC/gas issue). Retry in a minute or run Settings -> Set allowances.' }
    };
  }

  if (
    lower.includes('gas price below minimum') ||
    lower.includes('fee too low') ||
    lower.includes('underpriced') ||
    lower.includes('replacement fee too low') ||
    lower.includes('max fee per gas less than block base fee')
  ) {
    return {
      key: 'error_order_failed',
      params: { message: 'Network gas fee is too low for current RPC. Retry in a minute.' }
    };
  }

  if (lower.includes('insufficient collateral readiness')) {
    return {
      key: 'error_order_failed',
      params: { message: 'Not enough USDC balance or allowance for this order. Run Settings -> Set allowances and check wallet USDC balance.' }
    };
  }
  
  // Allowance issues (check before generic "balance" match)
  if (lower.includes('allowance')) {
    return {
      key: 'error_order_failed',
      params: { message: 'Insufficient allowance. Run Settings -> Set allowances and retry.' }
    };
  }
  
  // Insufficient balance
  if (lower.includes('insufficient') || lower.includes('balance')) {
    return { key: 'error_insufficient_funds', params: {} };
  }
  
  // Rate limiting
  if (lower.includes('rate') || lower.includes('429') || lower.includes('too many')) {
    return { key: 'error_rate_limit', params: {} };
  }

  // CLOB minimum order amount / marketability validation
  if (lower.includes('min size') || lower.includes('invalid amount for a marketable')) {
    return { key: 'error_order_failed', params: { message } };
  }

  if (lower.includes('lower than the minimum')) {
    const minMatch = message.match(/minimum:\s*([0-9]+(?:\.[0-9]+)?)/i);
    const minLabel = minMatch ? `${minMatch[1]} shares` : 'required minimum';
    return {
      key: 'error_order_failed',
      params: { message: `Order size is below minimum (${minLabel}). Increase amount.` }
    };
  }
  
  // Invalid parameters
  if (lower.includes('invalid') || lower.includes('parameter') || lower.includes('bad request')) {
    return { key: 'error_order_failed', params: { message } };
  }
  
  // Order too small
  if (lower.includes('too small') || lower.includes('minimum')) {
    return { key: 'error_order_failed', params: { message: 'Order size too small' } };
  }
  
  // Slippage / price moved
  if (lower.includes('slippage') || lower.includes('price moved') || lower.includes('fok')) {
    return { key: 'error_order_failed', params: { message: 'Price moved, try again with updated price' } };
  }
  
  return { key: 'error_order_failed', params: { message } };
}

function normalizePositionFromApi(pos) {
  const tokenId = toNonEmptyString(pos?.token_id ?? pos?.asset_id ?? pos?.asset ?? pos?.tokenId);
  const size = toNonEmptyString(pos?.size ?? pos?.quantity ?? pos?.amount) || '0';
  const market = toNonEmptyString(pos?.market ?? pos?.title ?? pos?.question ?? pos?.slug ?? pos?.condition_id);
  const outcome = toNonEmptyString(pos?.outcome ?? pos?.side ?? pos?.position);
  const avgPrice = toNonEmptyString(pos?.avgPrice ?? pos?.avg_price ?? pos?.averagePrice);
  const currentValue = toNonEmptyString(pos?.currentValue ?? pos?.current_value ?? pos?.cashPnl);

  return {
    ...pos,
    token_id: tokenId,
    size,
    market,
    outcome,
    avgPrice,
    currentValue,
    sellable: pos?.sellable !== false
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function invalidateOnchainPositionCaches(address = null, options = {}) {
  const normalized = String(address || '').trim().toLowerCase();
  if (normalized) {
    onchainPositionsCache.delete(normalized);
  } else {
    onchainPositionsCache.clear();
  }

  if (options?.clearAux === true) {
    onchainConditionMarketCache.clear();
    onchainExplorerTxCache.clear();
  }
}

function getExplorerApiKey() {
  return String(process.env.ETHERSCAN_API_KEY || '').trim();
}

function getOnchainFallbackStartBlock() {
  const raw = String(process.env.POSITIONS_ONCHAIN_START_BLOCK || '').trim();
  if (/^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return ONCHAIN_FALLBACK_DEFAULT_START_BLOCK;
}

function isNoTransactionsResult(status, message, result) {
  const statusText = String(status ?? '').trim();
  const messageText = String(message ?? '').toLowerCase();
  const resultText = String(result ?? '').toLowerCase();
  if (statusText === '0') {
    return messageText.includes('no transactions found') || resultText.includes('no transactions found');
  }
  return false;
}

function isRateLimitedResult(result) {
  return String(result ?? '').toLowerCase().includes('max rate limit');
}

function parseArrayLike(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeConditionId(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

function normalizeOutcomeFromIndexSet(indexSetValue) {
  const normalized = String(indexSetValue ?? '').trim();
  if (!normalized) return 'UNKNOWN';
  if (normalized === String(BINARY_PARTITION[0])) return 'YES';
  if (normalized === String(BINARY_PARTITION[1])) return 'NO';
  return `INDEX_${normalized}`;
}

function parsePriceMicroOrNull(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  try {
    const micro = parsePriceToMicro(raw);
    if (micro <= 0n || micro > PRICE_MICRO) return null;
    return micro;
  } catch {
    return null;
  }
}

function buildTokenMetaFromCachedMarkets(cachedMarkets) {
  const tokenMeta = new Map();
  const markets = Array.isArray(cachedMarkets) ? cachedMarkets : [];

  for (const market of markets) {
    const marketId = toNonEmptyString(market?.id);
    const conditionId = normalizeConditionId(market?.condition_id);
    const yes = toNonEmptyString(market?.token_id_yes);
    const no = toNonEmptyString(market?.token_id_no);
    if (!marketId || !conditionId || !yes || !no) continue;

    tokenMeta.set(yes, {
      marketId,
      marketSlug: null,
      marketLabel: marketId,
      conditionId,
      marketPrice: null,
      outcome: 'YES',
      oppositeAsset: no
    });
    tokenMeta.set(no, {
      marketId,
      marketSlug: null,
      marketLabel: marketId,
      conditionId,
      marketPrice: null,
      outcome: 'NO',
      oppositeAsset: yes
    });
  }

  return tokenMeta;
}

async function fetchGammaMarketByConditionId(conditionIdRaw) {
  const conditionId = normalizeConditionId(conditionIdRaw);
  if (!conditionId) return null;

  const cached = onchainConditionMarketCache.get(conditionId);
  if (cached && Date.now() - cached.timestamp < ONCHAIN_FALLBACK_CONDITION_CACHE_TTL_MS) {
    return cached.value;
  }

  let value = null;
  try {
    const markets = await fetchGammaList(
      '/markets',
      { condition_ids: conditionId, limit: 1, offset: 0 },
      ['markets'],
      'fetch market by condition id'
    );

    const matched = (Array.isArray(markets) ? markets : []).find(
      (entry) => normalizeConditionId(entry?.conditionId) === conditionId
    ) || (Array.isArray(markets) && markets.length > 0 ? markets[0] : null);

    if (matched) {
      const marketId = toNonEmptyString(matched?.id);
      const marketSlug = toNonEmptyString(matched?.slug);
      const marketLabel = toNonEmptyString(
        matched?.question ??
        matched?.title ??
        matched?.slug ??
        matched?.id ??
        conditionId
      );

      const tokenOutcomes = new Map();
      const tokenPrices = new Map();
      const clobTokenIds = parseArrayLike(matched?.clobTokenIds)
        .map((item) => String(item ?? '').trim())
        .filter(Boolean);
      const outcomes = parseArrayLike(matched?.outcomes)
        .map((item) => String(item ?? '').trim());
      const outcomePrices = parseArrayLike(matched?.outcomePrices)
        .map((item) => String(item ?? '').trim());
      for (let i = 0; i < clobTokenIds.length; i += 1) {
        const tokenId = clobTokenIds[i];
        const outcome = outcomes[i];
        const outcomePrice = outcomePrices[i];
        if (!tokenId) continue;
        if (!outcome) continue;
        tokenOutcomes.set(tokenId, String(outcome).trim().toUpperCase());
        if (outcomePrice) tokenPrices.set(tokenId, outcomePrice);
      }

      if (Array.isArray(matched?.tokens)) {
        for (const tokenEntry of matched.tokens) {
          const tokenId = toNonEmptyString(tokenEntry?.token_id ?? tokenEntry?.tokenId);
          const outcome = toNonEmptyString(tokenEntry?.outcome ?? tokenEntry?.side);
          if (!tokenId || !outcome) continue;
          tokenOutcomes.set(tokenId, String(outcome).trim().toUpperCase());
        }
      }

      let yesTokenId = null;
      let noTokenId = null;
      for (const [tokenId, outcome] of tokenOutcomes.entries()) {
        if (outcome === 'YES' && !yesTokenId) yesTokenId = tokenId;
        if (outcome === 'NO' && !noTokenId) noTokenId = tokenId;
      }

      value = {
        marketId,
        marketSlug,
        marketLabel: marketLabel || marketSlug || marketId || conditionId,
        conditionId,
        isNegRisk: Boolean(matched?.negRisk),
        tokenOutcomes,
        tokenPrices,
        yesTokenId,
        noTokenId
      };
    }
  } catch (error) {
    const ctx = createContext('polymarket', 'fetchGammaMarketByConditionId');
    safeLogWarn(ctx, 'Failed to resolve market by condition id', {
      conditionId,
      message: error?.message
    });
  }

  onchainConditionMarketCache.set(conditionId, {
    timestamp: Date.now(),
    value
  });
  return value;
}

function normalizeExplorerProxyTx(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload?.result && typeof payload.result === 'object') return payload.result;
  return null;
}

function isExplorerPayloadRateLimited(payload) {
  const message = String(
    payload?.result ??
    payload?.message ??
    payload?.error?.message ??
    ''
  ).toLowerCase();
  return message.includes('max rate limit') || message.includes('rate limit');
}

async function fetchExplorerTransactionByHash(txHash) {
  const hash = String(txHash ?? '').trim().toLowerCase();
  if (!hash) return null;

  const cached = onchainExplorerTxCache.get(hash);
  if (cached && Date.now() - cached.timestamp < ONCHAIN_FALLBACK_TX_CACHE_TTL_MS) {
    return cached.value;
  }

  const apiKey = getExplorerApiKey();
  if (!apiKey) return null;

  const query = new URLSearchParams({
    chainid: ETHERSCAN_CHAIN_ID,
    module: 'proxy',
    action: 'eth_getTransactionByHash',
    txhash: hash,
    apikey: apiKey
  });
  const url = `${ETHERSCAN_V2_API_URL}?${query.toString()}`;

  let result = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url);
    if (!response.ok) {
      if (attempt >= 3) break;
      await sleep(ONCHAIN_FALLBACK_RATE_LIMIT_DELAY_MS);
      continue;
    }

    const payload = await response.json();
    if (isExplorerPayloadRateLimited(payload)) {
      if (attempt >= 3) break;
      await sleep(ONCHAIN_FALLBACK_RATE_LIMIT_DELAY_MS);
      continue;
    }

    result = normalizeExplorerProxyTx(payload);
    break;
  }

  onchainExplorerTxCache.set(hash, {
    timestamp: Date.now(),
    value: result
  });
  return result;
}

async function buildSplitDerivedTokenMeta(ownerAddress, transfers, unresolvedTokenIds) {
  const owner = String(ownerAddress ?? '').trim().toLowerCase();
  const unresolved = new Set((Array.isArray(unresolvedTokenIds) ? unresolvedTokenIds : []).filter(Boolean));
  const rows = Array.isArray(transfers) ? transfers : [];
  const tokenMeta = new Map();

  if (!owner || unresolved.size === 0 || rows.length === 0) {
    return tokenMeta;
  }

  const zeroAddress = '0x0000000000000000000000000000000000000000';
  const splitRowsByHash = new Map();

  for (const entry of rows) {
    const tokenId = toNonEmptyString(entry?.tokenID ?? entry?.tokenId ?? entry?.tokenid);
    if (!tokenId || !unresolved.has(tokenId)) continue;

    const from = String(entry?.from ?? '').toLowerCase();
    const to = String(entry?.to ?? '').toLowerCase();
    if (from !== zeroAddress || to !== owner) continue;

    const methodId = String(entry?.methodId ?? '').toLowerCase();
    const functionName = String(entry?.functionName ?? '').toLowerCase();
    if (methodId !== '0x72ce4275' && !functionName.includes('splitposition')) continue;

    const hash = String(entry?.hash ?? '').trim().toLowerCase();
    if (!hash) continue;
    if (!splitRowsByHash.has(hash)) {
      splitRowsByHash.set(hash, []);
    }
    splitRowsByHash.get(hash).push(entry);
  }

  const splitHashes = Array.from(splitRowsByHash.keys()).slice(-ONCHAIN_FALLBACK_MAX_SPLIT_TX_LOOKUPS);
  if (splitHashes.length === 0) return tokenMeta;

  const ctfInterface = new ethers.utils.Interface(CTF_ABI);
  const conditionIds = new Set();

  for (const hash of splitHashes) {
    const tx = await fetchExplorerTransactionByHash(hash);
    if (!tx) continue;

    const to = String(tx?.to ?? '').toLowerCase();
    if (to !== CTF_ADDRESS.toLowerCase()) continue;

    const input = String(tx?.input ?? '').trim();
    if (!input || input === '0x') continue;

    let parsed = null;
    try {
      parsed = ctfInterface.parseTransaction({ data: input, value: tx?.value || '0x0' });
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.name !== 'splitPosition') continue;

    const conditionId = normalizeConditionId(parsed?.args?.conditionId ?? parsed?.args?.[2]);
    if (!conditionId) continue;
    conditionIds.add(conditionId);

    const partition = Array.isArray(parsed?.args?.partition)
      ? parsed.args.partition
      : (Array.isArray(parsed?.args?.[3]) ? parsed.args[3] : []);
    const mintedRows = splitRowsByHash.get(hash) || [];
    const mappedCount = Math.min(partition.length, mintedRows.length);
    if (mappedCount === 0) continue;

    for (let i = 0; i < mappedCount; i += 1) {
      const tokenId = toNonEmptyString(
        mintedRows[i]?.tokenID ?? mintedRows[i]?.tokenId ?? mintedRows[i]?.tokenid
      );
      if (!tokenId || !unresolved.has(tokenId)) continue;

      const indexSet = partition[i]?.toString?.() ?? partition[i];
      const outcome = normalizeOutcomeFromIndexSet(indexSet);

      const existing = tokenMeta.get(tokenId) || {};
      tokenMeta.set(tokenId, {
        ...existing,
        conditionId,
        outcome: existing.outcome && existing.outcome !== 'UNKNOWN' ? existing.outcome : outcome
      });
    }

    await sleep(ONCHAIN_FALLBACK_AUX_REQUEST_DELAY_MS);
  }

  const conditionMarkets = new Map();
  for (const conditionId of conditionIds) {
    const market = await fetchGammaMarketByConditionId(conditionId);
    if (market) conditionMarkets.set(conditionId, market);
    await sleep(ONCHAIN_FALLBACK_AUX_REQUEST_DELAY_MS);
  }

  for (const [tokenId, meta] of tokenMeta.entries()) {
    const market = conditionMarkets.get(meta.conditionId);
    if (!market) continue;

    const outcomeFromMarket = market.tokenOutcomes?.get(tokenId);
    const marketPrice = market.tokenPrices?.get(tokenId) || null;
    const normalizedOutcome = outcomeFromMarket
      ? String(outcomeFromMarket).trim().toUpperCase()
      : meta.outcome;

    let oppositeAsset = meta.oppositeAsset || null;
    if (normalizedOutcome === 'YES' && market.noTokenId) oppositeAsset = market.noTokenId;
    if (normalizedOutcome === 'NO' && market.yesTokenId) oppositeAsset = market.yesTokenId;

    tokenMeta.set(tokenId, {
      ...meta,
      marketId: market.marketId,
      marketSlug: market.marketSlug,
      marketLabel: market.marketLabel,
      marketPrice,
      outcome: normalizedOutcome || meta.outcome || 'UNKNOWN',
      oppositeAsset
    });
  }

  const pairsByCondition = new Map();
  for (const [tokenId, meta] of tokenMeta.entries()) {
    const conditionId = normalizeConditionId(meta?.conditionId);
    const outcome = String(meta?.outcome ?? '').toUpperCase();
    if (!conditionId || (outcome !== 'YES' && outcome !== 'NO')) continue;
    if (!pairsByCondition.has(conditionId)) {
      pairsByCondition.set(conditionId, { yes: null, no: null });
    }
    if (outcome === 'YES') pairsByCondition.get(conditionId).yes = tokenId;
    if (outcome === 'NO') pairsByCondition.get(conditionId).no = tokenId;
  }

  for (const [tokenId, meta] of tokenMeta.entries()) {
    if (meta?.oppositeAsset) continue;
    const conditionId = normalizeConditionId(meta?.conditionId);
    const outcome = String(meta?.outcome ?? '').toUpperCase();
    const pair = pairsByCondition.get(conditionId);
    if (!pair) continue;
    if (outcome === 'YES' && pair.no) meta.oppositeAsset = pair.no;
    if (outcome === 'NO' && pair.yes) meta.oppositeAsset = pair.yes;
    tokenMeta.set(tokenId, meta);
  }

  return tokenMeta;
}

async function fetchOnchainTransfersFromExplorer(address) {
  const apiKey = getExplorerApiKey();
  if (!apiKey) {
    const ctx = createContext('polymarket', 'fetchOnchainTransfersFromExplorer');
    safeLogWarn(ctx, 'Explorer API key is missing, skipping on-chain positions fallback');
    return [];
  }

  const owner = String(address || '').trim().toLowerCase();
  if (!owner) return [];

  const startBlock = getOnchainFallbackStartBlock();
  const rows = [];
  let page = 1;
  let requests = 0;

  while (page <= ONCHAIN_FALLBACK_MAX_PAGES) {
    const query = new URLSearchParams({
      chainid: ETHERSCAN_CHAIN_ID,
      module: 'account',
      action: 'token1155tx',
      address: owner,
      contractaddress: CTF_ADDRESS,
      startblock: String(startBlock),
      endblock: '99999999',
      page: String(page),
      offset: String(ONCHAIN_FALLBACK_PAGE_SIZE),
      sort: 'asc',
      apikey: apiKey
    });

    const url = `${ETHERSCAN_V2_API_URL}?${query.toString()}`;

    let payload = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(url);
      requests += 1;
      if (!response.ok) {
        if (attempt >= 3) {
          throw new Error(`Explorer request failed: ${response.status} ${response.statusText}`);
        }
        await sleep(ONCHAIN_FALLBACK_RATE_LIMIT_DELAY_MS);
        continue;
      }

      payload = await response.json();
      if (isRateLimitedResult(payload?.result)) {
        if (attempt >= 3) {
          throw new Error('Explorer API rate limit exceeded');
        }
        await sleep(ONCHAIN_FALLBACK_RATE_LIMIT_DELAY_MS);
        continue;
      }
      break;
    }

    const status = payload?.status;
    const message = payload?.message;
    const result = payload?.result;

    if (isNoTransactionsResult(status, message, result)) {
      break;
    }

    if (!Array.isArray(result)) {
      throw new Error(`Explorer response format error: status=${String(status)} message=${String(message)}`);
    }

    rows.push(...result);

    if (result.length < ONCHAIN_FALLBACK_PAGE_SIZE) {
      break;
    }

    page += 1;
    await sleep(ONCHAIN_FALLBACK_REQUEST_DELAY_MS);
  }

  const ctx = createContext('polymarket', 'fetchOnchainTransfersFromExplorer');
  safeLogInfo(ctx, 'Fetched ERC1155 transfer history for on-chain positions fallback', {
    walletAddress: owner,
    requests,
    pages: page,
    transfers: rows.length
  });

  return rows;
}

function buildTokenBalancesFromTransfers(transfers, ownerAddress) {
  const owner = String(ownerAddress || '').trim().toLowerCase();
  const balances = new Map();
  const dedup = new Set();

  for (const entry of Array.isArray(transfers) ? transfers : []) {
    const tokenId = String(entry?.tokenID ?? entry?.tokenId ?? entry?.tokenid ?? '').trim();
    if (!tokenId) continue;

    const valueRaw = String(entry?.tokenValue ?? entry?.value ?? '').trim();
    if (!/^\d+$/.test(valueRaw)) continue;

    const from = String(entry?.from ?? '').toLowerCase();
    const to = String(entry?.to ?? '').toLowerCase();
    const dedupKey = [
      String(entry?.hash ?? ''),
      String(entry?.logIndex ?? entry?.logindex ?? ''),
      tokenId,
      from,
      to,
      valueRaw
    ].join(':');
    if (dedup.has(dedupKey)) continue;
    dedup.add(dedupKey);

    const value = BigInt(valueRaw);
    const current = balances.get(tokenId) || 0n;
    let next = current;

    if (to === owner) next += value;
    if (from === owner) next -= value;
    balances.set(tokenId, next);
  }

  return balances;
}

function collectTouchedTokenIdsFromTransfers(transfers, ownerAddress) {
  const owner = String(ownerAddress || '').trim().toLowerCase();
  const tokenIds = [];
  const seen = new Set();

  for (const entry of Array.isArray(transfers) ? transfers : []) {
    const tokenId = String(entry?.tokenID ?? entry?.tokenId ?? entry?.tokenid ?? '').trim();
    if (!tokenId || !/^\d+$/.test(tokenId)) continue;

    const from = String(entry?.from ?? '').toLowerCase();
    const to = String(entry?.to ?? '').toLowerCase();
    if (from !== owner && to !== owner) continue;

    if (seen.has(tokenId)) continue;
    seen.add(tokenId);
    tokenIds.push(tokenId);
  }

  return tokenIds;
}

function chunkArray(values, size) {
  const list = Array.isArray(values) ? values : [];
  const chunkSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : 1;
  const chunks = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}

async function getOnchainReadProvider() {
  if (provider) return provider;
  if (onchainReadProvider) return onchainReadProvider;
  onchainReadProvider = await createWorkingProvider(getPolygonRpcUrl());
  return onchainReadProvider;
}

async function fetchTokenBalancesFromChain(ownerAddress, tokenIds) {
  const owner = String(ownerAddress || '').trim().toLowerCase();
  if (!owner || !Array.isArray(tokenIds) || tokenIds.length === 0) {
    return new Map();
  }

  const readProvider = await getOnchainReadProvider();
  const readContract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, readProvider);
  const balances = new Map();

  const chunks = chunkArray(
    tokenIds
      .map((id) => String(id || '').trim())
      .filter((id) => /^\d+$/.test(id)),
    ONCHAIN_FALLBACK_BALANCE_BATCH_SIZE
  );

  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const owners = new Array(chunk.length).fill(owner);
    const result = await readContract.balanceOfBatch(owners, chunk);
    for (let i = 0; i < chunk.length; i += 1) {
      const rawValue = result?.[i];
      const parsed = safeToBigInt(rawValue);
      if (parsed !== null) {
        balances.set(chunk[i], parsed);
      }
    }
  }

  return balances;
}

function buildOnchainPositionsFromBalances(tokenBalances, tokenMetaMap) {
  const tokenMeta = tokenMetaMap instanceof Map ? tokenMetaMap : new Map();
  const tokenPairByCondition = new Map();

  for (const [tokenId, balanceBase] of tokenBalances.entries()) {
    if (balanceBase < ONCHAIN_FALLBACK_MIN_SHARES_BASE) continue;
    const meta = tokenMeta.get(tokenId);
    const conditionId = normalizeConditionId(meta?.conditionId);
    const outcome = String(meta?.outcome ?? '').toUpperCase();
    if (!conditionId || (outcome !== 'YES' && outcome !== 'NO')) continue;
    if (!tokenPairByCondition.has(conditionId)) {
      tokenPairByCondition.set(conditionId, { YES: null, NO: null });
    }
    tokenPairByCondition.get(conditionId)[outcome] = tokenId;
  }

  const rows = [];
  for (const [tokenId, balanceBase] of tokenBalances.entries()) {
    if (balanceBase < ONCHAIN_FALLBACK_MIN_SHARES_BASE) continue;

    const meta = tokenMeta.get(tokenId) || null;
    const oppositeTokenId = meta?.oppositeAsset || null;
    const oppositeBalance = oppositeTokenId ? (tokenBalances.get(oppositeTokenId) || 0n) : 0n;
    const conditionId = normalizeConditionId(meta?.conditionId);
    const outcome = String(meta?.outcome ?? '').toUpperCase();
    const pairByCondition = conditionId ? tokenPairByCondition.get(conditionId) : null;
    const pairedTokenId = pairByCondition
      ? (outcome === 'YES' ? pairByCondition.NO : (outcome === 'NO' ? pairByCondition.YES : null))
      : null;
    const pairedOppositeBalance = pairedTokenId ? (tokenBalances.get(pairedTokenId) || 0n) : 0n;
    const marketPriceMicro = parsePriceMicroOrNull(meta?.marketPrice);
    let avgPrice = null;
    let currentValue = null;

    if (marketPriceMicro !== null) {
      avgPrice = formatPriceFromMicro(marketPriceMicro);
      currentValue = formatUSDCFromBase(computeUSDCFromShares(balanceBase, marketPriceMicro));
    } else if (pairedOppositeBalance >= ONCHAIN_FALLBACK_MIN_SHARES_BASE) {
      // No direct market quote for this token id: use split-pair merge-equivalent estimate.
      const mergeableBase = balanceBase < pairedOppositeBalance ? balanceBase : pairedOppositeBalance;
      avgPrice = formatPriceFromMicro(500_000n);
      currentValue = formatUSDCFromBase(mergeableBase / 2n);
    }

    rows.push({
      token_id: tokenId,
      size: formatSharesFromBase(balanceBase),
      market: meta?.marketLabel || meta?.marketSlug || meta?.marketId || tokenId,
      outcome: meta?.outcome || 'UNKNOWN',
      side: meta?.outcome || 'UNKNOWN',
      avgPrice,
      currentValue,
      condition_id: meta?.conditionId || null,
      market_id: meta?.marketId || null,
      market_slug: meta?.marketSlug || null,
      oppositeAsset: oppositeTokenId,
      mergeable: Boolean(meta && oppositeBalance >= ONCHAIN_FALLBACK_MIN_SHARES_BASE),
      sellable: Boolean(meta?.marketSlug || meta?.marketId),
      source: 'onchain-explorer'
    });
  }

  rows.sort((a, b) => {
    const aBase = parseSharesToBase(a.size || '0');
    const bBase = parseSharesToBase(b.size || '0');
    if (aBase === bBase) return 0;
    return aBase < bBase ? 1 : -1;
  });

  return rows;
}

async function getOnchainPositionsFromExplorer(address, options = {}) {
  const owner = String(address || '').trim().toLowerCase();
  if (!owner) return [];

  const forceRefresh = options?.forceRefresh === true;
  const cached = onchainPositionsCache.get(owner);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < ONCHAIN_FALLBACK_CACHE_TTL_MS) {
    return cached.positions;
  }

  const [transfers, markets] = await Promise.all([
    fetchOnchainTransfersFromExplorer(owner),
    getCachedMarkets(500)
  ]);

  const touchedTokenIds = collectTouchedTokenIdsFromTransfers(transfers, owner);
  let tokenBalances = new Map();
  let usedOnchainBatchBalances = false;

  if (touchedTokenIds.length > 0) {
    try {
      tokenBalances = await fetchTokenBalancesFromChain(owner, touchedTokenIds);
      usedOnchainBatchBalances = true;
      const ctx = createContext('polymarket', 'getOnchainPositionsFromExplorer');
      safeLogInfo(ctx, 'Resolved ERC1155 balances via balanceOfBatch', {
        walletAddress: owner,
        tokenIds: touchedTokenIds.length
      });
    } catch (error) {
      const ctx = createContext('polymarket', 'getOnchainPositionsFromExplorer');
      safeLogWarn(ctx, 'Failed to fetch ERC1155 balances via balanceOfBatch, falling back to transfer-derived balances', {
        walletAddress: owner,
        tokens: touchedTokenIds.length,
        message: error?.message
      });
    }
  }

  if (!usedOnchainBatchBalances) {
    tokenBalances = buildTokenBalancesFromTransfers(transfers, owner);
  }

  const tokenMeta = buildTokenMetaFromCachedMarkets(markets);
  const unresolvedTokenIds = [];
  for (const [tokenId, balanceBase] of tokenBalances.entries()) {
    if (balanceBase < ONCHAIN_FALLBACK_MIN_SHARES_BASE) continue;
    if (!tokenMeta.has(tokenId)) unresolvedTokenIds.push(tokenId);
  }

  if (unresolvedTokenIds.length > 0) {
    const splitDerivedMeta = await buildSplitDerivedTokenMeta(owner, transfers, unresolvedTokenIds);
    for (const [tokenId, meta] of splitDerivedMeta.entries()) {
      const existing = tokenMeta.get(tokenId);
      if (!existing) {
        tokenMeta.set(tokenId, meta);
        continue;
      }

      tokenMeta.set(tokenId, {
        ...existing,
        conditionId: meta?.conditionId || existing?.conditionId || null,
        outcome: existing?.outcome && existing.outcome !== 'UNKNOWN'
          ? existing.outcome
          : (meta?.outcome || existing?.outcome || 'UNKNOWN'),
        oppositeAsset: meta?.oppositeAsset || existing?.oppositeAsset || null,
        marketId: meta?.marketId || existing?.marketId || null,
        marketSlug: meta?.marketSlug || existing?.marketSlug || null,
        marketLabel: meta?.marketLabel || existing?.marketLabel || existing?.marketId || null,
        marketPrice: meta?.marketPrice || existing?.marketPrice || null
      });
    }
  }

  const positions = buildOnchainPositionsFromBalances(tokenBalances, tokenMeta);

  onchainPositionsCache.set(owner, { timestamp: Date.now(), positions });
  return positions;
}

// Get user positions - REQUIRES clobClient
export async function getPositions(userAddress, options = {}) {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }

  const address = (userAddress || clobUserAddress || clobClient?.signer?.address || '').toLowerCase();
  if (!address) {
    throw new Error('Wallet address is required to fetch positions');
  }

  const url = new URL(`${DATA_API_URL}/positions`);
  url.searchParams.set('user', address);
  url.searchParams.set('sizeThreshold', 0);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch positions: ${response.status} ${response.statusText}`);
  }

  const raw = await response.json();
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.data)
      ? raw.data
      : [];

  const normalized = list
    .map(normalizePositionFromApi)
    .filter(pos => {
      if (!pos.token_id) return false;
      const size = toFiniteNumber(pos.size);
      return size === null || size > 0;
    });

  if (normalized.length > 0) {
    return normalized;
  }

  let fallback = [];
  try {
    fallback = await getOnchainPositionsFromExplorer(address, {
      forceRefresh: options?.forceOnchainRefresh === true
    });
  } catch (error) {
    const ctx = createContext('polymarket', 'getPositions');
    safeLogWarn(ctx, 'On-chain positions fallback failed', {
      message: error?.message
    });
    return normalized;
  }

  if (fallback.length > 0) {
    const ctx = createContext('polymarket', 'getPositions');
    safeLogInfo(ctx, 'Using on-chain positions fallback because Data API returned empty positions', {
      walletAddress: address,
      count: fallback.length
    });
  }

  return fallback;
}

// Get user orders - REQUIRES clobClient
export async function getOrders(address) {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }

  const walletAddress = (address || clobUserAddress || '').toLowerCase();
  let list = [];

  try {
    const raw = await clobClient.getOpenOrders();
    list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data)
        ? raw.data
        : [];
  } catch (sdkError) {
    const ctx = createContext('polymarket', 'getOrders');
    safeLogWarn(ctx, 'SDK getOpenOrders failed, trying HTTP fallback', {
      message: sdkError?.message
    });

    list = await getOpenOrdersViaHttpFallback(walletAddress);
  }

  return list.map(order => ({
    ...order,
    // Prefer human-readable labels when available.
    market: toNonEmptyString(
      order?.title ??
      order?.question ??
      order?.slug ??
      order?.market ??
      order?.condition_id ??
      order?.conditionId ??
      order?.market_id ??
      order?.marketId
    ),
    side: toNonEmptyString(order?.side ?? order?.outcome),
    amount: toNonEmptyString(order?.amount ?? order?.remaining_size ?? order?.original_size ?? order?.size_matched) || '0',
    price: toNonEmptyString(order?.price),
    status: toNonEmptyString(order?.status) || 'unknown'
  }));
}

function normalizeOpenOrdersPage(payload) {
  if (Array.isArray(payload)) {
    return { items: payload, nextCursor: OPEN_ORDERS_END_CURSOR };
  }

  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.data)) {
      return { items: payload.data, nextCursor: payload.next_cursor || payload.nextCursor || OPEN_ORDERS_END_CURSOR };
    }
    if (Array.isArray(payload.orders)) {
      return { items: payload.orders, nextCursor: payload.next_cursor || payload.nextCursor || OPEN_ORDERS_END_CURSOR };
    }
  }

  return { items: [], nextCursor: OPEN_ORDERS_END_CURSOR };
}

async function getL2HeaderTimestamp() {
  if (!clobClient?.useServerTime || typeof clobClient?.getServerTime !== 'function') {
    return undefined;
  }
  try {
    return await clobClient.getServerTime();
  } catch {
    return undefined;
  }
}

async function fetchOpenOrdersPageViaHttp(endpoint, walletAddress, nextCursor, includeUserParam = true) {
  if (!clobClient?.signer || !clobClient?.creds) {
    throw new Error('HTTP fallback requires signer and L2 credentials');
  }

  const requestPath = endpoint;
  const headerArgs = {
    method: 'GET',
    requestPath
  };

  const headers = await createL2Headers(
    clobClient.signer,
    clobClient.creds,
    headerArgs,
    await getL2HeaderTimestamp()
  );

  const url = new URL(`${CLOB_API_URL}${endpoint}`);
  if (nextCursor) {
    url.searchParams.set('next_cursor', nextCursor);
  }
  if (includeUserParam && walletAddress) {
    url.searchParams.set('user', walletAddress);
  }

  const response = await fetch(url.toString(), { method: 'GET', headers });
  if (!response.ok) {
    throw new Error(`HTTP fallback failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function getOpenOrdersViaHttpFallback(walletAddress) {
  const endpoints = ['/orders', '/data/orders'];
  let lastError = null;

  for (const endpoint of endpoints) {
    const includeUserOptions = walletAddress ? [true, false] : [false];
    for (const includeUserParam of includeUserOptions) {
      try {
        const items = [];
        let nextCursor = OPEN_ORDERS_INITIAL_CURSOR;

        for (let page = 0; page < OPEN_ORDERS_MAX_FALLBACK_PAGES; page += 1) {
          const payload = await fetchOpenOrdersPageViaHttp(endpoint, walletAddress, nextCursor, includeUserParam);
          const { items: pageItems, nextCursor: responseCursor } = normalizeOpenOrdersPage(payload);

          if (pageItems.length > 0) {
            items.push(...pageItems);
          }

          const normalizedCursor = responseCursor || OPEN_ORDERS_END_CURSOR;
          if (normalizedCursor === OPEN_ORDERS_END_CURSOR || normalizedCursor === nextCursor) {
            break;
          }
          nextCursor = normalizedCursor;
        }

        return items;
      } catch (error) {
        lastError = error;
        const ctx = createContext('polymarket', 'getOpenOrdersViaHttpFallback');
        safeLogWarn(ctx, 'Open-orders HTTP fallback endpoint failed', {
          endpoint,
          includeUserParam,
          message: error?.message
        });
      }
    }
  }

  throw lastError || new Error('Failed to fetch open orders via HTTP fallback');
}

// Check if createAndPostMarketOrder is available in SDK
function hasMarketOrderSupport() {
  return clobClient && typeof clobClient.createAndPostMarketOrder === 'function';
}

// Ask CLOB backend to refresh cached balance/allowance view from chain.
async function refreshClobBalanceAllowance(assetType, tokenId) {
  if (!clobClient || typeof clobClient.updateBalanceAllowance !== 'function') {
    return;
  }
  try {
    const params = { asset_type: assetType };
    // Only attach token_id for CONDITIONAL assets; COLLATERAL must NOT have token_id
    if (assetType !== AssetType.COLLATERAL && tokenId) {
      params.token_id = tokenId;
    }
    await clobClient.updateBalanceAllowance(params);
  } catch (error) {
    const ctx = createContext('polymarket', 'refreshClobBalanceAllowance');
    safeLogWarn(ctx, 'Failed to refresh CLOB balance/allowance cache', {
      assetType,
      hasTokenId: Boolean(tokenId),
      message: error?.message
    });
  }
}

function safeToBigInt(value) {
  try {
    return BigInt(value?.toString?.() ?? value);
  } catch {
    return null;
  }
}

// ============================================================================
// Get CLOB collateral balance and allowance status
// Returns { balance, allowance } as strings in base units (bigint-safe)
// ============================================================================
export async function getCollateralStatus() {
  if (!clobClient || typeof clobClient.getBalanceAllowance !== 'function') {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }

  // Refresh CLOB backend cache before fetching
  await refreshClobBalanceAllowance(AssetType.COLLATERAL, null);

  // COLLATERAL must NOT have token_id parameter
  const data = await clobClient.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL
  });

  const balance = safeToBigInt(data?.balance);

  // getBalanceAllowance returns allowances map per spender, not single allowance
  const allowancesMap = data?.allowances || {};

  return {
    balance: balance !== null ? balance.toString() : '0',
    allowances: {
      ctfExchange: allowancesMap[CTF_EXCHANGE_ADDRESS] ?? '0',
      negRiskExchange: allowancesMap[NEG_RISK_CTF_EXCHANGE] ?? '0',
      negRiskAdapter: allowancesMap[NEG_RISK_ADAPTER] ?? '0'
    }
  };
}

async function ensureClobCollateralReady(amountUSDCBase) {
  if (!clobClient || typeof clobClient.getBalanceAllowance !== 'function') {
    return;
  }

  const { balance, allowances } = await getCollateralStatus();
  const balanceBig = safeToBigInt(balance);
  const allowanceBig = safeToBigInt(allowances.ctfExchange);

  if (balanceBig === null || allowanceBig === null) {
    return;
  }

  // Calculate required amounts for display (formatted as human-readable USDC)
  const requiredDisplay = formatUSDCFromBase(amountUSDCBase);
  const balanceDisplay = formatUSDCFromBase(balanceBig);
  const allowanceDisplay = formatUSDCFromBase(allowanceBig);

  if (balanceBig < amountUSDCBase && allowanceBig < amountUSDCBase) {
    throw new Error(
      `Insufficient balance and allowance. Balance: ${balanceDisplay} USDC, Allowance: ${allowanceDisplay} USDC, Required: ${requiredDisplay} USDC`
    );
  }

  if (balanceBig < amountUSDCBase) {
    throw new Error(
      `Insufficient balance. Balance: ${balanceDisplay} USDC, Required: ${requiredDisplay} USDC`
    );
  }

  if (allowanceBig < amountUSDCBase) {
    throw new Error(
      `Insufficient allowance. Allowance: ${allowanceDisplay} USDC, Required: ${requiredDisplay} USDC. Please go to Settings → Set Allowances.`
    );
  }
}

// Normalize BUY amount input to base units (micro USDC).
// Supports:
// - bigint base units (e.g. 2000000n for 2 USDC)
// - display string/number (e.g. "2", "2.5")
function toUSDCBaseAmount(amountUSDC) {
  if (typeof amountUSDC === 'bigint') {
    return amountUSDC;
  }
  if (typeof amountUSDC === 'string' || typeof amountUSDC === 'number') {
    return parseUSDCToBase(amountUSDC.toString());
  }
  throw new Error('amountUSDC must be bigint, string, or number');
}

// Normalize SELL size input to base units (micro shares).
// Supports:
// - bigint base units
// - display string/number
function toSharesBaseAmount(sizeShares) {
  if (typeof sizeShares === 'bigint') {
    return sizeShares;
  }
  if (typeof sizeShares === 'string' || typeof sizeShares === 'number') {
    return parseSharesToBase(sizeShares.toString());
  }
  throw new Error('sizeShares must be bigint, string, or number');
}

// Normalize price input to micro price units.
// Supports:
// - bigint micro price
// - display string/number, e.g. "0.55"
function toPriceMicroAmount(price) {
  if (typeof price === 'bigint') {
    return price;
  }
  if (typeof price === 'string' || typeof price === 'number') {
    return parsePriceToMicro(String(price).trim().replace(',', '.'));
  }
  throw new Error('price must be bigint, string, or number');
}

const SUPPORTED_TICK_SIZES = ['0.1', '0.01', '0.001', '0.0001'];

function normalizeTickSizeForSdk(rawTickSize) {
  const parsed = Number(rawTickSize);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return '0.01';
  }

  // Fast exact match path for common values like "0.001000000000000000".
  for (const supported of SUPPORTED_TICK_SIZES) {
    if (Math.abs(Number(supported) - parsed) < 1e-12) {
      return supported;
    }
  }

  // clob-client uses a fixed ROUNDING_CONFIG map by tick size string.
  // Pick the closest supported value that is >= market minimum tick size.
  const ascending = [...SUPPORTED_TICK_SIZES].sort((a, b) => Number(a) - Number(b));
  for (const candidate of ascending) {
    if (Number(candidate) >= parsed) {
      return candidate;
    }
  }

  // Keep a safe fallback for unexpected markets.
  return '0.1';
}

async function resolveOrderOptions(tokenId) {
  const rawTickSize = await clobClient.getTickSize(tokenId);
  const tickSize = normalizeTickSizeForSdk(rawTickSize);
  const negRisk = await clobClient.getNegRisk(tokenId);

  return { tickSize, negRisk, rawTickSize };
}

function toSdkNumber(value, fieldName) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return num;
}

// Retry order placement only when server explicitly indicates throttling.
// This avoids duplicate fills on ambiguous transport errors.
function isSafeToRetryOrderPlacement(error) {
  const status = Number(error?.response?.status ?? error?.status);
  if (status === 429 || status === 503) {
    return true;
  }

  const message = (error?.message || '').toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('too many') ||
    message.includes('429')
  );
}

function isAmbiguousTransportOrderError(error) {
  const status = Number(error?.response?.status ?? error?.status);
  if (status === 408 || status === 499 || status === 500 || status === 502 || status === 504 || status === 520 || status === 522 || status === 524) {
    return true;
  }

  const code = String(error?.code || '').toUpperCase();
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return true;
  }

  const message = (error?.message || '').toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('socket hang up') ||
    message.includes('connection reset') ||
    message.includes('network error') ||
    message.includes('fetch failed') ||
    message.includes('failed to fetch')
  );
}

function normalizeOrderSide(side) {
  const normalized = String(side || '').trim().toUpperCase();
  return normalized === 'BUY' || normalized === 'SELL' ? normalized : null;
}

function extractTokenIdFromOrder(order) {
  return toNonEmptyString(order?.token_id ?? order?.tokenId ?? order?.tokenID ?? order?.asset_id ?? order?.assetId);
}

function extractOrderIdFromAny(order) {
  return toNonEmptyString(order?.orderID ?? order?.id ?? order?.orderId ?? order?.order_id);
}

function parsePriceMicroSafe(value) {
  if (value === null || value === undefined) return null;
  try {
    return toPriceMicroAmount(value);
  } catch {
    return null;
  }
}

function parseSharesBaseSafe(value) {
  if (value === null || value === undefined) return null;
  try {
    return toSharesBaseAmount(value);
  } catch {
    return null;
  }
}

function extractOrderSizeBase(order) {
  return parseSharesBaseSafe(
    order?.original_size ??
    order?.originalSize ??
    order?.size ??
    order?.amount ??
    order?.remaining_size ??
    order?.remainingSize
  );
}

function parseOrderCreatedAtMs(order) {
  const candidates = [
    order?.created_at,
    order?.createdAt,
    order?.inserted_at,
    order?.insertedAt,
    order?.timestamp
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate > 1e12 ? Math.floor(candidate) : Math.floor(candidate * 1000);
    }
    const asNumber = Number(candidate);
    if (Number.isFinite(asNumber)) {
      return asNumber > 1e12 ? Math.floor(asNumber) : Math.floor(asNumber * 1000);
    }
    const parsed = Date.parse(String(candidate));
    if (!Number.isNaN(parsed)) return parsed;
  }

  return null;
}

function isOpenOrderMatchingRequest(order, criteria) {
  if (!order || typeof order !== 'object') return false;

  const tokenId = extractTokenIdFromOrder(order);
  if (!tokenId || tokenId !== criteria.tokenId) return false;

  const side = normalizeOrderSide(order?.side ?? order?.outcome);
  if (!side || side !== criteria.side) return false;

  const priceMicro = parsePriceMicroSafe(order?.price);
  if (priceMicro === null || priceMicro !== criteria.priceMicro) return false;

  const sizeBase = extractOrderSizeBase(order);
  if (sizeBase === null || sizeBase !== criteria.sizeSharesBase) return false;

  return true;
}

function sortMatchingOrdersNewestFirst(orders) {
  const list = Array.isArray(orders) ? [...orders] : [];
  list.sort((a, b) => {
    const aMs = parseOrderCreatedAtMs(a);
    const bMs = parseOrderCreatedAtMs(b);
    if (aMs === null && bMs === null) return 0;
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    return bMs - aMs;
  });
  return list;
}

async function getMatchingOpenOrders(criteria) {
  const openOrders = await getOrders(clobUserAddress);
  return openOrders.filter((order) => isOpenOrderMatchingRequest(order, criteria));
}

async function snapshotMatchingOpenOrderIds(criteria) {
  const matches = await getMatchingOpenOrders(criteria);
  const ids = new Set();
  for (const order of matches) {
    const id = extractOrderIdFromAny(order);
    if (id) ids.add(id);
  }
  return ids;
}

async function reconcileOrderAfterAmbiguousFailure(criteria, existingMatchingIds) {
  const delays = [250, 800, 1800];

  for (let pass = 0; pass <= delays.length; pass += 1) {
    if (pass > 0) {
      await sleep(delays[pass - 1]);
    }

    const matches = await getMatchingOpenOrders(criteria);
    if (!matches.length) continue;

    const sortedMatches = sortMatchingOrdersNewestFirst(matches);
    for (const order of sortedMatches) {
      const id = extractOrderIdFromAny(order);
      if (!id) continue;
      if (existingMatchingIds && existingMatchingIds.has(id)) continue;
      return { order, orderId: id };
    }
  }

  return null;
}

// Place market BUY order (FOK) - SDK v4.22.8 compatible
// amountUSDC: dollar amount to spend (display string/number) OR bigint base units
// Returns: { orderId, takingAmount, makingAmount, status, transactionsHashes, success }
export async function placeMarketBuyFOK(tokenId, amountUSDC) {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }
  
  if (amountUSDC === undefined || amountUSDC === null) {
    throw new Error('amountUSDC must be provided');
  }
  
  // Normalize amount to bigint base units and display string for SDK.
  const amountUSDCBase = toUSDCBaseAmount(amountUSDC);
  if (amountUSDCBase <= 0n) {
    throw new Error('amountUSDC must be positive');
  }
  const amountUSDCDisplay = formatUSDCFromBase(amountUSDCBase);

  // Ensure CLOB backend sees fresh collateral balance/allowance.
  await refreshClobBalanceAllowance(AssetType.COLLATERAL, tokenId);
  await ensureClobCollateralReady(amountUSDCBase);
  
  // Get current bestAsk for reference price (as string)
  const { bestAskStr } = await getBestBidAsk(tokenId);
  if (!bestAskStr) {
    throw new Error('No ask price available for this market');
  }
  
  // Convert to micro units and calculate marketable price
  const bestAskMicro = parsePriceToMicro(bestAskStr);
  const initialMarketablePriceMicro = calculateMarketablePriceMicro(bestAskMicro, 'BUY');
  let currentBestAskMicro = bestAskMicro;
  let currentMarketablePriceMicro = initialMarketablePriceMicro;
  let currentMarketablePriceNum = toSdkNumber(formatPriceFromMicro(currentMarketablePriceMicro), 'price');
  const amountUSDCNum = toSdkNumber(amountUSDCDisplay, 'amount');
  
  // Retry only on explicit throttling/server-unavailable responses.
  const delays = [1000, 2000, 4000];
  const orderOptions = await resolveOrderOptions(tokenId);
  if (orderOptions.tickSize !== String(orderOptions.rawTickSize)) {
    const ctx = createContext('polymarket', 'placeMarketBuyFOK');
    safeLogInfo(ctx, 'Normalized tick size for SDK rounding config', {
      tokenId,
      rawTickSize: String(orderOptions.rawTickSize),
      tickSize: orderOptions.tickSize
    });
  }
  
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      let result;
      
      if (hasMarketOrderSupport()) {
        // Use createAndPostMarketOrder if available
        result = await clobClient.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            side: Side.BUY,
            amount: amountUSDCNum,
            price: currentMarketablePriceNum
          },
          orderOptions,
          OrderType.FOK
        );
      } else {
        // Fallback: use createAndPostOrder with FOK and marketable limit price
        // For BUY: compute shares from USDC amount
        const sharesBase = computeSharesFromUSDC(amountUSDCBase, currentMarketablePriceMicro);
        const sharesDisplay = formatSharesFromBase(sharesBase);
        const sharesNum = toSdkNumber(sharesDisplay, 'size');
        
        result = await clobClient.createAndPostOrder(
          {
            tokenID: tokenId,
            side: Side.BUY,
            price: currentMarketablePriceNum,
            size: sharesNum
          },
          orderOptions,
          OrderType.FOK
        );
      }

      const placement = resolveOrderPlacementResult(result);
      
      const estimatedSharesBase = computeSharesFromUSDC(amountUSDCBase, currentBestAskMicro);
      return {
        orderId: placement.orderId,
        takingAmount: result.takingAmount,
        makingAmount: result.makingAmount,
        status: result.status,
        transactionsHashes: result.transactionsHashes || [],
        success: placement.success,
        error: placement.error,
        // Additional info for confirmation display
        estimatedSharesBase: estimatedSharesBase.toString(),
        priceMicro: currentBestAskMicro.toString()
      };
    } catch (error) {
      const ctx = createContext('polymarket', 'placeMarketBuyFOK');
      safeLogWarn(ctx, `Market buy failed (attempt ${attempt + 1})`, { tokenId });

      const errMsg = (error?.message || '').toLowerCase();
      if (errMsg.includes('allowance') || errMsg.includes('balance')) {
        await refreshClobBalanceAllowance(AssetType.COLLATERAL, tokenId);
      }

      const canRetry = attempt < delays.length && isSafeToRetryOrderPlacement(error);
      if (!canRetry) {
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      // Refresh price on retry
      const { bestAskStr: refreshedAsk } = await getBestBidAsk(tokenId);
      if (refreshedAsk) {
        const refreshedMicro = parsePriceToMicro(refreshedAsk);
        const newPriceMicro = calculateMarketablePriceMicro(refreshedMicro, 'BUY');
        const moveBps = enforceRetryPriceMovementLimits('BUY', initialMarketablePriceMicro, newPriceMicro);
        const previousPriceMicro = currentMarketablePriceMicro;
        currentBestAskMicro = refreshedMicro;
        currentMarketablePriceMicro = newPriceMicro;
        currentMarketablePriceNum = toSdkNumber(formatPriceFromMicro(newPriceMicro), 'price');
        safeLogWarn(ctx, `Refreshed price for retry`, {
          attempt: attempt + 1,
          oldPrice: formatPriceFromMicro(previousPriceMicro),
          newPrice: formatPriceFromMicro(newPriceMicro),
          movePercent: formatBpsPercent(moveBps)
        });
      }
    }
  }
}

// Place market SELL order (FOK) - SDK v4.22.8 compatible
// sizeShares: shares to sell (display string/number) OR bigint base units
// Returns: { orderId, takingAmount, makingAmount, status, transactionsHashes, success }
export async function placeMarketSellFOK(tokenId, sizeShares) {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }
  
  if (sizeShares === undefined || sizeShares === null) {
    throw new Error('sizeShares must be provided');
  }
  
  // Normalize shares to bigint base units and display string for SDK.
  const sharesBase = toSharesBaseAmount(sizeShares);
  if (sharesBase <= 0n) {
    throw new Error('sizeShares must be positive');
  }
  const sharesDisplay = formatSharesFromBase(sharesBase);

  // Ensure CLOB backend sees fresh conditional-token balance/allowance.
  await refreshClobBalanceAllowance(AssetType.CONDITIONAL, tokenId);
  
  // Get current bestBid for reference price (as string)
  const { bestBidStr } = await getBestBidAsk(tokenId);
  if (!bestBidStr) {
    throw new Error('No bid price available for this market');
  }
  
  // Convert to micro units and calculate marketable price
  const bestBidMicro = parsePriceToMicro(bestBidStr);
  const initialMarketablePriceMicro = calculateMarketablePriceMicro(bestBidMicro, 'SELL');
  let currentBestBidMicro = bestBidMicro;
  let currentMarketablePriceMicro = initialMarketablePriceMicro;
  let currentMarketablePriceNum = toSdkNumber(formatPriceFromMicro(currentMarketablePriceMicro), 'price');
  const sharesNum = toSdkNumber(sharesDisplay, 'amount');
  
  // Retry only on explicit throttling/server-unavailable responses.
  const delays = [1000, 2000, 4000];
  const orderOptions = await resolveOrderOptions(tokenId);
  if (orderOptions.tickSize !== String(orderOptions.rawTickSize)) {
    const ctx = createContext('polymarket', 'placeMarketSellFOK');
    safeLogInfo(ctx, 'Normalized tick size for SDK rounding config', {
      tokenId,
      rawTickSize: String(orderOptions.rawTickSize),
      tickSize: orderOptions.tickSize
    });
  }
  
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      let result;
      
      if (hasMarketOrderSupport()) {
        // Use createAndPostMarketOrder if available
        // For SELL: amount = shares to sell
        result = await clobClient.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            side: Side.SELL,
            amount: sharesNum,
            price: currentMarketablePriceNum
          },
          orderOptions,
          OrderType.FOK
        );
      } else {
        // Fallback: use createAndPostOrder with FOK and marketable limit price
        result = await clobClient.createAndPostOrder(
          {
            tokenID: tokenId,
            side: Side.SELL,
            price: currentMarketablePriceNum,
            size: sharesNum
          },
          orderOptions,
          OrderType.FOK
        );
      }

      const placement = resolveOrderPlacementResult(result);
      
      const estimatedUSDCBase = computeUSDCFromShares(sharesBase, currentBestBidMicro);
      return {
        orderId: placement.orderId,
        takingAmount: result.takingAmount,
        makingAmount: result.makingAmount,
        status: result.status,
        transactionsHashes: result.transactionsHashes || [],
        success: placement.success,
        error: placement.error,
        // Additional info for confirmation display
        estimatedUSDCBase: estimatedUSDCBase.toString(),
        priceMicro: currentBestBidMicro.toString()
      };
    } catch (error) {
      const ctx = createContext('polymarket', 'placeMarketSellFOK');
      safeLogWarn(ctx, `Market sell failed (attempt ${attempt + 1})`, { tokenId });

      const errMsg = (error?.message || '').toLowerCase();
      if (errMsg.includes('allowance') || errMsg.includes('balance')) {
        await refreshClobBalanceAllowance(AssetType.CONDITIONAL, tokenId);
      }

      const canRetry = attempt < delays.length && isSafeToRetryOrderPlacement(error);
      if (!canRetry) {
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      // Refresh price on retry
      const { bestBidStr: refreshedBid } = await getBestBidAsk(tokenId);
      if (refreshedBid) {
        const refreshedMicro = parsePriceToMicro(refreshedBid);
        const newPriceMicro = calculateMarketablePriceMicro(refreshedMicro, 'SELL');
        const moveBps = enforceRetryPriceMovementLimits('SELL', initialMarketablePriceMicro, newPriceMicro);
        const previousPriceMicro = currentMarketablePriceMicro;
        currentBestBidMicro = refreshedMicro;
        currentMarketablePriceMicro = newPriceMicro;
        currentMarketablePriceNum = toSdkNumber(formatPriceFromMicro(newPriceMicro), 'price');
        safeLogWarn(ctx, `Refreshed price for retry`, {
          attempt: attempt + 1,
          oldPrice: formatPriceFromMicro(previousPriceMicro),
          newPrice: formatPriceFromMicro(newPriceMicro),
          movePercent: formatBpsPercent(moveBps)
        });
      }
    }
  }
}

// Smart SELL wrapper:
// 1) tries direct CLOB market sell;
// 2) for negRisk legacy token ids (no orderbook) can fallback to:
//    merge legacy pair -> split via adapter to tradable ids -> sell tradable side.
export async function placeMarketSellWithFallback(tokenId, sizeShares, options = {}) {
  try {
    return await placeMarketSellFOK(tokenId, sizeShares);
  } catch (error) {
    if (!shouldAttemptNegRiskSellFallback(error)) {
      throw error;
    }

    const normalizedConditionId = normalizeConditionId(options?.conditionId);
    if (!normalizedConditionId) {
      throw error;
    }

    await ensureNegRiskAdapterReady();
    const sharesBase = toSharesBaseAmount(sizeShares);
    const fallbackResult = await executeNegRiskLegacySellFallback({
      tokenId,
      sharesBase,
      conditionId: normalizedConditionId,
      outcomeHint: options?.outcome
    });

    if (!fallbackResult) {
      throw error;
    }

    return fallbackResult;
  }
}

// Legacy createOrder for limit orders (GTC) - Phase 3
export async function createOrder(params) {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }
  
  const { tokenId, price, sizeShares, side, orderType } = params;
  const normalizedTokenId = toNonEmptyString(tokenId);
  
  if (!normalizedTokenId) {
    throw new Error('tokenId is required');
  }

  if (side !== 'SELL' && side !== 'BUY') {
    throw new Error(`Invalid side: ${side}. Must be BUY or SELL.`);
  }

  const sharesBase = toSharesBaseAmount(sizeShares);
  if (sharesBase <= 0n) {
    throw new Error('sizeShares must be positive');
  }

  const priceMicro = toPriceMicroAmount(price);
  if (priceMicro <= 0n || priceMicro >= PRICE_MICRO) {
    throw new Error('price must be between 0 and 1');
  }

  const normalizedSize = formatSharesFromBase(sharesBase);
  const normalizedPrice = formatPriceFromMicro(priceMicro);
  const normalizedSizeNum = toSdkNumber(normalizedSize, 'size');
  const normalizedPriceNum = toSdkNumber(normalizedPrice, 'price');
  const normalizedSide = side === 'BUY' ? Side.BUY : Side.SELL;
  const compareCriteria = {
    tokenId: normalizedTokenId,
    side,
    priceMicro,
    sizeSharesBase: sharesBase
  };
  const orderOptions = await resolveOrderOptions(normalizedTokenId);
  if (orderOptions.tickSize !== String(orderOptions.rawTickSize)) {
    const ctx = createContext('polymarket', 'createOrder');
    safeLogInfo(ctx, 'Normalized tick size for SDK rounding config', {
      tokenId: normalizedTokenId,
      rawTickSize: String(orderOptions.rawTickSize),
      tickSize: orderOptions.tickSize
    });
  }
  
  // Retry logic
  let lastError;
  let attemptsMade = 0;
  const delays = [1000, 2000, 4000];
  let existingMatchingIds = null;
  try {
    existingMatchingIds = await snapshotMatchingOpenOrderIds(compareCriteria);
  } catch (snapshotError) {
    const ctx = createContext('polymarket', 'createOrder');
    safeLogWarn(ctx, 'Failed to snapshot matching open orders before placement', {
      tokenId: normalizedTokenId,
      side,
      orderType,
      price: normalizedPrice,
      size: normalizedSize,
      message: snapshotError?.message
    });
  }
  
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    attemptsMade = attempt + 1;
    try {
      const order = await clobClient.createAndPostOrder(
        {
          tokenID: normalizedTokenId,
          price: normalizedPriceNum,
          size: normalizedSizeNum,
          side: normalizedSide
        },
        orderOptions,
        orderType === 'GTC' ? OrderType.GTC : OrderType.FOK
      );
      
      return order;
    } catch (error) {
      lastError = error;
      const canRetry = attempt < delays.length && isSafeToRetryOrderPlacement(error);
      if (canRetry) {
        const ctx = createContext('polymarket', 'createOrder');
        safeLogWarn(ctx, `Order creation failed (attempt ${attempt + 1}), retrying...`, {
          tokenId: normalizedTokenId,
          side,
          orderType,
          price: normalizedPrice,
          size: normalizedSize,
          priceNum: normalizedPriceNum,
          sizeNum: normalizedSizeNum,
          status: Number(error?.response?.status ?? error?.status),
          errorMessage: error?.message || String(error)
        });
        await sleep(delays[attempt]);
        continue;
      }

      const shouldReconcile = orderType === 'GTC' && isAmbiguousTransportOrderError(error);
      if (shouldReconcile) {
        const ctx = createContext('polymarket', 'createOrder');
        safeLogWarn(ctx, 'Order placement failed with ambiguous transport error, trying reconciliation via open orders', {
          tokenId: normalizedTokenId,
          side,
          orderType,
          price: normalizedPrice,
          size: normalizedSize,
          status: Number(error?.response?.status ?? error?.status),
          errorMessage: error?.message || String(error)
        });
        try {
          const reconciled = await reconcileOrderAfterAmbiguousFailure(compareCriteria, existingMatchingIds);
          if (reconciled?.orderId) {
            safeLogWarn(ctx, 'Recovered order id after ambiguous failure via open-orders reconciliation', {
              tokenId: normalizedTokenId,
              side,
              orderType,
              price: normalizedPrice,
              size: normalizedSize,
              orderId: reconciled.orderId
            });
            return {
              ...reconciled.order,
              orderID: reconciled.orderId,
              orderId: reconciled.orderId,
              reconciled: true
            };
          }
        } catch (reconcileError) {
          safeLogWarn(ctx, 'Open-orders reconciliation failed', {
            tokenId: normalizedTokenId,
            side,
            orderType,
            message: reconcileError?.message
          });
        }
      }
      break;
    }
  }
  
  throw new Error(`Failed to create order after ${attemptsMade} attempt(s): ${lastError.message}`);
}

// Cancel order - REQUIRES clobClient
export async function cancelOrder(orderId) {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }
  
  return await clobClient.cancelOrder({ orderID: orderId });
}

// Check USDC balance - REQUIRES clobClient
export async function checkBalance(address) {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }

  void address;

  await refreshClobBalanceAllowance(AssetType.COLLATERAL, null);
  const data = await clobClient.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL
  });

  const balance = safeToBigInt(data?.balance);
  return balance !== null ? balance.toString() : '0';
}

// ============================================================================
// Part B: CTF Operations (via ethers.js)
// ============================================================================

let provider = null;
let usdcContract = null;
let ctfContract = null;
let negRiskAdapterContract = null;
let currentSigner = null;

const DEFAULT_POLYGON_RPC_URLS = [
  'https://polygon-public.nodies.app',
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.llamarpc.com'
];

const GWEI_UNIT = 'gwei';
const BUMP_SCALE = 1000;
const MIN_PRIORITY_FEE_GWEI = parsePositiveNumberEnv('POLYGON_MIN_PRIORITY_FEE_GWEI', 30);
const MIN_MAX_FEE_GWEI = parsePositiveNumberEnv('POLYGON_MIN_MAX_FEE_GWEI', 60);
const APPROVE_GAS_RETRY_COUNT = Math.max(1, Math.floor(parsePositiveNumberEnv('POLYGON_APPROVE_GAS_RETRY_COUNT', 3)));
const APPROVE_GAS_BUMP_MULTIPLIER = parsePositiveNumberEnv('POLYGON_APPROVE_GAS_BUMP_MULTIPLIER', 1.5);
const MIN_USDC_ALLOWANCE_USDC = parsePositiveNumberEnv('POLYGON_MIN_USDC_ALLOWANCE_USDC', 1000);
const MIN_USDC_ALLOWANCE_BASE = ethers.utils.parseUnits(String(MIN_USDC_ALLOWANCE_USDC), USDC_DECIMALS);
const NEG_RISK_TOKEN_MAP_CACHE_TTL_MS = 5 * 60 * 1000;
const negRiskTokenMapCache = new Map();

const NEG_RISK_ADAPTER_ABI = [
  'function splitPosition(address _collateralToken, bytes32, bytes32 _conditionId, uint256[] calldata, uint256 _amount) external',
  'function mergePositions(address _collateralToken, bytes32, bytes32 _conditionId, uint256[] calldata, uint256 _amount) external',
  'function convertPositions(bytes32 _marketId, uint256 _indexSet, uint256 _amount) external',
  'function wcol() external view returns (address)',
  'function getConditionId(bytes32 _questionId) external view returns (bytes32)',
  'function getMarketData(bytes32 _marketId) external view returns (bytes32)'
];

function parsePositiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function maxBigNumber(a, b) {
  return a.gt(b) ? a : b;
}

function isBelowMinAmount(value, minValue) {
  if (value && typeof value.lt === 'function') return value.lt(minValue);
  try {
    return BigInt(value?.toString?.() ?? value) < BigInt(minValue?.toString?.() ?? minValue);
  } catch {
    return true;
  }
}

function toWeiFromGwei(value) {
  return ethers.utils.parseUnits(String(value), GWEI_UNIT);
}

function getBumpNumerator(attempt) {
  if (attempt <= 0) return BUMP_SCALE;
  return Math.max(BUMP_SCALE, Math.round(Math.pow(APPROVE_GAS_BUMP_MULTIPLIER, attempt) * BUMP_SCALE));
}

function applyBump(value, attempt) {
  const numerator = getBumpNumerator(attempt);
  return value.mul(numerator).div(BUMP_SCALE);
}

function isRetryableApprovalGasError(error) {
  const lower = (error?.message || String(error || '')).toLowerCase();
  return (
    lower.includes('gas price below minimum') ||
    lower.includes('fee too low') ||
    lower.includes('underpriced') ||
    lower.includes('replacement fee too low') ||
    lower.includes('max fee per gas less than block base fee')
  );
}

async function buildApprovalGasOverrides(attempt) {
  const minPriority = toWeiFromGwei(MIN_PRIORITY_FEE_GWEI);
  const minMax = toWeiFromGwei(MIN_MAX_FEE_GWEI);

  const fallbackPriority = applyBump(minPriority, attempt);
  const fallbackMax = applyBump(maxBigNumber(minMax, minPriority.mul(2)), attempt);

  if (!provider) {
    return { maxPriorityFeePerGas: fallbackPriority, maxFeePerGas: fallbackMax };
  }

  try {
    const feeData = await provider.getFeeData();

    if (feeData.maxPriorityFeePerGas || feeData.maxFeePerGas) {
      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? minPriority;
      let maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? minMax;

      maxPriorityFeePerGas = maxBigNumber(maxPriorityFeePerGas, minPriority);
      maxFeePerGas = maxBigNumber(maxFeePerGas, minMax);
      if (maxFeePerGas.lt(maxPriorityFeePerGas)) {
        maxFeePerGas = maxPriorityFeePerGas.mul(2);
      }

      maxPriorityFeePerGas = applyBump(maxPriorityFeePerGas, attempt);
      maxFeePerGas = applyBump(maxFeePerGas, attempt);
      if (maxFeePerGas.lt(maxPriorityFeePerGas)) {
        maxFeePerGas = maxPriorityFeePerGas.mul(2);
      }

      return { maxPriorityFeePerGas, maxFeePerGas };
    }

    const gasPrice = maxBigNumber(feeData.gasPrice ?? minMax, minMax);
    return { gasPrice: applyBump(gasPrice, attempt) };
  } catch (error) {
    const ctx = createContext('polymarket', 'buildApprovalGasOverrides');
    safeLogWarn(ctx, 'Could not build gas overrides from feeData, using fallback fee floor', {
      attempt,
      message: error?.message
    });
    return { maxPriorityFeePerGas: fallbackPriority, maxFeePerGas: fallbackMax };
  }
}

async function sendWithAdaptiveApprovalGas(action, sendFn, meta = {}) {
  let lastError;

  for (let attempt = 0; attempt < APPROVE_GAS_RETRY_COUNT; attempt++) {
    try {
      const overrides = await buildApprovalGasOverrides(attempt);
      const tx = await sendFn(overrides);
      return await tx.wait();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableApprovalGasError(error);

      const ctx = createContext('polymarket', action);
      safeLogWarn(ctx, `Approval tx failed (attempt ${attempt + 1}/${APPROVE_GAS_RETRY_COUNT})`, {
        ...meta,
        retryable,
        message: error?.message
      });

      if (!retryable || attempt >= APPROVE_GAS_RETRY_COUNT - 1) {
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }

  throw lastError;
}

function parseRpcChainId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = trimmed.startsWith('0x')
      ? Number.parseInt(trimmed, 16)
      : Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function resolveRpcChainId(provider) {
  try {
    const chainId = await provider.send('eth_chainId', []);
    return parseRpcChainId(chainId);
  } catch {
    const chainId = await provider.send('net_version', []);
    return parseRpcChainId(chainId);
  }
}

async function createWorkingProvider(rpcUrl) {
  const candidates = Array.from(
    new Set(
      [rpcUrl, getPolygonRpcUrl(), ...DEFAULT_POLYGON_RPC_URLS]
        .filter(Boolean)
        .map(url => url.trim())
    )
  );

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    try {
      const p = new ethers.providers.StaticJsonRpcProvider(
        { url, timeout: 10000 },
        { name: 'matic', chainId: POLYGON_CHAIN_ID }
      );
      patchProviderSendForProxy(p);

      const detectedChainId = await resolveRpcChainId(p);
      if (detectedChainId !== POLYGON_CHAIN_ID) {
        throw new Error(`RPC chainId mismatch: expected ${POLYGON_CHAIN_ID}, got ${String(detectedChainId)}`);
      }

      await p.getBlockNumber();
      const ctx = createContext('polymarket', 'createWorkingProvider');
      safeLogInfo(ctx, 'Connected to Polygon RPC', { rpcUrl: url, chainId: detectedChainId });
      return p;
    } catch (error) {
      lastError = error;
      const ctx = createContext('polymarket', 'createWorkingProvider');
      safeLogWarn(ctx, 'RPC endpoint unavailable, trying next', {
        attempt: i + 1,
        total: candidates.length,
        rpcUrl: url,
        message: error?.message
      });
    }
  }

  throw new Error(`Could not connect to Polygon RPC: ${lastError?.message || 'unknown error'}`);
}

// Initialize CTF and USDC contracts
export async function initContracts(signer, rpcUrl) {
  provider = await createWorkingProvider(rpcUrl);
  onchainReadProvider = provider;
  
  const connectedSigner = signer.connect(provider);
  currentSigner = connectedSigner;
  usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, connectedSigner);
  ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, connectedSigner);
  negRiskAdapterContract = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, connectedSigner);
  
  return { provider, usdcContract, ctfContract, negRiskAdapterContract };
}

// Check ERC20 allowance for any token
export async function checkAllowance(tokenAddress, spender, owner) {
  if (!currentSigner) {
    throw new Error('Contracts not initialized. Call initContracts() first.');
  }
  
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, currentSigner);
  return await tokenContract.allowance(owner, spender);
}

// Set ERC20 allowance for any token
export async function setAllowance(tokenAddress, spender, amount) {
  if (!currentSigner) {
    throw new Error('Contracts not initialized. Call initContracts() first.');
  }
  
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, currentSigner);
  return await sendWithAdaptiveApprovalGas(
    'setAllowance',
    async (overrides) => tokenContract.approve(spender, amount, overrides),
    { tokenAddress, spender }
  );
}

// Check ERC1155 approval (for conditional tokens)
export async function checkApproval(owner, operator) {
  if (!ctfContract) {
    throw new Error('Contracts not initialized. Call initContracts() first.');
  }
  
  return await ctfContract.isApprovedForAll(owner, operator);
}

// Set ERC1155 approval (for conditional tokens)
export async function setApproval(operator, approved) {
  if (!ctfContract) {
    throw new Error('Contracts not initialized. Call initContracts() first.');
  }
  
  return await sendWithAdaptiveApprovalGas(
    'setApproval',
    async (overrides) => ctfContract.setApprovalForAll(operator, approved, overrides),
    { operator, approved }
  );
}

function normalizeOutcomeKey(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'YES') return 'YES';
  if (normalized === 'NO') return 'NO';
  return null;
}

function normalizeConditionIdOrThrow(conditionId) {
  const normalized = normalizeConditionId(conditionId);
  if (!normalized || !/^0x[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('conditionId must be a 32-byte hex string');
  }
  return normalized;
}

async function ensureNegRiskAdapterReady() {
  if (!currentSigner || !ctfContract || !negRiskAdapterContract) {
    throw new Error('Contracts not initialized. Call initContracts() first.');
  }
}

async function ensureErc1155ApprovalFor(operator) {
  const owner = await getSignerAddress(currentSigner);
  const approved = await ctfContract.isApprovedForAll(owner, operator);
  if (approved) return;

  await sendWithAdaptiveApprovalGas(
    'setApproval',
    async (overrides) => ctfContract.setApprovalForAll(operator, true, overrides),
    { operator, approved: true }
  );
}

async function getNegRiskTokenMappingByCondition(conditionIdRaw) {
  await ensureNegRiskAdapterReady();
  const conditionId = normalizeConditionIdOrThrow(conditionIdRaw);

  const cached = negRiskTokenMapCache.get(conditionId);
  if (cached && Date.now() - cached.timestamp < NEG_RISK_TOKEN_MAP_CACHE_TTL_MS) {
    return cached.value;
  }

  const wrappedCollateral = String(await negRiskAdapterContract.wcol()).toLowerCase();
  const collectionYes = await ctfContract.getCollectionId(PARENT_COLLECTION_ID, conditionId, BINARY_PARTITION[0]);
  const collectionNo = await ctfContract.getCollectionId(PARENT_COLLECTION_ID, conditionId, BINARY_PARTITION[1]);

  const legacyYes = (await ctfContract.getPositionId(USDC_ADDRESS, collectionYes)).toString();
  const legacyNo = (await ctfContract.getPositionId(USDC_ADDRESS, collectionNo)).toString();
  const tradableYes = (await ctfContract.getPositionId(wrappedCollateral, collectionYes)).toString();
  const tradableNo = (await ctfContract.getPositionId(wrappedCollateral, collectionNo)).toString();

  const value = {
    conditionId,
    wrappedCollateral,
    legacy: { YES: legacyYes, NO: legacyNo },
    tradable: { YES: tradableYes, NO: tradableNo }
  };
  negRiskTokenMapCache.set(conditionId, {
    timestamp: Date.now(),
    value
  });
  return value;
}

function resolveTokenKindInNegRiskMap(tokenIdRaw, tokenMap, outcomeHintRaw = null) {
  const tokenId = String(tokenIdRaw || '').trim();
  if (!tokenId) return null;
  const map = tokenMap || {};
  const hintedOutcome = normalizeOutcomeKey(outcomeHintRaw);

  if (tokenId === map?.legacy?.YES) return { kind: 'legacy', outcome: 'YES' };
  if (tokenId === map?.legacy?.NO) return { kind: 'legacy', outcome: 'NO' };
  if (tokenId === map?.tradable?.YES) return { kind: 'tradable', outcome: 'YES' };
  if (tokenId === map?.tradable?.NO) return { kind: 'tradable', outcome: 'NO' };

  if (hintedOutcome && map?.legacy?.[hintedOutcome]) {
    return { kind: 'legacy', outcome: hintedOutcome };
  }
  return null;
}

async function mergeLegacyUsdcPair(conditionIdRaw, sharesBase) {
  const conditionId = normalizeConditionIdOrThrow(conditionIdRaw);
  return await sendWithAdaptiveApprovalGas(
    'mergeLegacyUsdcPair',
    async (overrides) => ctfContract.mergePositions(
      USDC_ADDRESS,
      PARENT_COLLECTION_ID,
      conditionId,
      BINARY_PARTITION,
      sharesBase,
      overrides
    ),
    {
      type: 'merge-legacy-usdc',
      conditionId,
      sharesBase: sharesBase.toString()
    }
  );
}

async function splitNegRiskToTradable(conditionIdRaw, amountBase) {
  const conditionId = normalizeConditionIdOrThrow(conditionIdRaw);
  return await sendWithAdaptiveApprovalGas(
    'splitNegRiskToTradable',
    async (overrides) => negRiskAdapterContract['splitPosition(address,bytes32,bytes32,uint256[],uint256)'](
      USDC_ADDRESS,
      PARENT_COLLECTION_ID,
      conditionId,
      BINARY_PARTITION,
      amountBase,
      overrides
    ),
    {
      type: 'split-negrisk',
      conditionId,
      amountBase: amountBase.toString()
    }
  );
}

async function mergeNegRiskTradable(conditionIdRaw, amountBase) {
  const conditionId = normalizeConditionIdOrThrow(conditionIdRaw);
  await ensureErc1155ApprovalFor(NEG_RISK_ADAPTER);
  return await sendWithAdaptiveApprovalGas(
    'mergeNegRiskTradable',
    async (overrides) => negRiskAdapterContract['mergePositions(address,bytes32,bytes32,uint256[],uint256)'](
      USDC_ADDRESS,
      PARENT_COLLECTION_ID,
      conditionId,
      BINARY_PARTITION,
      amountBase,
      overrides
    ),
    {
      type: 'merge-negrisk',
      conditionId,
      amountBase: amountBase.toString()
    }
  );
}

function shouldAttemptNegRiskSellFallback(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('no bid price available') ||
    message.includes('no orderbook exists for the requested token id') ||
    message.includes('404') && message.includes('orderbook')
  );
}

async function executeNegRiskLegacySellFallback({ tokenId, sharesBase, conditionId, outcomeHint }) {
  const normalizedConditionId = normalizeConditionIdOrThrow(conditionId);
  const ctx = createContext('polymarket', 'executeNegRiskLegacySellFallback');

  const market = await fetchGammaMarketByConditionId(normalizedConditionId);
  if (!market?.isNegRisk) {
    return null;
  }

  const tokenMap = await getNegRiskTokenMappingByCondition(normalizedConditionId);
  const tokenInfo = resolveTokenKindInNegRiskMap(tokenId, tokenMap, outcomeHint);
  if (!tokenInfo || tokenInfo.kind !== 'legacy') {
    return null;
  }

  const side = tokenInfo.outcome;
  const oppositeSide = side === 'YES' ? 'NO' : 'YES';
  const oppositeLegacyTokenId = tokenMap.legacy[oppositeSide];
  const tradableTokenId = tokenMap.tradable[side];

  const owner = await getSignerAddress(currentSigner);
  const oppositeBalanceRaw = await ctfContract.balanceOf(owner, oppositeLegacyTokenId);
  const oppositeBalance = BigInt(oppositeBalanceRaw.toString());
  if (oppositeBalance < sharesBase) {
    throw new Error(
      `Alternative sell requires opposite ${oppositeSide} balance >= ${formatSharesFromBase(sharesBase)} shares`
    );
  }

  safeLogInfo(ctx, 'Executing negRisk alternative sell path', {
    conditionId: normalizedConditionId,
    sourceTokenId: String(tokenId || '').trim(),
    tradableTokenId,
    side,
    sharesBase: sharesBase.toString()
  });

  await mergeLegacyUsdcPair(normalizedConditionId, sharesBase);
  await splitNegRiskToTradable(normalizedConditionId, sharesBase);

  try {
    const result = await placeMarketSellFOK(tradableTokenId, sharesBase);
    safeLogInfo(ctx, 'NegRisk alternative sell completed', {
      conditionId: normalizedConditionId,
      sourceTokenId: String(tokenId || '').trim(),
      tradedTokenId: tradableTokenId
    });
    return {
      ...result,
      fallbackPath: 'neg-risk-legacy-convert-and-sell',
      sourceTokenId: String(tokenId || '').trim(),
      tradedTokenId: tradableTokenId
    };
  } catch (sellError) {
    let rollbackSucceeded = false;
    try {
      await mergeNegRiskTradable(normalizedConditionId, sharesBase);
      rollbackSucceeded = true;
    } catch {}

    if (rollbackSucceeded) {
      throw sellError;
    }
    throw new Error(
      `Alternative sell failed and rollback failed: ${String(sellError?.message || sellError)}`
    );
  }
}

// Set all required allowances (one-time setup)
export async function setAllAllowances(signer) {
  const { usdcContract: usdc, ctfContract: ctf } = await initContracts(
    signer,
    getPolygonRpcUrl()
  );
  const owner = await getSignerAddress(signer);

  const results = [];

  // 1) USDC -> CTF Contract (for split)
  const allowanceSplit = await usdc.allowance(owner, CTF_ADDRESS);
  if (isBelowMinAmount(allowanceSplit, MIN_USDC_ALLOWANCE_BASE)) {
    const ctx = createContext('polymarket', 'setAllAllowances');
    safeLogInfo(ctx, 'Setting USDC allowance for CTF Contract', {
      minAllowanceUSDC: MIN_USDC_ALLOWANCE_USDC
    });
    const receipt1 = await sendWithAdaptiveApprovalGas(
      'setAllAllowances',
      async (overrides) => usdc.approve(CTF_ADDRESS, ethers.constants.MaxUint256, overrides),
      { type: 'USDC->CTF' }
    );
    results.push({ type: 'USDC->CTF', hash: receipt1.hash });
  }

  // 2) USDC -> CTF Exchange (standard markets)
  const allowanceExchange = await usdc.allowance(owner, CTF_EXCHANGE_ADDRESS);
  if (isBelowMinAmount(allowanceExchange, MIN_USDC_ALLOWANCE_BASE)) {
    const ctx = createContext('polymarket', 'setAllAllowances');
    safeLogInfo(ctx, 'Setting USDC allowance for CTF Exchange', {
      minAllowanceUSDC: MIN_USDC_ALLOWANCE_USDC
    });
    const receipt2 = await sendWithAdaptiveApprovalGas(
      'setAllAllowances',
      async (overrides) => usdc.approve(CTF_EXCHANGE_ADDRESS, ethers.constants.MaxUint256, overrides),
      { type: 'USDC->Exchange' }
    );
    results.push({ type: 'USDC->Exchange', hash: receipt2.hash });
  }

  // 3) USDC -> Neg Risk Exchange (negRisk markets)
  const allowanceNegRiskExchange = await usdc.allowance(owner, NEG_RISK_CTF_EXCHANGE);
  if (isBelowMinAmount(allowanceNegRiskExchange, MIN_USDC_ALLOWANCE_BASE)) {
    const ctx = createContext('polymarket', 'setAllAllowances');
    safeLogInfo(ctx, 'Setting USDC allowance for Neg Risk Exchange', {
      minAllowanceUSDC: MIN_USDC_ALLOWANCE_USDC
    });
    const receipt3 = await sendWithAdaptiveApprovalGas(
      'setAllAllowances',
      async (overrides) => usdc.approve(NEG_RISK_CTF_EXCHANGE, ethers.constants.MaxUint256, overrides),
      { type: 'USDC->NegRiskExchange' }
    );
    results.push({ type: 'USDC->NegRiskExchange', hash: receipt3.hash });
  }

  // 4) USDC -> Neg Risk Adapter (some negRisk settlement paths)
  const allowanceNegRiskAdapter = await usdc.allowance(owner, NEG_RISK_ADAPTER);
  if (isBelowMinAmount(allowanceNegRiskAdapter, MIN_USDC_ALLOWANCE_BASE)) {
    const ctx = createContext('polymarket', 'setAllAllowances');
    safeLogInfo(ctx, 'Setting USDC allowance for Neg Risk Adapter', {
      minAllowanceUSDC: MIN_USDC_ALLOWANCE_USDC
    });
    const receipt4 = await sendWithAdaptiveApprovalGas(
      'setAllAllowances',
      async (overrides) => usdc.approve(NEG_RISK_ADAPTER, ethers.constants.MaxUint256, overrides),
      { type: 'USDC->NegRiskAdapter' }
    );
    results.push({ type: 'USDC->NegRiskAdapter', hash: receipt4.hash });
  }

  // 5) ERC1155 approval for standard exchange
  const isApproved = await ctf.isApprovedForAll(owner, CTF_EXCHANGE_ADDRESS);
  if (!isApproved) {
    const ctx = createContext('polymarket', 'setAllAllowances');
    safeLogInfo(ctx, 'Setting ERC1155 approval for standard exchange');
    const receipt5 = await sendWithAdaptiveApprovalGas(
      'setAllAllowances',
      async (overrides) => ctf.setApprovalForAll(CTF_EXCHANGE_ADDRESS, true, overrides),
      { type: 'ERC1155->Exchange' }
    );
    results.push({ type: 'ERC1155->Exchange', hash: receipt5.hash });
  }

  // 6) ERC1155 approval for negRisk exchange
  const isApprovedNegRisk = await ctf.isApprovedForAll(owner, NEG_RISK_CTF_EXCHANGE);
  if (!isApprovedNegRisk) {
    const ctx = createContext('polymarket', 'setAllAllowances');
    safeLogInfo(ctx, 'Setting ERC1155 approval for Neg Risk Exchange');
    const receipt6 = await sendWithAdaptiveApprovalGas(
      'setAllAllowances',
      async (overrides) => ctf.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true, overrides),
      { type: 'ERC1155->NegRiskExchange' }
    );
    results.push({ type: 'ERC1155->NegRiskExchange', hash: receipt6.hash });
  }

  // 7) ERC1155 approval for negRisk adapter (required for adapter merge paths)
  const isApprovedNegRiskAdapter = await ctf.isApprovedForAll(owner, NEG_RISK_ADAPTER);
  if (!isApprovedNegRiskAdapter) {
    const ctx = createContext('polymarket', 'setAllAllowances');
    safeLogInfo(ctx, 'Setting ERC1155 approval for Neg Risk Adapter');
    const receipt7 = await sendWithAdaptiveApprovalGas(
      'setAllAllowances',
      async (overrides) => ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, overrides),
      { type: 'ERC1155->NegRiskAdapter' }
    );
    results.push({ type: 'ERC1155->NegRiskAdapter', hash: receipt7.hash });
  }

  // After setting on-chain allowances, refresh CLOB collateral allowance
  if (clobClient) {
    try {
      const ctx = createContext('polymarket', 'setAllAllowances');
      safeLogInfo(ctx, 'Refreshing CLOB collateral allowance');
      await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const clobCollateral = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      safeLogInfo(ctx, 'CLOB collateral status after refresh', {
        balance: clobCollateral?.balance || '0',
        allowance: clobCollateral?.allowance || '0'
      });
    } catch (refreshError) {
      const ctx = createContext('polymarket', 'setAllAllowances');
      safeLogWarn(ctx, 'Failed to refresh CLOB collateral allowance', { error: refreshError.message });
    }
  }

  return results;
}

// Get on-chain USDC allowances for diagnostic purposes
// Returns allowances for all known spenders
export async function getOnchainAllowancesUSDC(owner) {
  if (!usdcContract) {
    throw new Error('Contracts not initialized. Call initContracts() first.');
  }

  const spenders = [
    { name: 'CTF Contract', address: CTF_ADDRESS },
    { name: 'CTF Exchange', address: CTF_EXCHANGE_ADDRESS },
    { name: 'Neg Risk Exchange', address: NEG_RISK_CTF_EXCHANGE },
    { name: 'Neg Risk Adapter', address: NEG_RISK_ADAPTER }
  ];

  const results = [];
  for (const spender of spenders) {
    try {
      const allowance = await usdcContract.allowance(owner, spender.address);
      results.push({
        name: spender.name,
        address: spender.address,
        allowance: allowance.toString()
      });
    } catch (error) {
      results.push({
        name: spender.name,
        address: spender.address,
        allowance: '0',
        error: error.message
      });
    }
  }

  return results;
}

// Split: USDC в†’ YES + NO
// amountUSDCBase: bigint amount in micro USDC (use parseUSDCToBase)
// conditionId: bytes32 condition ID from market
// Returns: transaction receipt with hash
export async function split(conditionId, amountUSDCBase, options = {}) {
  if (!ctfContract) {
    throw new Error('Contracts not initialized. Call initContracts() first.');
  }
  
  if (typeof amountUSDCBase !== 'bigint') {
    throw new Error('amountUSDCBase must be bigint');
  }

  const normalizedConditionId = normalizeConditionIdOrThrow(conditionId);
  const useNegRiskAdapter = options?.negRisk === true;

  if (useNegRiskAdapter) {
    await ensureNegRiskAdapterReady();
    return await splitNegRiskToTradable(normalizedConditionId, amountUSDCBase);
  }
  
  return await sendWithAdaptiveApprovalGas(
    'split',
    async (overrides) => ctfContract.splitPosition(
      USDC_ADDRESS,
      PARENT_COLLECTION_ID,
      normalizedConditionId,
      BINARY_PARTITION, // [1, 2] - YES=1, NO=2
      amountUSDCBase,
      overrides
    ),
    {
      type: 'split',
      conditionId: normalizedConditionId,
      amountUSDCBase: amountUSDCBase.toString()
    }
  );
}

// Helper to safely resolve signer address (handles both Wallet and abstract Signer)
async function getSignerAddress(signer) {
  if (signer.address && typeof signer.address === 'string' && signer.address.length > 0) {
    return signer.address;
  }
  if (typeof signer.getAddress === 'function') {
    return await signer.getAddress();
  }
  throw new Error('Signer has no address: provide a Wallet/Signer with getAddress()');
}

// Merge: YES + NO в†’ USDC
// sharesBase: bigint amount of shares in base units (use parseSharesToBase)
// conditionId: bytes32 condition ID from market
// Returns: transaction receipt with hash
export async function merge(conditionId, sharesBase, options = {}) {
  if (!currentSigner) {
    throw new Error('Contracts not initialized: call initContracts(signer) first.');
  }
  
  if (typeof sharesBase !== 'bigint') {
    throw new Error('sharesBase must be bigint');
  }

  const normalizedConditionId = normalizeConditionIdOrThrow(conditionId);
  let useNegRiskAdapter = options?.negRisk === true;

  if (options?.sourceTokenId) {
    try {
      const tokenMap = await getNegRiskTokenMappingByCondition(normalizedConditionId);
      const tokenInfo = resolveTokenKindInNegRiskMap(options.sourceTokenId, tokenMap);
      if (tokenInfo?.kind === 'tradable') useNegRiskAdapter = true;
      if (tokenInfo?.kind === 'legacy') useNegRiskAdapter = false;
    } catch {}
  }

  if (useNegRiskAdapter) {
    await ensureNegRiskAdapterReady();
    return await mergeNegRiskTradable(normalizedConditionId, sharesBase);
  }
  
  // Check if CTF Exchange is approved to transfer conditional tokens
  const owner = await getSignerAddress(currentSigner);
  const isApproved = await ctfContract.isApprovedForAll(
    owner,
    CTF_EXCHANGE_ADDRESS
  );
  
  if (!isApproved) {
    const ctx = createContext('polymarket', 'merge');
    safeLogInfo(ctx, 'Setting ERC1155 approval for conditional tokens');
    await sendWithAdaptiveApprovalGas(
      'merge',
      async (overrides) => ctfContract.setApprovalForAll(CTF_EXCHANGE_ADDRESS, true, overrides),
      { type: 'ERC1155->Exchange' }
    );
  }
  
  return await sendWithAdaptiveApprovalGas(
    'merge',
    async (overrides) => ctfContract.mergePositions(
      USDC_ADDRESS,
      PARENT_COLLECTION_ID,
      normalizedConditionId,
      BINARY_PARTITION,
      sharesBase,
      overrides
    ),
    {
      type: 'merge',
      conditionId: normalizedConditionId,
      sharesBase: sharesBase.toString()
    }
  );
}

// Redeem: winning tokens в†’ USDC (outcome determined from Gamma API)
export async function redeem(conditionId) {
  if (!ctfContract) {
    throw new Error('Contracts not initialized. Call initContracts() first.');
  }

  const normalizedConditionId = toNonEmptyString(conditionId);
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalizedConditionId)) {
    throw new Error('conditionId must be a 32-byte hex string');
  }

  return await sendWithAdaptiveApprovalGas(
    'redeem',
    async (overrides) => ctfContract.redeemPositions(
      USDC_ADDRESS,
      PARENT_COLLECTION_ID,
      normalizedConditionId,
      BINARY_PARTITION,
      overrides
    ),
    {
      type: 'redeem',
      conditionId: normalizedConditionId,
      indexSets: BINARY_PARTITION.join(',')
    }
  );
}

