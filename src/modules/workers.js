import { loadConfig } from './config.js';
import { getDecryptedPrivateKey, getDecryptedL2Credentials } from './auth.js';
import { sendNotification, sendPriceAlertNotification, sendStrategyMarketAlertNotification } from './bot/bot.js';
import {
  initClient,
  getPositions as getApiPositions,
  getOrders as getApiOpenOrders,
  getBestBidAsk,
  parsePriceToMicro,
  formatPriceFromMicro,
  parseSharesToBase,
  formatSharesFromBase,
  createOrder,
  cancelOrder,
  placeMarketSellFOK
} from './polymarket.js';
import { createStrategyMarketWatcher } from './strategyMarketWatcher.js';
import {
  replacePositionsSnapshot,
  getPositions as getDbPositions,
  getTrackedOrders,
  cleanupInvalidTrackedOrders,
  cleanupUnmanagedOrders,
  getOrderById,
  upsertOrderStatus,
  updateOrderStatus,
  getActiveStrategies,
  updateStrategy,
  getPriceAlert,
  updatePriceAlert
} from './database.js';
import { Wallet } from 'ethers';
import { DATA_API_URL } from './constants.js';
import { createContext, safeLogError, safeLogWarn, safeLogInfo, retry } from './logger.js';

const MINUTE_MS = 60 * 1000;
const DEFAULT_SYNC_POSITIONS_MS = 60 * MINUTE_MS;
const DEFAULT_MONITOR_MS = 45 * 1000;
const DEFAULT_PRICE_ALERT_COOLDOWN_MS = 5 * MINUTE_MS;
const DEFAULT_WORKER_HEALTH_LOG_MS = 10 * MINUTE_MS;

const workerTimers = new Map();
const workerRunning = new Set();
const workerMetrics = new Map();
let workersStarted = false;

const runtime = {
  initialized: false,
  walletAddress: '',
  chatId: '',
  initPromise: null
};

const strategyMarketWatcher = createStrategyMarketWatcher({
  onAlert: async (payload) => {
    if (!runtime.chatId) return;
    await sendStrategyMarketAlertNotification(runtime.chatId, payload);
  },
  onLog: (level, message, extra = {}) => {
    const ctx = createContext('workers', 'strategyMarketWatcher');
    if (level === 'info') {
      safeLogInfo(ctx, message, extra);
      return;
    }
    safeLogWarn(ctx, message, extra);
  }
});

function ensureWorkerMetric(name) {
  if (!workerMetrics.has(name)) {
    workerMetrics.set(name, {
      runs: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      skippedDueToOverlap: 0,
      isRunning: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastDurationMs: null,
      lastErrorName: null,
      lastErrorMessage: null
    });
  }
  return workerMetrics.get(name);
}

function summarizeWorkerError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Unknown worker error')
  };
}

export function getWorkersHealthSnapshot() {
  const workers = {};
  for (const [name, metric] of workerMetrics.entries()) {
    workers[name] = { ...metric };
  }

  return {
    timestamp: nowIso(),
    workersStarted,
    runtime: {
      initialized: runtime.initialized,
      walletAddress: runtime.walletAddress || null,
      notificationsChatConfigured: Boolean(runtime.chatId)
    },
    running: Array.from(workerRunning),
    scheduled: Array.from(workerTimers.keys()),
    workers
  };
}

function parseIntervalEnv(name, fallbackMs) {
  const raw = process.env[name];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallbackMs;
  return Math.floor(value);
}

function toBigIntSafe(value, fallback = 0n) {
  try {
    return BigInt(value?.toString?.() ?? value);
  } catch {
    return fallback;
  }
}

function parseSharesBaseSafe(value) {
  if (value === null || value === undefined) return 0n;
  const raw = String(value).trim();
  if (!raw) return 0n;
  try {
    return parseSharesToBase(raw);
  } catch {
    return 0n;
  }
}

function parsePriceMicroSafe(value) {
  if (value === null || value === undefined) return 0n;
  const cleaned = String(value).replace(/[^0-9.,]/g, '').trim();
  if (!cleaned) return 0n;
  try {
    return parsePriceToMicro(cleaned.replace(',', '.'));
  } catch {
    return 0n;
  }
}

function hasFieldValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

function readOrderSizeBase(order, keys) {
  const source = order || {};
  for (const key of keys) {
    if (!(key in source)) continue;
    const raw = source[key];
    if (!hasFieldValue(raw)) {
      return { hasField: true, value: 0n };
    }
    return { hasField: true, value: parseSharesBaseSafe(raw) };
  }
  return { hasField: false, value: 0n };
}

function getRecordUniqueKey(record, index, prefix) {
  const idCandidates = [
    record?.id,
    record?.trade_id,
    record?.tradeId,
    record?.activity_id,
    record?.activityId,
    record?.tx_hash,
    record?.txHash,
    record?.hash
  ];

  for (const value of idCandidates) {
    const normalized = String(value ?? '').trim();
    if (normalized) return `${prefix}:${normalized}`;
  }

  return `${prefix}:idx:${index}:${JSON.stringify(record || {})}`;
}

function extractFilledSizeBaseFromRecord(record) {
  const fields = [
    'size',
    'filled_size',
    'filledSize',
    'matched_size',
    'matchedSize',
    'trade_size',
    'tradeSize',
    'maker_size',
    'makerSize',
    'taker_size',
    'takerSize',
    'order_size',
    'orderSize',
    'base_size',
    'baseSize'
  ];

  for (const field of fields) {
    if (!(field in (record || {}))) continue;
    const parsed = parseSharesBaseSafe(record[field]);
    if (parsed > 0n) return parsed;
  }

  return 0n;
}

