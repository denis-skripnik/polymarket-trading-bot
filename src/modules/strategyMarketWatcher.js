import WebSocket from 'ws';
import { GAMMA_API_URL } from './constants.js';
import { getWebSocketProxyOptions } from './proxy.js';

const DEFAULT_MAX_ASK = 0.49;
const DEFAULT_DISCOVERY_PAGE_SIZE = 200;
const DEFAULT_DISCOVERY_PAGES = 3;
const DEFAULT_DISCOVERY_REFRESH_MS = 60_000;
const DEFAULT_NOTIFICATIONS_COOLDOWN_MS = 300_000;
const DEFAULT_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const DEFAULT_WS_SUBSCRIPTION_CHUNK = 400;
const DEFAULT_WS_RECONNECT_BASE_MS = 1_000;
const DEFAULT_WS_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_TRACKED_MARKETS = 2_000;

function normalizeTokenId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toFinitePositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const intValue = Math.trunc(numeric);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function splitIntoChunks(items, chunkSize) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const chunks = [];
  for (let index = 0; index < list.length; index += chunkSize) {
    chunks.push(list.slice(index, index + chunkSize));
  }
  return chunks;
}

function asArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  return [payload];
}

function resolveStrategyMaxAskPrice(config) {
  const raw = Number(config?.strategies?.maxAskPrice ?? DEFAULT_MAX_ASK);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_ASK;
  if (raw < 0.01) return 0.01;
  if (raw > 0.99) return 0.99;
  return Number(raw.toFixed(4));
}

function resolveNotificationsCooldownMs(config) {
  const notifications = config?.notifications || {};
  const rawSeconds = Number(
    notifications.alertCooldownSeconds ??
      notifications.priceAlertCooldownSeconds
  );
  if (!Number.isFinite(rawSeconds) || rawSeconds < 0) {
    return DEFAULT_NOTIFICATIONS_COOLDOWN_MS;
  }
  return Math.floor(rawSeconds * 1000);
}

function formatProbability(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Number(numeric.toFixed(6));
}

function isTradeableMarketCandidate(market) {
  if (!market || typeof market !== 'object') return false;
  if (market.enableOrderBook !== true) return false;
  if (market.acceptingOrders === false) return false;
  if (market.active === false) return false;
  if (market.closed === true) return false;
  return true;
}