function sumFilledSizeFromRecords(records, seen, prefix) {
  const list = Array.isArray(records) ? records : [];
  let total = 0n;
  let hasEvidence = false;

  for (let index = 0; index < list.length; index += 1) {
    const record = list[index];
    const key = getRecordUniqueKey(record, index, prefix);
    if (seen.has(key)) continue;
    seen.add(key);

    hasEvidence = true;
    total += extractFilledSizeBaseFromRecord(record);
  }

  return { total, hasEvidence };
}

async function fetchFilledSizeFromDataApi(orderId, walletAddress) {
  const orderIdVariants = ['order_id', 'orderId', 'id'];
  const seen = new Set();
  let total = 0n;
  let hasEvidence = false;

  for (const key of orderIdVariants) {
    try {
      const trades = await fetchDataApiList('/trades', { [key]: orderId, user: walletAddress });
      const aggregated = sumFilledSizeFromRecords(trades, seen, `trades:${key}`);
      total += aggregated.total;
      hasEvidence = hasEvidence || aggregated.hasEvidence;
    } catch {}
  }

  if (hasEvidence) {
    return { filledSizeBase: total, hasEvidence: true };
  }

  for (const key of orderIdVariants) {
    try {
      const activity = await fetchDataApiList('/activity', { [key]: orderId, user: walletAddress });
      const aggregated = sumFilledSizeFromRecords(activity, seen, `activity:${key}`);
      total += aggregated.total;
      hasEvidence = hasEvidence || aggregated.hasEvidence;
    } catch {}
  }

  return { filledSizeBase: total, hasEvidence };
}

function getOrderId(order) {
  const candidates = [order?.id, order?.orderID, order?.orderId, order?.order_id];
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
}

function parseOrderIds(value) {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrderId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function parseStrategyOrderPair(value) {
  const raw = String(value ?? '').trim();
  const pair = { yes: '', no: '' };
  const extra = [];

  if (!raw) {
    return { ...pair, allIds: [] };
  }

  if (raw.includes('yes:') || raw.includes('no:')) {
    const parts = raw
      .split(';')
      .map((part) => String(part).trim())
      .filter(Boolean);

    for (const part of parts) {
      if (part.startsWith('yes:')) {
        pair.yes = normalizeOrderId(part.slice(4));
      } else if (part.startsWith('no:')) {
        pair.no = normalizeOrderId(part.slice(3));
      } else {
        const normalized = normalizeOrderId(part);
        if (normalized) extra.push(normalized);
      }
    }
  } else {
    const ids = parseOrderIds(raw);
    if (ids.length > 0) pair.yes = ids[0];
    if (ids.length > 1) pair.no = ids[1];
    if (ids.length > 2) extra.push(...ids.slice(2));
  }

  const allIds = dedupeTokens([pair.yes, pair.no, ...extra]);
  return { ...pair, allIds };
}

function encodeStrategyOrderPair(pair) {
  const yes = normalizeOrderId(pair?.yes);
  const no = normalizeOrderId(pair?.no);
  if (!yes && !no) return null;
  return `yes:${yes};no:${no}`;
}

function getOrderStatusById(orderId, rowById, openOrderIds) {
  const id = normalizeOrderId(orderId);
  if (!id) return 'missing';
  const row = rowById.get(id);

  if (openOrderIds.has(id)) {
    const status = String(row?.status || '').toLowerCase();
    if (status === 'partially_filled' || status === 'partial') return 'partially_filled';
    return 'open';
  }

  const status = String(row?.status || '').toLowerCase();
  if (!status) return 'missing';
  if (status === 'partial') return 'partially_filled';
  return status;
}

function isSafeCancelOrderFailure(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('not found') ||
    message.includes('already cancelled') ||
    message.includes('already canceled') ||
    message.includes('already filled') ||
    message.includes('not open')
  );
}

async function cancelOrderAndMark(orderId, options = {}) {
  const id = normalizeOrderId(orderId);
  if (!id) return;
  const strictCancel = options?.strictCancel === true;
  try {
    await cancelOrder(id);
  } catch (error) {
    const ctx = createContext('workers', 'cancelOrderAndMark');
    safeLogWarn(ctx, 'Cancel order failed', {
      orderId: id,
      message: error?.message
    });
    if (strictCancel && !isSafeCancelOrderFailure(error)) {
      throw new Error(`Cancel order failed for ${id}: ${error?.message || error}`);
    }
  }
  try {
    await updateOrderStatus(id, 'cancelled');
  } catch (error) {
    const ctx = createContext('workers', 'cancelOrderAndMark');
    safeLogWarn(ctx, 'Failed to mark order as cancelled in DB', {
      orderId: id,
      message: error?.message
    });
  }
}

async function getOrdersByIds(orderIds) {
  const ids = Array.isArray(orderIds) ? orderIds : [];
  const rows = [];
  for (const id of ids) {
    const row = await getOrderById(id);
    if (row) rows.push(row);
  }
  return rows;
}

function getOrdersAggregateStatus(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'missing';
  if (rows.some((row) => row.status === 'filled')) return 'filled';
  if (rows.some((row) => row.status === 'partially_filled')) return 'partially_filled';
  if (rows.some((row) => row.status === 'open')) return 'open';
  if (rows.every((row) => row.status === 'cancelled')) return 'cancelled';
  return 'unknown';
}