function getMarketKey(market) {
  const candidates = [market?.slug, market?.id, market?.conditionId];
  for (const value of candidates) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function parseTokenPair(market) {
  let clobTokenIds = [];
  try {
    if (Array.isArray(market?.clobTokenIds)) {
      clobTokenIds = market.clobTokenIds;
    } else if (market?.clobTokenIds) {
      clobTokenIds = JSON.parse(market.clobTokenIds);
    }
  } catch {
    clobTokenIds = [];
  }

  const tokenIdYes = normalizeTokenId(clobTokenIds[0]);
  const tokenIdNo = normalizeTokenId(clobTokenIds[1]);
  if (tokenIdYes && tokenIdNo) {
    return { tokenIdYes, tokenIdNo };
  }
  return { tokenIdYes: '', tokenIdNo: '' };
}

function getWsEventType(event) {
  return String(event?.event_type ?? event?.eventType ?? event?.event ?? '').trim().toLowerCase();
}

function extractBestAskFromBook(bookEvent) {
  const asks = Array.isArray(bookEvent?.asks) ? bookEvent.asks : [];
  let bestAsk = null;
  for (const ask of asks) {
    const price = toFinitePositiveNumber(ask?.price);
    if (price === null) continue;
    bestAsk = bestAsk === null || price < bestAsk ? price : bestAsk;
  }
  return bestAsk;
}

export function createStrategyMarketWatcher(options = {}) {
  const onAlert = typeof options.onAlert === 'function' ? options.onAlert : async () => {};
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

  const state = {
    stopped: false,
    chatId: '',
    maxAskPrice: DEFAULT_MAX_ASK,
    ws: null,
    wsOpen: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    refreshInFlight: null,
    nextDiscoveryAt: 0,
    wsUrl: process.env.STRATEGY_MARKETS_WATCHER_WS_URL || DEFAULT_WS_URL,
    marketByKey: new Map(),
    marketStateByKey: new Map(),
    tokenToMarketSide: new Map(),
    subscribedAssetIds: new Set(),
    alertStateByMarket: new Map(),
    globalAlertCooldownMs: DEFAULT_NOTIFICATIONS_COOLDOWN_MS,
    globalLastAlertAtMs: 0,
    alertQueue: Promise.resolve()
  };

  function log(level, message, extra = {}) {
    try {
      onLog(level, message, extra);
    } catch {}
  }

  function getDiscoveryPageSize() {
    return clampInteger(
      process.env.STRATEGY_MARKETS_WATCHER_PAGE_SIZE,
      1,
      500,
      DEFAULT_DISCOVERY_PAGE_SIZE
    );
  }

  function getDiscoveryPages() {
    return clampInteger(
      process.env.STRATEGY_MARKETS_WATCHER_PAGES,
      1,
      50,
      DEFAULT_DISCOVERY_PAGES
    );
  }

  function getDiscoveryRefreshMs() {
    return clampInteger(
      process.env.STRATEGY_MARKETS_WATCHER_REFRESH_MS,
      10_000,
      3_600_000,
      DEFAULT_DISCOVERY_REFRESH_MS
    );
  }

  function getMaxTrackedMarkets() {
    return clampInteger(
      process.env.STRATEGY_MARKETS_WATCHER_MAX_TRACKED_MARKETS,
      1,
      25_000,
      DEFAULT_MAX_TRACKED_MARKETS
    );
  }

  function getSubscriptionChunkSize() {
    return clampInteger(
      process.env.STRATEGY_MARKETS_WATCHER_SUBSCRIPTION_CHUNK,
      1,
      5_000,
      DEFAULT_WS_SUBSCRIPTION_CHUNK
    );
  }

  async function fetchDiscoveryPage(limit, offset) {
    const url = new URL(`${GAMMA_API_URL}/markets`);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('order', 'id');
    url.searchParams.set('ascending', 'false');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Strategy watcher markets discovery failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.markets)) return payload.markets;
    return [];
  }

  function sendWsOperation(assetIds, operation) {
    const socket = state.ws;
    if (!socket || !state.wsOpen) return;
    if (!Array.isArray(assetIds) || assetIds.length === 0) return;

    const chunks = splitIntoChunks(assetIds, getSubscriptionChunkSize());
    for (const chunk of chunks) {
      const payload = {
        type: 'market',
        assets_ids: chunk,
        operation,
        custom_feature_enabled: true
      };
      socket.send(JSON.stringify(payload));
    }
  }

  function clearReconnectTimer() {
    if (!state.reconnectTimer) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (state.stopped) return;
    if (state.reconnectTimer) return;

    const delayBase = clampInteger(
      process.env.STRATEGY_MARKETS_WATCHER_WS_RECONNECT_BASE_MS,
      250,
      10_000,
      DEFAULT_WS_RECONNECT_BASE_MS
    );
    const delayMax = clampInteger(
      process.env.STRATEGY_MARKETS_WATCHER_WS_RECONNECT_MAX_MS,
      1_000,
      300_000,
      DEFAULT_WS_RECONNECT_MAX_MS
    );

    const delay = Math.min(delayMax, delayBase * Math.max(1, 2 ** state.reconnectAttempt));
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectWebSocketIfNeeded();
    }, delay);
  }

  function closeSocket() {
    const socket = state.ws;
    if (!socket) return;
    try {
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.close();
      }
    } catch {}
    state.ws = null;
    state.wsOpen = false;
  }

  function handleSocketMessage(rawMessage) {
    let payload;
    try {
      payload = JSON.parse(String(rawMessage));
    } catch {
      return;
    }

    const events = asArrayPayload(payload);
    for (const event of events) {
      handleSocketEvent(event);
    }
  }

  function handlePriceUpdate(assetId, bestAskRaw) {
    const normalizedAssetId = normalizeTokenId(assetId);
    if (!normalizedAssetId) return;
    const bestAsk = formatProbability(bestAskRaw);
    if (bestAsk === null) return;

    const pair = state.tokenToMarketSide.get(normalizedAssetId);
    if (!pair) return;

    const marketState = state.marketStateByKey.get(pair.marketKey) || {
      yesAsk: null,
      noAsk: null,
      updatedAtMs: 0
    };

    if (pair.side === 'yes') {
      marketState.yesAsk = bestAsk;
    } else if (pair.side === 'no') {
      marketState.noAsk = bestAsk;
    } else {
      return;
    }

    marketState.updatedAtMs = Date.now();
    state.marketStateByKey.set(pair.marketKey, marketState);
    queueAlertIfNeeded(pair.marketKey);
  }

  function handleSocketEvent(event) {
    if (!event || typeof event !== 'object') return;

    const type = getWsEventType(event);
    if (type === 'new_market') {
      state.nextDiscoveryAt = 0;
      return;
    }

    if (type === 'best_bid_ask') {
      handlePriceUpdate(event.asset_id ?? event.assetId, event.best_ask ?? event.bestAsk);
      return;
    }

    if (type === 'price_change') {
      const topAssetId = event.asset_id ?? event.assetId;
      const changes = Array.isArray(event.price_changes) ? event.price_changes : [];
      if (changes.length === 0) {
        handlePriceUpdate(topAssetId, event.best_ask ?? event.bestAsk);
        return;
      }
      for (const change of changes) {
        const assetId = change.asset_id ?? change.assetId ?? topAssetId;
        const bestAsk = change.best_ask ?? change.bestAsk ?? change.ask ?? change.price;
        handlePriceUpdate(assetId, bestAsk);
      }
      return;
    }

    if (type === 'book') {
      const bestAsk = extractBestAskFromBook(event);
      handlePriceUpdate(event.asset_id ?? event.assetId, bestAsk);
      return;
    }

    if (event.asset_id || event.assetId) {
      handlePriceUpdate(event.asset_id ?? event.assetId, event.best_ask ?? event.bestAsk);
    }
  }

  function connectWebSocketIfNeeded() {
    if (state.stopped) return;
    if (!state.chatId) return;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    clearReconnectTimer();
    closeSocket();

    try {
      const socket = new WebSocket(state.wsUrl, getWebSocketProxyOptions(state.wsUrl));
      state.ws = socket;
      state.wsOpen = false;

      socket.on('open', () => {
        state.wsOpen = true;
        state.reconnectAttempt = 0;
        clearReconnectTimer();
        if (state.subscribedAssetIds.size > 0) {
          sendWsOperation(Array.from(state.subscribedAssetIds), 'subscribe');
        }
      });

      socket.on('message', handleSocketMessage);

      socket.on('error', (error) => {
        log('warn', 'Strategy watcher websocket error', { message: error?.message });
      });

      socket.on('close', () => {
        state.wsOpen = false;
        state.ws = null;
        scheduleReconnect();
      });
    } catch (error) {
      log('warn', 'Strategy watcher websocket connection failed', { message: error?.message });
      scheduleReconnect();
    }
  }

  function updateSubscriptions(nextAssetIds) {
    const next = new Set(nextAssetIds);
    const current = state.subscribedAssetIds;

    const toSubscribe = [];
    const toUnsubscribe = [];

    for (const assetId of next) {
      if (!current.has(assetId)) {
        toSubscribe.push(assetId);
      }
    }

    for (const assetId of current) {
      if (!next.has(assetId)) {
        toUnsubscribe.push(assetId);
      }
    }

    state.subscribedAssetIds = next;
    if (state.wsOpen) {
      if (toUnsubscribe.length > 0) {
        sendWsOperation(toUnsubscribe, 'unsubscribe');
      }
      if (toSubscribe.length > 0) {
        sendWsOperation(toSubscribe, 'subscribe');
      }
    }
  }

  async function refreshUniverseIfNeeded(force = false) {
    const now = Date.now();
    if (!force && now < state.nextDiscoveryAt) return;
    if (state.refreshInFlight) {
      await state.refreshInFlight;
      return;
    }

    state.refreshInFlight = (async () => {
      const pageSize = getDiscoveryPageSize();
      const pages = getDiscoveryPages();
      const maxTrackedMarkets = getMaxTrackedMarkets();

      const nextMarketByKey = new Map();
      const nextTokenToMarketSide = new Map();
      const nextAssetIds = [];

      for (let page = 1; page <= pages; page += 1) {
        const offset = (page - 1) * pageSize;
        const markets = await fetchDiscoveryPage(pageSize, offset);
        if (!Array.isArray(markets) || markets.length === 0) break;

        for (const market of markets) {
          if (!isTradeableMarketCandidate(market)) continue;
          const marketKey = getMarketKey(market);
          if (!marketKey || nextMarketByKey.has(marketKey)) continue;

          const { tokenIdYes, tokenIdNo } = parseTokenPair(market);
          if (!tokenIdYes || !tokenIdNo) continue;

          const normalizedMarket = {
            marketKey,
            id: String(market?.id ?? '').trim() || marketKey,
            slug: String(market?.slug ?? '').trim(),
            question: String(market?.question ?? market?.title ?? '').trim() || marketKey,
            tokenIdYes,
            tokenIdNo
          };

          nextMarketByKey.set(marketKey, normalizedMarket);
          nextTokenToMarketSide.set(tokenIdYes, { marketKey, side: 'yes' });
          nextTokenToMarketSide.set(tokenIdNo, { marketKey, side: 'no' });
          nextAssetIds.push(tokenIdYes, tokenIdNo);

          if (nextMarketByKey.size >= maxTrackedMarkets) break;
        }

        if (markets.length < pageSize || nextMarketByKey.size >= maxTrackedMarkets) {
          break;
        }
      }

      state.marketByKey = nextMarketByKey;
      state.tokenToMarketSide = nextTokenToMarketSide;
      updateSubscriptions(nextAssetIds);

      for (const key of state.marketStateByKey.keys()) {
        if (!state.marketByKey.has(key)) {
          state.marketStateByKey.delete(key);
        }
      }

      for (const key of state.alertStateByMarket.keys()) {
        if (!state.marketByKey.has(key)) {
          state.alertStateByMarket.delete(key);
        }
      }

      state.nextDiscoveryAt = Date.now() + getDiscoveryRefreshMs();
      log('info', 'Strategy watcher universe refreshed', {
        markets: state.marketByKey.size,
        assets: state.subscribedAssetIds.size
      });
    })();

    try {
      await state.refreshInFlight;
    } finally {
      state.refreshInFlight = null;
    }
  }

  function queueAlertIfNeeded(marketKey) {
    if (!state.chatId) return;

    const market = state.marketByKey.get(marketKey);
    const marketState = state.marketStateByKey.get(marketKey);
    if (!market || !marketState) return;

    const yesAsk = toFinitePositiveNumber(marketState.yesAsk);
    const noAsk = toFinitePositiveNumber(marketState.noAsk);
    if (yesAsk === null || noAsk === null) return;
    if (yesAsk > state.maxAskPrice || noAsk > state.maxAskPrice) return;

    const now = Date.now();
    const alertState = state.alertStateByMarket.get(marketKey) || {
      lastAlertAtMs: 0,
      lastSignature: ''
    };

    const signature = `${yesAsk.toFixed(4)}|${noAsk.toFixed(4)}|${state.maxAskPrice.toFixed(4)}`;
    const cooldownMs = state.globalAlertCooldownMs;
    if (now - alertState.lastAlertAtMs < cooldownMs) {
      return;
    }
    if (alertState.lastSignature === signature && now - alertState.lastAlertAtMs < cooldownMs * 2) {
      return;
    }
    if (now - state.globalLastAlertAtMs < cooldownMs) {
      return;
    }

    const payload = {
      market: market.question,
      marketId: market.id,
      slug: market.slug,
      yesAsk,
      noAsk,
      askSum: Number((yesAsk + noAsk).toFixed(6)),
      maxAskPrice: state.maxAskPrice,
      tokenIdYes: market.tokenIdYes,
      tokenIdNo: market.tokenIdNo
    };

    alertState.lastAlertAtMs = now;
    alertState.lastSignature = signature;
    state.alertStateByMarket.set(marketKey, alertState);
    state.globalLastAlertAtMs = now;

    state.alertQueue = state.alertQueue
      .then(async () => {
        await onAlert(payload);
      })
      .catch((error) => {
        log('warn', 'Strategy watcher alert dispatch failed', { message: error?.message });
      });
  }

  async function tick(params = {}) {
    if (state.stopped) return;
    state.chatId = String(params.chatId ?? '').trim();
    state.maxAskPrice = resolveStrategyMaxAskPrice(params.config);
    state.globalAlertCooldownMs = resolveNotificationsCooldownMs(params.config);

    if (!state.chatId) {
      return;
    }

    await refreshUniverseIfNeeded(false);
    connectWebSocketIfNeeded();

    for (const marketKey of state.marketStateByKey.keys()) {
      queueAlertIfNeeded(marketKey);
    }
  }

  async function shutdown() {
    state.stopped = true;
    clearReconnectTimer();
    closeSocket();
    state.marketByKey.clear();
    state.marketStateByKey.clear();
    state.tokenToMarketSide.clear();
    state.subscribedAssetIds.clear();
    state.alertStateByMarket.clear();
    await state.alertQueue.catch(() => {});
  }

  function getStateSnapshot() {
    return {
      chatConfigured: Boolean(state.chatId),
      wsOpen: state.wsOpen,
      trackedMarkets: state.marketByKey.size,
      subscribedAssets: state.subscribedAssetIds.size,
      maxAskPrice: state.maxAskPrice,
      nextDiscoveryAt: state.nextDiscoveryAt ? new Date(state.nextDiscoveryAt).toISOString() : null
    };
  }

  return {
    tick,
    shutdown,
    getStateSnapshot
  };
}