function dedupeTokens(tokens) {
  return Array.from(new Set((Array.isArray(tokens) ? tokens : []).filter(Boolean)));
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

function nowIso() {
  return new Date().toISOString();
}

async function fetchOpenOrdersWithRetry(actionName) {
  try {
    return await retry(async () => {
      const response = await getApiOpenOrders(runtime.walletAddress);
      if (Array.isArray(response)) return response;
      if (Array.isArray(response?.data)) return response.data;
      throw new Error('CLOB open-orders response is not an array');
    }, 3, 750);
  } catch (error) {
    const ctx = createContext('workers', actionName);
    safeLogWarn(ctx, 'Open-orders fetch failed after retries, skipping this cycle', {
      message: error?.message
    });
    return null;
  }
}

async function ensureClientInitialized() {
  if (runtime.initialized) return;
  if (runtime.initPromise) {
    await runtime.initPromise;
    return;
  }

  runtime.initPromise = (async () => {
    const config = await loadConfig();
    if (!config.walletAddress) {
      throw new Error('Workers require configured wallet (walletAddress is missing)');
    }

    const privateKey = await getDecryptedPrivateKey();
    const l2Creds = await getDecryptedL2Credentials();
    const signer = new Wallet(privateKey);

    await initClient(privateKey, l2Creds);

    runtime.initialized = true;
    runtime.walletAddress = config.walletAddress.toLowerCase();
    runtime.chatId = process.env.WORKERS_NOTIFICATIONS_CHAT_ID || process.env.TELEGRAM_ALLOWED_USER_ID || '';

    const ctx = createContext('workers', 'ensureClientInitialized');
    safeLogInfo(ctx, 'Workers runtime initialized', {
      walletAddress: runtime.walletAddress,
      notificationsChatConfigured: Boolean(runtime.chatId)
    });

    void signer;
  })();

  try {
    await runtime.initPromise;
  } finally {
    runtime.initPromise = null;
  }
}

async function sendWorkerNotification(message, options = {}) {
  if (!runtime.chatId) return;
  try {
    await sendNotification(runtime.chatId, message, options);
  } catch (error) {
    const ctx = createContext('workers', 'sendWorkerNotification');
    safeLogWarn(ctx, 'Failed to send worker notification', { message: error?.message });
  }
}

function resolvePriceAlertCooldownMs(config) {
  const notifications = config?.notifications || {};
  const rawSeconds = Number(
    notifications.alertCooldownSeconds ??
      notifications.priceAlertCooldownSeconds
  );
  if (!Number.isFinite(rawSeconds) || rawSeconds < 0) {
    return DEFAULT_PRICE_ALERT_COOLDOWN_MS;
  }
  return Math.floor(rawSeconds * 1000);
}

async function fetchDataApiList(path, params = {}) {
  const url = new URL(`${DATA_API_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Data API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function resolveMissingOrderStatus(orderId, walletAddress) {
  const orderIdVariants = ['order_id', 'orderId', 'id'];
  const seen = new Set();
  let filledSizeBase = 0n;
  let hasTradesEvidence = false;
  let hasActivityEvidence = false;
  let hasFillLikeActivity = false;
  let anyRequestSucceeded = false;

  for (const key of orderIdVariants) {
    try {
      const trades = await fetchDataApiList('/trades', { [key]: orderId, user: walletAddress });
      anyRequestSucceeded = true;
      const aggregated = sumFilledSizeFromRecords(trades, seen, `missing:trades:${key}`);
      if (aggregated.hasEvidence) {
        hasTradesEvidence = true;
        filledSizeBase += aggregated.total;
      }
    } catch {}
  }

  for (const key of orderIdVariants) {
    try {
      const activity = await fetchDataApiList('/activity', { [key]: orderId, user: walletAddress });
      anyRequestSucceeded = true;
      const aggregated = sumFilledSizeFromRecords(activity, seen, `missing:activity:${key}`);
      if (aggregated.hasEvidence) {
        hasActivityEvidence = true;
        filledSizeBase += aggregated.total;
      }
      if (Array.isArray(activity) && activity.some((entry) => isFillLikeActivity(entry))) {
        hasFillLikeActivity = true;
      }
    } catch {}
  }

  if (!anyRequestSucceeded) {
    return {
      status: 'unknown',
      evidence: 'data-api-unavailable',
      filledSizeBase: 0n
    };
  }

  if (hasTradesEvidence || filledSizeBase > 0n || hasFillLikeActivity) {
    return {
      status: 'filled',
      evidence: hasTradesEvidence ? 'trades' : (hasFillLikeActivity ? 'activity-fill-like' : 'filled-size'),
      filledSizeBase
    };
  }

  if (hasActivityEvidence) {
    return {
      status: 'unknown',
      evidence: 'activity-without-fill-signal',
      filledSizeBase: 0n
    };
  }

  return {
    status: 'cancelled',
    evidence: 'not-found-in-open-orders-and-no-trades',
    filledSizeBase: 0n
  };
}

function isFillLikeActivity(entry) {
  const fields = [
    entry?.type,
    entry?.event_type,
    entry?.eventType,
    entry?.action,
    entry?.status,
    entry?.state
  ];

  return fields.some((value) => {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return false;
    return text.includes('fill') || text.includes('match') || text.includes('trade') || text.includes('executed');
  });
}

function getPercentDiffBps(reference, current) {
  if (reference <= 0n) return 0n;
  const delta = current - reference;
  return (absBigInt(delta) * 10_000n) / reference;
}

function buildStrategyEntryPriceMap(strategies) {
  const map = new Map();
  const list = Array.isArray(strategies) ? strategies : [];
  for (const strategy of list) {
    const yesToken = String(strategy?.token_id_yes || '').trim();
    const noToken = String(strategy?.token_id_no || '').trim();
    const yesEntry = toBigIntSafe(strategy?.entry_price_yes_micro, 0n);
    const noEntry = toBigIntSafe(strategy?.entry_price_no_micro, 0n);

    // Keep first value only (active strategies are returned newest first).
    if (yesToken && yesEntry > 0n && !map.has(yesToken)) map.set(yesToken, yesEntry);
    if (noToken && noEntry > 0n && !map.has(noToken)) map.set(noToken, noEntry);
  }
  return map;
}

function applyPercentToPriceMicro(priceMicro, percent) {
  if (typeof priceMicro !== 'bigint' || priceMicro <= 0n) return 0n;
  const bps = Math.round(Number(percent) * 100);
  let adjusted = (priceMicro * BigInt(10_000 + bps)) / 10_000n;
  if (adjusted < 10_000n) adjusted = 10_000n;
  if (adjusted > 990_000n) adjusted = 990_000n;
  return adjusted;
}

function applyPercentToValue(value, percent) {
  if (typeof value !== 'bigint' || value <= 0n) return 0n;
  const bps = Math.round(Number(percent) * 100);
  const adjusted = (value * BigInt(10_000 + bps)) / 10_000n;
  return adjusted > 0n ? adjusted : 0n;
}

async function cancelOrdersAndMark(orderIds) {
  const ids = Array.isArray(orderIds) ? orderIds : [];
  for (const id of ids) {
    try {
      await cancelOrder(id);
    } catch {}
    try {
      await updateOrderStatus(id, 'cancelled');
    } catch {}
  }
}

async function createEmergencyStopLimit(strategy, tokenId, remainingQtyBase) {
  const created = await createOrder({
    tokenId,
    side: 'SELL',
    orderType: 'GTC',
    price: '0.010000',
    sizeShares: formatSharesFromBase(remainingQtyBase)
  });

  const orderId = getOrderId(created);
  if (!orderId) {
    throw new Error('STOP_LIMIT_ORDER_ID_MISSING');
  }
  await upsertOrderStatus({
    id: orderId,
    marketId: strategy.market_id || 'unknown-market',
    tokenId,
    side: 'sell',
    orderSide: 'limit',
    type: 'GTC',
    priceMicro: 10_000n,
    originalSizeBase: remainingQtyBase,
    remainingSizeBase: remainingQtyBase,
    filledSizeBase: 0n,
    status: 'open'
  });

  return orderId;
}

export async function syncPositionsWorker() {
  await ensureClientInitialized();

  const apiPositions = await getApiPositions(runtime.walletAddress);
  const snapshot = [];

  for (const pos of apiPositions) {
    const tokenId = String(pos.token_id || '').trim();
    if (!tokenId) continue;

    const quantityBase = parseSharesBaseSafe(pos.size);
    if (quantityBase <= 0n) continue;

    const avgPriceMicro = parsePriceMicroSafe(pos.avgPrice);
    const marketId = String(pos.market || pos.condition_id || pos.slug || tokenId);
    const side = String(pos.outcome || pos.side || 'unknown');

    snapshot.push({
      marketId,
      tokenId,
      side,
      quantityBase,
      avgPriceMicro
    });
  }

  await replacePositionsSnapshot(snapshot);

  const ctx = createContext('workers', 'syncPositionsWorker');
  safeLogInfo(ctx, 'Positions snapshot synchronized', { count: snapshot.length });
}

export async function monitorPricesWorker() {
  await ensureClientInitialized();

  const config = await loadConfig();
  const thresholdPercent = Number(config?.notifications?.priceChangePercent ?? 10);
  const thresholdBps = BigInt(Math.max(1, Math.round(thresholdPercent * 100)));
  const repeatStepPercent = Number(config?.notifications?.priceRepeatStepPercent ?? 2);
  const repeatStepBps = BigInt(Math.max(1, Math.round(repeatStepPercent * 100)));
  const alertCooldownMs = resolvePriceAlertCooldownMs(config);
  const strategyEntryPriceMap = buildStrategyEntryPriceMap(await getActiveStrategies());

  // Minimum thresholds for price alerts (same as display filter in positions.js)
  const MIN_DISPLAY_VALUE_USD = 0.01;
  const MIN_DISPLAY_SHARES_BASE = parseSharesToBase('0.01');

  const dbPositions = await getDbPositions();
  
  // Filter out dust positions
  const filteredPositions = dbPositions.filter(pos => {
    const sizeBase = parseSharesToBase(String(pos.size ?? pos.quantity ?? pos.amount ?? 0));
    const currentValue = Number(pos.currentValue ?? pos.current_value ?? 0);
    return sizeBase >= MIN_DISPLAY_SHARES_BASE || currentValue >= MIN_DISPLAY_VALUE_USD;
  });

  for (const pos of filteredPositions) {
    const tokenId = String(pos.token_id || '').trim();
    if (!tokenId) continue;

    const avgPriceMicro = toBigIntSafe(pos.avg_price_micro, 0n);
    const referencePriceMicro = strategyEntryPriceMap.get(tokenId) ?? avgPriceMicro;
    if (referencePriceMicro <= 0n) continue;

    let bestBidStr = null;
    let bestAskStr = null;
    try {
      ({ bestBidStr, bestAskStr } = await getBestBidAsk(tokenId));
    } catch (error) {
      const ctx = createContext('workers', 'monitorPricesWorker');
      safeLogWarn(ctx, 'Could not fetch orderbook for position', {
        tokenId,
        message: error?.message
      });
      continue;
    }

    const currentPriceMicro = parsePriceMicroSafe(bestBidStr || bestAskStr);
    if (currentPriceMicro <= 0n) continue;

    const diffBps = getPercentDiffBps(referencePriceMicro, currentPriceMicro);
    if (diffBps < thresholdBps) continue;

    const marketId = String(pos.market_id || 'unknown-market');
    const prevAlert = await getPriceAlert(marketId, tokenId);
    const prevPriceMicro = toBigIntSafe(prevAlert?.last_price_micro, 0n);
    // Do not resend the same alert payload if the price has not changed since last alert.
    if (prevPriceMicro > 0n && prevPriceMicro === currentPriceMicro) {
      continue;
    }
    if (prevPriceMicro > 0n) {
      const repeatDiffBps = getPercentDiffBps(prevPriceMicro, currentPriceMicro);
      if (repeatDiffBps < repeatStepBps) continue;
    }
    const now = Date.now();

    let shouldNotify = true;
    if (prevAlert?.last_alert_time) {
      const lastTs = new Date(prevAlert.last_alert_time).getTime();
      shouldNotify = Number.isFinite(lastTs) ? (now - lastTs >= alertCooldownMs) : true;
    }

    if (!shouldNotify) continue;

    const direction = currentPriceMicro >= referencePriceMicro ? '+' : '-';
    const pct = Number(diffBps) / 100;
    const sideLabel = String(pos.side || pos.outcome || 'unknown').trim() || 'unknown';
    try {
      await sendPriceAlertNotification(runtime.chatId, {
        market: marketId,
        side: sideLabel,
        direction,
        movePercent: pct,
        priceMicro: currentPriceMicro,
        referencePriceMicro
      });
    } catch (error) {
      const ctx = createContext('workers', 'monitorPricesWorker');
      safeLogWarn(ctx, 'Failed to send price-alert notification', {
        marketId,
        tokenId,
        message: error?.message
      });
    }
    await updatePriceAlert(marketId, tokenId, currentPriceMicro, new Date());
  }
}

export async function monitorStrategyMarketsWatcherWorker() {
  await ensureClientInitialized();
  const config = await loadConfig();
  await strategyMarketWatcher.tick({
    config,
    chatId: runtime.chatId
  });
}

export async function monitorOrdersWorker() {
  await ensureClientInitialized();
  const unmanagedCleanup = await cleanupUnmanagedOrders();
  if (unmanagedCleanup?.changes > 0) {
    const ctx = createContext('workers', 'monitorOrdersWorker');
    safeLogWarn(ctx, 'Removed unmanaged market/FOK orders from local cache', { count: unmanagedCleanup.changes });
  }
  const cleanup = await cleanupInvalidTrackedOrders();
  if (cleanup?.changes > 0) {
    const ctx = createContext('workers', 'monitorOrdersWorker');
    safeLogWarn(ctx, 'Removed invalid tracked orders with empty/null IDs', { count: cleanup.changes });
  }

  const openOrders = await fetchOpenOrdersWithRetry('monitorOrdersWorker');
  if (!openOrders) {
    return;
  }
  const openIds = new Set();

  for (const order of openOrders) {
    const orderId = getOrderId(order);
    if (!orderId) continue;
    openIds.add(orderId);
    const tracked = await getOrderById(orderId);

    const remainingInfo = readOrderSizeBase(order, ['remaining_size', 'remainingSize']);
    const originalInfo = readOrderSizeBase(order, ['original_size', 'originalSize', 'size', 'amount']);
    const filledInfo = readOrderSizeBase(order, ['filled_size', 'filledSize', 'size_matched', 'matched_size', 'matchedSize']);

    let effectiveOriginal = originalInfo.value;
    if (effectiveOriginal <= 0n) {
      effectiveOriginal = toBigIntSafe(tracked?.original_size_base, 0n);
    }

    let remainingSizeBase = remainingInfo.hasField ? remainingInfo.value : null;
    let filledSizeBase = filledInfo.hasField ? filledInfo.value : 0n;

    if (remainingSizeBase !== null && effectiveOriginal > 0n && effectiveOriginal > remainingSizeBase && filledSizeBase <= 0n) {
      filledSizeBase = effectiveOriginal - remainingSizeBase;
    }

    if (!remainingInfo.hasField) {
      const dataApiFill = await fetchFilledSizeFromDataApi(orderId, runtime.walletAddress);
      if (dataApiFill.filledSizeBase > filledSizeBase) {
        filledSizeBase = dataApiFill.filledSizeBase;
      }

      if (!dataApiFill.hasEvidence) {
        const ctx = createContext('workers', 'monitorOrdersWorker');
        safeLogWarn(ctx, 'Open order has no remaining size field and no fill evidence from Data API', {
          orderId
        });
      }
    }

    if (effectiveOriginal <= 0n) {
      if (remainingSizeBase !== null && remainingSizeBase > 0n) {
        effectiveOriginal = remainingSizeBase;
      } else if (filledSizeBase > 0n) {
        effectiveOriginal = filledSizeBase;
      }
    }

    if (effectiveOriginal > 0n && filledSizeBase > effectiveOriginal) {
      effectiveOriginal = filledSizeBase;
    }

    if (remainingSizeBase === null) {
      remainingSizeBase = effectiveOriginal > filledSizeBase ? (effectiveOriginal - filledSizeBase) : 0n;
    }
    if (remainingSizeBase < 0n) {
      remainingSizeBase = 0n;
    }
    if (filledSizeBase < 0n) {
      filledSizeBase = 0n;
    }

    if (effectiveOriginal > 0n && remainingSizeBase > effectiveOriginal) {
      remainingSizeBase = effectiveOriginal;
    }
    if (effectiveOriginal > 0n && filledSizeBase > effectiveOriginal) {
      filledSizeBase = effectiveOriginal;
    }
    if (effectiveOriginal > 0n && filledSizeBase === 0n && remainingSizeBase < effectiveOriginal) {
      filledSizeBase = effectiveOriginal - remainingSizeBase;
    }

    let status = 'open';
    if (effectiveOriginal > 0n && remainingSizeBase === 0n) {
      status = 'filled';
    } else if (filledSizeBase > 0n) {
      status = 'partially_filled';
    }

    await upsertOrderStatus({
      id: orderId,
      marketId: order.market || order.slug || 'unknown-market',
      tokenId: order.token_id || order.tokenId || 'unknown-token',
      side: String(order.side || '').toLowerCase() || 'unknown',
      orderSide: 'limit',
      type: 'GTC',
      priceMicro: parsePriceMicroSafe(order.price),
      originalSizeBase: effectiveOriginal,
      remainingSizeBase,
      filledSizeBase,
      status
    });
  }

  const trackedOrders = await getTrackedOrders();
  let hasClosedOrders = false;

  for (const tracked of trackedOrders) {
    const trackedId = String(tracked.id ?? '').trim();
    if (!trackedId || trackedId.toLowerCase() === 'null' || trackedId.toLowerCase() === 'undefined') {
      continue;
    }
    if (openIds.has(trackedId)) continue;

    const resolved = await resolveMissingOrderStatus(trackedId, runtime.walletAddress);
    const originalSizeBase = toBigIntSafe(tracked.original_size_base, 0n);
    const resolvedFilledBase = toBigIntSafe(resolved?.filledSizeBase, 0n);

    if (resolved.status === 'filled') {
      if (resolvedFilledBase > 0n && originalSizeBase > 0n && resolvedFilledBase < originalSizeBase) {
        await updateOrderStatus(trackedId, 'partially_filled', {
          remaining_size_base: originalSizeBase - resolvedFilledBase,
          filled_size_base: resolvedFilledBase
        });
        await sendWorkerNotification(`Order partially filled: ${trackedId}`);
      } else {
        const finalFilled = resolvedFilledBase > 0n ? resolvedFilledBase : originalSizeBase;
        await updateOrderStatus(trackedId, 'filled', {
          remaining_size_base: 0n,
          filled_size_base: finalFilled
        });
        await sendWorkerNotification(`Order filled: ${trackedId}`);
      }
    } else if (resolved.status === 'cancelled') {
      await updateOrderStatus(trackedId, 'cancelled', {
        remaining_size_base: toBigIntSafe(tracked.remaining_size_base, 0n)
      });
      await sendWorkerNotification(`Order cancelled: ${trackedId}`);
    } else {
      const ctx = createContext('workers', 'monitorOrdersWorker');
      safeLogWarn(ctx, 'Order disappeared from open-orders but fill/cancel status is uncertain', {
        orderId: trackedId,
        evidence: resolved?.evidence
      });
      continue;
    }
    hasClosedOrders = true;
  }

  if (hasClosedOrders) {
    await syncPositionsWorker();
  }
}

export async function monitorStrategiesWorker() {
  await ensureClientInitialized();

  const strategies = await getActiveStrategies();
  if (!Array.isArray(strategies) || strategies.length === 0) return;

  const liveOpenOrders = await fetchOpenOrdersWithRetry('monitorStrategiesWorker');
  if (!liveOpenOrders) {
    return;
  }
  const openOrderIds = new Set(
    (Array.isArray(liveOpenOrders) ? liveOpenOrders : [])
      .map((order) => getOrderId(order))
      .filter(Boolean)
  );

  const livePositions = await getApiPositions(runtime.walletAddress);
  const liveQtyByToken = new Map();
  for (const pos of livePositions) {
    const tokenId = String(pos.token_id || '').trim();
    if (!tokenId) continue;
    liveQtyByToken.set(tokenId, parseSharesBaseSafe(pos.size));
  }

  for (const strategy of strategies) {
    try {
      const yesToken = String(strategy.token_id_yes || '').trim();
      const noToken = String(strategy.token_id_no || '').trim();
      if (!yesToken || !noToken) continue;

      const stopLossPercent = Number(strategy.stop_loss_percent ?? 0) / 100;
      const entryPriceYesMicro = toBigIntSafe(strategy.entry_price_yes_micro, 0n);
      const entryPriceNoMicro = toBigIntSafe(strategy.entry_price_no_micro, 0n);

      const takePair = parseStrategyOrderPair(strategy.order_id_take);
      const stopPair = parseStrategyOrderPair(strategy.order_id_stop);
      const trackedOrderIds = dedupeTokens([...takePair.allIds, ...stopPair.allIds]);
      const trackedRows = await getOrdersByIds(trackedOrderIds);
      const rowById = new Map(
        trackedRows
          .map((row) => [normalizeOrderId(row?.id), row])
          .filter(([id]) => id)
      );

      const legs = [
        {
          key: 'yes',
          label: 'YES',
          tokenId: yesToken,
          entryPriceMicro: entryPriceYesMicro,
          qtyBase: liveQtyByToken.get(yesToken) || 0n,
          takeOrderId: normalizeOrderId(takePair.yes),
          stopOrderId: normalizeOrderId(stopPair.yes)
        },
        {
          key: 'no',
          label: 'NO',
          tokenId: noToken,
          entryPriceMicro: entryPriceNoMicro,
          qtyBase: liveQtyByToken.get(noToken) || 0n,
          takeOrderId: normalizeOrderId(takePair.no),
          stopOrderId: normalizeOrderId(stopPair.no)
        }
      ];

      const notifications = [];

      for (const leg of legs) {
        const takeStatus = getOrderStatusById(leg.takeOrderId, rowById, openOrderIds);
        const stopStatus = getOrderStatusById(leg.stopOrderId, rowById, openOrderIds);

        if (leg.stopOrderId && stopStatus === 'filled') {
          if (leg.takeOrderId) {
            try {
              await cancelOrderAndMark(leg.takeOrderId, { strictCancel: true });
            } catch (error) {
              const ctxLog = createContext('workers', 'monitorStrategiesWorker');
              safeLogWarn(ctxLog, 'Take-profit cancel failed after stop-loss fill; skipping market exit', {
                strategyId: strategy.id,
                leg: leg.key,
                tokenId: leg.tokenId,
                takeOrderId: leg.takeOrderId,
                message: error?.message
              });
              notifications.push(
                `Strategy ${strategy.id} ${leg.label} stop-loss filled, but TP cancel failed; manual check required`
              );
              continue;
            }
            leg.takeOrderId = '';
          }
          leg.stopOrderId = '';
          if (leg.qtyBase > 0n) {
            try {
              const result = await placeMarketSellFOK(leg.tokenId, leg.qtyBase);
              if (!result?.success) {
                throw new Error(result?.error || 'stop-loss completion market exit failed');
              }
              leg.qtyBase = 0n;
              liveQtyByToken.set(leg.tokenId, 0n);
            } catch (error) {
              const ctxLog = createContext('workers', 'monitorStrategiesWorker');
              safeLogWarn(ctxLog, 'Stop-loss fill market exit failed, trying emergency fallback stop', {
                strategyId: strategy.id,
                leg: leg.key,
                tokenId: leg.tokenId,
                message: error?.message
              });
              try {
                const fallbackId = await createEmergencyStopLimit(strategy, leg.tokenId, leg.qtyBase);
                leg.stopOrderId = fallbackId;
                notifications.push(
                  `Strategy ${strategy.id} ${leg.label} stop-loss filled; fallback stop order posted`
                );
              } catch (fallbackError) {
                safeLogWarn(ctxLog, 'Emergency stop-limit creation failed after stop-loss fill', {
                  strategyId: strategy.id,
                  leg: leg.key,
                  tokenId: leg.tokenId,
                  message: fallbackError?.message
                });
                notifications.push(
                  `Strategy ${strategy.id} ${leg.label} stop-loss filled; remaining qty requires manual check`
                );
              }
            }
          }
          if (leg.qtyBase <= 0n) {
            notifications.push(`Strategy ${strategy.id} ${leg.label} leg closed by stop-loss fill`);
          }
          continue;
        }

        if (leg.takeOrderId && takeStatus === 'filled') {
          if (leg.stopOrderId) {
            await cancelOrderAndMark(leg.stopOrderId);
            leg.stopOrderId = '';
          }
          leg.takeOrderId = '';

          if (leg.qtyBase > 0n) {
            try {
              const result = await placeMarketSellFOK(leg.tokenId, leg.qtyBase);
              if (!result?.success) {
                throw new Error(result?.error || 'take-profit completion market exit failed');
              }
              leg.qtyBase = 0n;
              liveQtyByToken.set(leg.tokenId, 0n);
            } catch (error) {
              const ctxLog = createContext('workers', 'monitorStrategiesWorker');
              safeLogWarn(ctxLog, 'Could not fully close remaining qty after take-profit fill', {
                strategyId: strategy.id,
                leg: leg.key,
                tokenId: leg.tokenId,
                message: error?.message
              });
              try {
                const fallbackId = await createEmergencyStopLimit(strategy, leg.tokenId, leg.qtyBase);
                leg.stopOrderId = fallbackId;
                notifications.push(
                  `Strategy ${strategy.id} ${leg.label} TP filled; fallback stop order posted`
                );
              } catch (fallbackError) {
                safeLogWarn(ctxLog, 'Emergency stop-limit creation failed after TP fill', {
                  strategyId: strategy.id,
                  leg: leg.key,
                  tokenId: leg.tokenId,
                  message: fallbackError?.message
                });
                notifications.push(
                  `Strategy ${strategy.id} ${leg.label} TP filled; remaining qty requires manual check`
                );
              }
            }
          } else {
            notifications.push(`Strategy ${strategy.id} ${leg.label} leg closed by take-profit fill`);
          }
          continue;
        }

        if (leg.qtyBase <= 0n) {
          if (leg.takeOrderId) {
            await cancelOrderAndMark(leg.takeOrderId);
            leg.takeOrderId = '';
          }
          if (leg.stopOrderId) {
            await cancelOrderAndMark(leg.stopOrderId);
            leg.stopOrderId = '';
          }
          continue;
        }

        if (leg.stopOrderId && (stopStatus === 'open' || stopStatus === 'partially_filled')) {
          continue;
        }

        if (leg.stopOrderId && stopStatus !== 'filled') {
          leg.stopOrderId = '';
        }

        if (stopLossPercent >= 0 || leg.entryPriceMicro <= 0n) {
          continue;
        }

        let currentPriceMicro = 0n;
        try {
          const { bestBidStr, bestAskStr } = await getBestBidAsk(leg.tokenId);
          currentPriceMicro = parsePriceMicroSafe(bestBidStr || bestAskStr);
        } catch (error) {
          const ctxLog = createContext('workers', 'monitorStrategiesWorker');
          safeLogWarn(ctxLog, 'Could not fetch current price for per-leg stop-loss check', {
            strategyId: strategy.id,
            leg: leg.key,
            tokenId: leg.tokenId,
            message: error?.message
          });
          continue;
        }

        const stopPriceMicro = applyPercentToPriceMicro(leg.entryPriceMicro, stopLossPercent);
        if (currentPriceMicro <= 0n || stopPriceMicro <= 0n || currentPriceMicro > stopPriceMicro) {
          continue;
        }

        if (leg.takeOrderId) {
          await cancelOrderAndMark(leg.takeOrderId);
          leg.takeOrderId = '';
        }

        try {
          const result = await placeMarketSellFOK(leg.tokenId, leg.qtyBase);
          if (!result?.success) {
            throw new Error(result?.error || 'stop-loss market exit failed');
          }
          leg.qtyBase = 0n;
          liveQtyByToken.set(leg.tokenId, 0n);
          leg.stopOrderId = '';
          notifications.push(
            `Strategy ${strategy.id} ${leg.label} stop-loss executed at ${formatPriceFromMicro(currentPriceMicro)}`
          );
        } catch (error) {
          const ctxLog = createContext('workers', 'monitorStrategiesWorker');
          safeLogWarn(ctxLog, 'Market SL exit failed, placing emergency limit stop for leg', {
            strategyId: strategy.id,
            leg: leg.key,
            tokenId: leg.tokenId,
            message: error?.message
          });
          try {
            const fallbackId = await createEmergencyStopLimit(strategy, leg.tokenId, leg.qtyBase);
            leg.stopOrderId = fallbackId;
            notifications.push(
              `Strategy ${strategy.id} ${leg.label} stop-loss triggered at ${formatPriceFromMicro(currentPriceMicro)} (fallback stop posted)`
            );
          } catch (fallbackError) {
            safeLogWarn(ctxLog, 'Emergency stop-limit creation failed for leg', {
              strategyId: strategy.id,
              leg: leg.key,
              tokenId: leg.tokenId,
              message: fallbackError?.message
            });
            notifications.push(
              `Strategy ${strategy.id} ${leg.label} stop-loss triggered but exit is incomplete; manual check required`
            );
          }
        }
      }

      const nextTake = encodeStrategyOrderPair({ yes: legs[0].takeOrderId, no: legs[1].takeOrderId });
      const nextStop = encodeStrategyOrderPair({ yes: legs[0].stopOrderId, no: legs[1].stopOrderId });
      const hasQty = legs.some((leg) => leg.qtyBase > 0n);
      const hasPendingOrders = legs.some((leg) => leg.takeOrderId || leg.stopOrderId);
      const nextStatus = hasQty || hasPendingOrders ? 'active' : 'closed';

      const currentTake = strategy.order_id_take ? String(strategy.order_id_take) : null;
      const currentStop = strategy.order_id_stop ? String(strategy.order_id_stop) : null;
      const shouldUpdate =
        String(strategy.status || '') !== nextStatus ||
        (currentTake || null) !== (nextTake || null) ||
        (currentStop || null) !== (nextStop || null);

      if (shouldUpdate) {
        await updateStrategy(strategy.id, {
          status: nextStatus,
          order_id_take: nextTake,
          order_id_stop: nextStop
        });
      }

      if (nextStatus === 'closed' && shouldUpdate) {
        notifications.push(`Strategy ${strategy.id} closed`);
      }

      for (const note of notifications) {
        await sendWorkerNotification(note);
      }
    } catch (error) {
      const ctxLog = createContext('workers', 'monitorStrategiesWorker');
      safeLogWarn(ctxLog, 'Strategy monitor cycle failed for one strategy', {
        strategyId: strategy?.id,
        message: error?.message
      });
    }
  }
}

async function runWorker(name, handler) {
  const metric = ensureWorkerMetric(name);
  if (workerRunning.has(name)) {
    metric.skippedDueToOverlap += 1;
    return;
  }

  const startedAtMs = Date.now();
  metric.runs += 1;
  metric.isRunning = true;
  metric.lastStartedAt = new Date(startedAtMs).toISOString();

  workerRunning.add(name);

  try {
    await handler();
    metric.successes += 1;
    metric.consecutiveFailures = 0;
    metric.lastSuccessAt = nowIso();
    metric.lastErrorName = null;
    metric.lastErrorMessage = null;
  } catch (error) {
    const summary = summarizeWorkerError(error);
    metric.failures += 1;
    metric.consecutiveFailures += 1;
    metric.lastFailureAt = nowIso();
    metric.lastErrorName = summary.name;
    metric.lastErrorMessage = summary.message;
    const ctx = createContext('workers', name);
    safeLogError(ctx, error);
  } finally {
    metric.isRunning = false;
    metric.lastFinishedAt = nowIso();
    metric.lastDurationMs = Date.now() - startedAtMs;
    workerRunning.delete(name);
  }
}

function scheduleWorker(name, intervalMs, handler, runImmediately = true) {
  const run = () => runWorker(name, handler);
  if (runImmediately) {
    run();
  }
  const timer = setInterval(run, intervalMs);
  workerTimers.set(name, timer);
}

export function startWorkers() {
  if (workersStarted) return;
  workersStarted = true;

  const syncPositionsMs = parseIntervalEnv('WORKER_SYNC_POSITIONS_MS', DEFAULT_SYNC_POSITIONS_MS);
  const monitorMs = parseIntervalEnv('WORKER_MONITOR_MS', DEFAULT_MONITOR_MS);
  const healthLogMs = parseIntervalEnv('WORKER_HEALTH_LOG_MS', DEFAULT_WORKER_HEALTH_LOG_MS);

  scheduleWorker('syncPositionsWorker', syncPositionsMs, syncPositionsWorker, true);
  scheduleWorker('monitorPricesWorker', monitorMs, monitorPricesWorker, true);
  scheduleWorker('monitorStrategyMarketsWatcherWorker', monitorMs, monitorStrategyMarketsWatcherWorker, true);
  scheduleWorker('monitorStrategiesWorker', monitorMs, monitorStrategiesWorker, true);
  scheduleWorker('monitorOrdersWorker', monitorMs, monitorOrdersWorker, false);
  scheduleWorker(
    'healthLogWorker',
    healthLogMs,
    async () => {
      const ctxHealth = createContext('workers', 'healthLogWorker');
      safeLogInfo(ctxHealth, 'Workers health snapshot', getWorkersHealthSnapshot());
    },
    false
  );

  const ctx = createContext('workers', 'startWorkers');
  safeLogInfo(ctx, 'Workers started', {
    syncPositionsMs,
    monitorMs,
    healthLogMs,
    health: getWorkersHealthSnapshot(),
    startedAt: nowIso()
  });
}

export function stopWorkers() {
  for (const timer of workerTimers.values()) {
    clearInterval(timer);
  }
  strategyMarketWatcher.shutdown().catch(() => {});
  workerTimers.clear();
  workerRunning.clear();
  workersStarted = false;

  const ctx = createContext('workers', 'stopWorkers');
  safeLogInfo(ctx, 'Workers stopped', {
    stoppedAt: nowIso(),
    health: getWorkersHealthSnapshot()
  });
}
