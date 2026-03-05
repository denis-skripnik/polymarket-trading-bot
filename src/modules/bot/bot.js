import { Bot, InlineKeyboard } from 'grammy';
import { loadConfig, updateConfig, ensureConfigFileExists, isLanguageConfigured, isWalletConfigured, getPolygonRpcUrl } from '../config.js';
import { getTranslator, getLocalesCache } from '../i18n.js';
import { getDecryptedPrivateKey, getDecryptedL2Credentials, initializeWallet } from '../auth.js';
import { safeLogError, safeLogWarn, safeLogInfo, createContext } from '../logger.js';
import { translateUiText, translateUiTexts } from '../ai.js';
import {
  initClient,
  initContracts,
  getMarkets,
  getCategories,
  getMarketDetails,
  getEvents,
  getEvent,
  filterTradeableSubmarkets,
  getOrderBook,
  getBestBidAsk,
  placeMarketBuyFOK,
  placeMarketSellWithFallback,
  createOrder,
  cancelOrder,
  getPositions,
  getOrders,
  split,
  merge,
  redeem,
  setAllAllowances,
  checkBalance,
  mapErrorToUserMessage,
  parseUSDCToBase,
  formatUSDCFromBase,
  parseSharesToBase,
  formatSharesFromBase,
  parsePriceToMicro,
  formatPriceFromMicro,
  computeSharesFromUSDC,
  computeUSDCFromShares,
  getCollateralStatus,
  getCollateralBalanceBase,
  getOnchainAllowancesUSDC,
  invalidateOnchainPositionCaches
} from '../polymarket.js';
import {
  cacheMarket,
  getMarketCache,
  getMarketCacheByConditionId,
  getMarketCacheByTokenId,
  savePosition,
  reducePosition,
  getPositions as getDbPositions,
  saveOrder,
  getOrders as getDbOrders,
  getOrderById,
  updateOrderStatus,
  saveStrategy,
  updateStrategy,
  getActiveStrategies as getDbActiveStrategies
} from '../database.js';
import { Wallet } from 'ethers';
import {
  RATE_LIMIT_MS,
  MIN_SPLIT_USDC_BASE,
  MIN_LIMIT_ORDER_SHARES_BASE,
  CATEGORY_ALL_KEY,
  CATEGORY_CATALOG_TTL_MS,
  BUTTON_LABEL_MAX_LEN,
  EVENT_DETAILS_SUBMARKETS_PAGE_SIZE,
  EVENTS_LIST_PAGE_SIZE,
  EVENTS_FILTER_LOOKAHEAD_PAGES,
  EVENTS_FILTER_MAX_SCANNED_EVENTS,
  EVENTS_FILTER_CACHE_TTL_MS,
  STRATEGY_MARKETS_CACHE_TTL_MS,
  STRATEGY_MARKETS_PAGE_SIZE,
  POST_TX_POSITIONS_RETRY_DELAY_MS,
  STRATEGY_MARKETS_TARGET_ITEMS,
  STRATEGY_MARKETS_FETCH_LIMIT,
  STRATEGY_MARKETS_MAX_FETCHED,
  STRATEGY_MARKETS_MAX_DEEP_SCAN,
  STRATEGY_MARKETS_SCAN_STEP,
  STRATEGY_MARKETS_ORDERBOOK_CONCURRENCY
} from './constants.js';
import {
  bot,
  setBot,
  allowedUserId,
  setAllowedUserId,
  userStates,
  rateLimits,
  busyLocks,
  confirmationLocks,
  autoAllowanceReady,
  autoAllowanceInFlight,
  botClientInitPromise,
  setBotClientInitPromise,
  botClientInitializedWallet,
  setBotClientInitializedWallet,
  botClientReady,
  setBotClientReady,
  botContractsInitPromise,
  setBotContractsInitPromise,
  botContractsInitializedWallet,
  setBotContractsInitializedWallet,
  botContractsReady,
  setBotContractsReady,
  localesCache,
  setLocalesCache,
  categoriesCatalogCache,
  setCategoriesCatalogCache,
  strategyMarketsCache
} from './runtime.js';
import { getMainMenuKeyboard, buildMergeAmountKeyboard } from './ui/keyboards.js';
import {
  toUnitIntervalOrNull,
  escapeHtml,
  parseBaseUnitsBigIntSafe,
  formatPlainNumber,
  normalizeOutcomeSideHint,
  getRedeemActionLabel,
  formatOrderPriceDisplay,
  formatTxHashLink,
  formatSignedPercentValue,
  parsePercentInput,
  parsePositiveNumberInput,
  parseUnitIntervalInput,
  parseEventsFilterRangeInput,
  parseNonNegativeIntegerInput
} from './ui/formatters.js';
import { createHandleCallbackRouter } from './routing/callback-router.js';
import { createHandleTextMessageRouter } from './routing/text-router.js';
import {
  showLanguageSelectionScreen,
  handleLanguageSelectionAction,
  showLanguageSettingsMenu,
  handleSettingsLanguageChangeAction
} from './features/language.js';
import { createMarketsFeature } from './features/markets.js';
import { createMarketDetailsFeature } from './features/market-details.js';
import { createPositionsFeature } from './features/positions.js';
import { createOrdersFeature } from './features/orders.js';
import { createStrategiesFeature } from './features/strategies.js';
import { createSecurityFeature } from './features/security.js';
import { createSettingsFeature } from './features/settings.js';
import { createWithdrawFeature } from './features/withdraw.js';
import { createTradeMarketFeature } from './features/trade-market.js';
import { createTradeLimitFeature } from './features/trade-limit.js';
import { createTradeOnchainFeature } from './features/trade-onchain.js';
import { createNotificationsFeature } from './notifications.js';

// Initialize bot
export async function initBot(token, allowedUserIdParam) {
  setAllowedUserId(allowedUserIdParam);
  
  // Load locales cache for synchronous keyboard labels
  setLocalesCache(getLocalesCache());
  
  // Ensure config file exists (creates with empty fields if missing)
  await ensureConfigFileExists();
  
  setBot(new Bot(token));
  
  // Access control middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    
    if (!userId || userId.toString() !== allowedUserId.toString()) {
      // Load config to get language for i18n
      const config = await loadConfig();
      const t = await getTranslator(config.language || 'ru');
      
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery(t('error_access_denied'));
      } else {
        await ctx.reply(t('error_access_denied'));
      }
      return;
    }
    
    // Rate limiting
    const now = Date.now();
    const lastCommand = rateLimits.get(userId) || 0;
    if (now - lastCommand < RATE_LIMIT_MS) {
      const config = await loadConfig();
      const t = await getTranslator(config.language || 'ru');
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery(t('error_rate_limit'));
      } else {
        await ctx.reply(t('error_rate_limit'));
      }
      return;
    }
    rateLimits.set(userId, now);
    
    await next();
  });
  
  // /start command
  bot.command('start', async (ctx) => {
    await handleStart(ctx);
  });
  
  // Callback handlers
  bot.on('callback_query:data', async (ctx) => {
    await handleCallback(ctx);
  });
  
  // Text message handlers
  bot.on('message:text', async (ctx) => {
    await handleTextMessage(ctx);
  });
  
  // Error handler
  bot.catch((err) => {
    const ctx = createContext('bot', 'catch');
    safeLogError(ctx, err);
  });
  
  return bot;
}

// Show language selection screen
async function showLanguageSelection(ctx) {
  await showLanguageSelectionScreen(ctx);
}

// Handle language selection
async function handleLanguageSelection(ctx, lang) {
  await handleLanguageSelectionAction(ctx, lang, getMainMenuKeyboard);
}

// Handle /start command
async function handleStart(ctx) {
  const langConfigured = await isLanguageConfigured();
  
  if (!langConfigured) {
    // First run: show language selection
    await showLanguageSelection(ctx);
    return;
  }
  
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  
  const walletConfigured = await isWalletConfigured();
  
  let message = `<b>${t('welcome')}</b>\n\n` +
                `<b>${t('wallet_status')}:</b> ` +
                (walletConfigured ? `<code>${config.walletAddress}</code>` : t('not_configured'));
  
  if (!walletConfigured) {
    message += '\n\n' + t('wallet_not_configured_help');
  }
  
  await ctx.reply(message, {
    reply_markup: await getMainMenuKeyboard(config.language || 'ru'),
    parse_mode: 'HTML'
  });
}

const handleCallback = createHandleCallbackRouter({
  handleLanguageSelection,
  showMarketCategoriesList,
  showStrategyMarketsList,
  getCachedStrategyMarket,
  showMarketDetails,
  startStrategyFlowFromMarket,
  getCachedCategory,
  getCategoryToken,
  showEventsList,
  getCachedCategoryContext,
  showEventsFilterMenu,
  applyEventsPriceFilterPreset,
  showEventsListByCategoryToken,
  buildEventsFilterCallback,
  getCachedEventDetails,
  showEventDetails,
  getCachedEvent,
  getCachedSubmarket,
  buildEventDetailsCallback,
  getCachedMarket,
  showOutcomeSelection,
  handleOutcomeSelection,
  getCachedMarketDetailsState,
  getCachedMarketDetails,
  startSplitFlow,
  startMergeFlow,
  handleSellPercent,
  handleLimitBuyPercent,
  handleLimitSellPercent,
  handleLimitPricePreset,
  handleBuyPercent,
  handleSplitPercent,
  handleStrategySplitPercent,
  handleMergeMax,
  executeConfirmedBuy,
  executeConfirmedSell,
  executeConfirmedLimit,
  executeConfirmedStrategySplit,
  getMainMenuKeyboard,
  showPositions,
  showPositionDetailsFromCache,
  startSellFromCachedPosition,
  startMergeFromCachedPosition,
  startRedeemFromCachedPosition,
  showOrderDetailsFromCache,
  showOrders,
  showStrategies,
  showStrategyDetailsFromCache,
  startCloseStrategyFromCache,
  executeConfirmedStrategyClose,
  cancelCachedOrder,
  executeConfirmedSplit,
  executeConfirmedMerge,
  executeConfirmedRedeem,
  showSettings,
  showStrategySettings,
  showNotificationSettings,
  startStrategySettingsEdit,
  startNotificationSettingsEdit,
  handleInitWallet,
  handleSetAllowances,
  handleCollateralStatus,
  handleStartExportPk,
  handleConfirmExportPk,
  handleCancelExportPk,
  showLanguageSettings,
  handleSettingsLanguageChange,
  startWithdrawFlow,
  executeWithdraw,
  handleWithdrawAddress,
  handleWithdrawAmount,
  handleWithdrawPercent
});

// Show language settings in Settings menu
async function showLanguageSettings(ctx) {
  await showLanguageSettingsMenu(ctx);
}

// Handle language change from Settings
async function handleSettingsLanguageChange(ctx, lang) {
  await handleSettingsLanguageChangeAction(ctx, lang, getMainMenuKeyboard);
}

const {
  showMarketsList: showMarketsListFeature,
  showStrategyMarketsList: showStrategyMarketsListFeature,
  showMarketCategoriesList: showMarketCategoriesListFeature,
  showEventsFilterMenu: showEventsFilterMenuFeature,
  showEventsList: showEventsListFeature,
  showEventsListByCategoryToken: showEventsListByCategoryTokenFeature,
  parsePolymarketEventUrl: parsePolymarketEventUrlFeature,
  handlePolymarketEventUrlInput: handlePolymarketEventUrlInputFeature
} = createMarketsFeature({
  sortByLiquidityDesc,
  translateUiLabelsForLanguage,
  truncateButtonLabel,
  createContext,
  safeLogError,
  resolveStrategyMaxAskPrice,
  loadStrategyMarkets,
  formatStrategyAskPrice,
  loadCategoryCatalog,
  getEventsPriceFilter,
  formatEventsPriceFilterLabel,
  buildEventsFilterPresetCallback,
  buildEventsFilterCustomCallback,
  buildEventsListCallback,
  loadEventsPageWithPriceFilter,
  buildEventsFilterCallback,
  buildEventDetailsCallback,
  getCachedCategoryContext,
  createMessageEditContext,
  showMarketDetails,
  showEventDetails,
  CATEGORY_ALL_KEY
});

const {
  showEventDetails: showEventDetailsFeature,
  showMarketDetails: showMarketDetailsFeature
} = createMarketDetailsFeature({
  sortByLiquidityDesc,
  filterMarketsByEventsPriceFilter,
  getEventsPriceFilter,
  formatEventsPriceFilterLabel,
  translateUiLabelsForLanguage,
  truncateButtonLabel,
  buildEventDetailsCallback,
  buildEventsListCallback,
  createContext,
  safeLogWarn,
  safeLogError,
  ensureClientInitialized,
  getMarketRefValue,
  escapeHtml,
  getActionLabel
});

const {
  showPositions: showPositionsFeature,
  showPositionDetailsFromCache: showPositionDetailsFromCacheFeature,
  startSellFromCachedPosition: startSellFromCachedPositionFeature,
  startMergeFromCachedPosition: startMergeFromCachedPositionFeature,
  startRedeemFromCachedPosition: startRedeemFromCachedPositionFeature
} = createPositionsFeature({
  createContext,
  safeLogError,
  safeLogWarn,
  ensureClientInitialized,
  setCachedPositions,
  getCachedPosition,
  getCachedPositions,
  refreshPositionsCache,
  resolvePositionMergeInfo,
  formatUsdOrNA,
  getPositionTokenId,
  getPositionConditionId,
  getPositionMarketRef,
  canRedeemPosition,
  canSellPosition,
  getRedeemActionLabel,
  startSellFlow,
  buildMergeAmountKeyboard,
  parseSharesBaseSafe
});

const {
  showOrders: showOrdersFeature,
  showOrderDetailsFromCache: showOrderDetailsFromCacheFeature,
  cancelCachedOrder: cancelCachedOrderFeature
} = createOrdersFeature({
  createContext,
  safeLogError,
  ensureClientInitialized,
  resolveOrderMarketDisplay,
  getOrderSideText,
  getOrderStatusText,
  extractOrderId,
  shortenHexLike,
  formatOrderPriceDisplay,
  resolveOrderSizeBase,
  formatOrderRemainingWithNotional,
  formatSharesCompact,
  getCachedOrder,
  isOrderCancellableStatus,
  updateOrderStatus
});

const {
  showStrategies: showStrategiesFeature,
  showStrategyDetailsFromCache: showStrategyDetailsFromCacheFeature,
  startCloseStrategyFromCache: startCloseStrategyFromCacheFeature,
  executeConfirmedStrategyClose: executeConfirmedStrategyCloseFeature
} = createStrategiesFeature({
  createContext,
  safeLogError,
  safeLogWarn,
  ensureClientInitialized,
  ensureAutoAllowancesConfigured,
  ensureContractsInitialized,
  getPositionSharesForTokenFromList,
  getStrategyStatusText,
  formatStrategyPercentValue,
  getCachedStrategy,
  parseStrategyOrderPair,
  getOrderById,
  extractOrderId,
  getOrderStatusText,
  formatStrategyOrderStatus,
  parseBaseUnitsBigIntSafe,
  shortOrderIdOrNA,
  getMainMenuKeyboard,
  getTxHashFromResult,
  updateStrategy,
  encodeStrategyOrderPair,
  updateOrderStatus,
  formatTxHashLink
});

const {
  handleInitWallet: handleInitWalletFeature,
  handleSetAllowances: handleSetAllowancesFeature,
  handleCollateralStatus: handleCollateralStatusFeature,
  handleStartExportPk: handleStartExportPkFeature,
  handleConfirmExportPk: handleConfirmExportPkFeature,
  handleCancelExportPk: handleCancelExportPkFeature,
  handleExportConfirmation: handleExportConfirmationFeature,
  ensureClientInitialized: ensureClientInitializedFeature,
  ensureContractsInitialized: ensureContractsInitializedFeature,
  ensureAutoAllowancesConfigured: ensureAutoAllowancesConfiguredFeature
} = createSecurityFeature({
  getMainMenuKeyboard,
  formatTxHashLink,
  escapeHtml
});

const {
  showSettings: showSettingsFeature,
  showStrategySettings: showStrategySettingsFeature,
  showNotificationSettings: showNotificationSettingsFeature,
  startStrategySettingsEdit: startStrategySettingsEditFeature,
  handleStrategySettingsInput: handleStrategySettingsInputFeature,
  startNotificationSettingsEdit: startNotificationSettingsEditFeature,
  handleNotificationSettingsInput: handleNotificationSettingsInputFeature,
  handleEventsFilterRangeInput: handleEventsFilterRangeInputFeature
} = createSettingsFeature({
  resolveStrategyMaxAskPrice,
  resolveNotificationAlertCooldownSeconds,
  formatSignedPercentValue,
  formatStrategyAskPrice,
  formatPlainNumber,
  parsePercentInput,
  parsePositiveNumberInput,
  parseUnitIntervalInput,
  parseNonNegativeIntegerInput,
  parseEventsFilterRangeInput,
  getEventsPriceFilter,
  setEventsPriceFilter,
  formatEventsPriceFilterLabel,
  buildEventsFilterCallback,
  buildEventsListCallback,
  showEventsListByCategoryToken,
  createMessageEditContext,
  createContext,
  safeLogWarn
});

const {
  startWithdrawFlow: startWithdrawFlowFeature,
  handleWithdrawAddress: handleWithdrawAddressFeature,
  handleWithdrawAmount: handleWithdrawAmountFeature,
  handleWithdrawPercent: handleWithdrawPercentFeature,
  executeWithdraw: executeWithdrawFeature
} = createWithdrawFeature({
  getMainMenuKeyboard,
  ensureClientInitialized,
  ensureContractsInitialized,
  formatTxHashLink
});

const {
  showOutcomeSelection: showOutcomeSelectionFeature,
  handleOutcomeSelection: handleOutcomeSelectionFeature,
  startBuyFlow: startBuyFlowFeature,
  handleBuyAmount: handleBuyAmountFeature,
  executeConfirmedBuy: executeConfirmedBuyFeature,
  startSellFlow: startSellFlowFeature,
  handleSellPercent: handleSellPercentFeature,
  handleSellAmount: handleSellAmountFeature,
  executeConfirmedSell: executeConfirmedSellFeature,
  handleBuyPercent: handleBuyPercentFeature
} = createTradeMarketFeature({
  isValidMarketAction,
  getCachedMarketDetailsState,
  getCachedMarketDetails,
  getMarketRefValue,
  parseMarketTokensAndOutcomes,
  translateUiLabelsForLanguage,
  translateUiLabelForLanguage,
  truncateButtonLabel,
  getActionLabel,
  escapeHtml,
  createContext,
  safeLogWarn,
  safeLogError,
  getPositionSharesBaseForToken,
  ensureClientInitialized,
  ensureAutoAllowancesConfigured,
  ensureContractsInitialized,
  getMainMenuKeyboard,
  getResultErrorMessage,
  extractOrderId,
  normalizeOutcomeSideHint,
  refreshPositionsAfterMutation,
  getCollateralBalanceBase,
  getTokenSharesBalanceBase,
  buildUsdcPercentKeyboard,
  startLimitFlow,
  formatTxHashLink
});

const {
  startLimitFlow: startLimitFlowFeature,
  handleLimitAmount: handleLimitAmountFeature,
  handleLimitPrice: handleLimitPriceFeature,
  handleLimitBuyPercent: handleLimitBuyPercentFeature,
  handleLimitSellPercent: handleLimitSellPercentFeature,
  handleLimitPricePreset: handleLimitPricePresetFeature,
  executeConfirmedLimit: executeConfirmedLimitFeature
} = createTradeLimitFeature({
  ensureClientInitialized,
  ensureAutoAllowancesConfigured,
  getMainMenuKeyboard,
  createContext,
  safeLogWarn,
  safeLogError,
  getCollateralBalanceBase,
  getTokenSharesBalanceBase,
  buildUsdcPercentKeyboard,
  buildSharesPercentKeyboard,
  buildLimitPriceKeyboard,
  parsePriceMicroSafe,
  applyPercentToPriceMicro,
  extractOrderId,
  getResultErrorMessage
});

const {
  startStrategyFlowFromMarket: startStrategyFlowFromMarketFeature,
  handleStrategySplitAmount: handleStrategySplitAmountFeature,
  handleStrategySplitPercent: handleStrategySplitPercentFeature,
  executeConfirmedStrategySplit: executeConfirmedStrategySplitFeature,
  startSplitFlow: startSplitFlowFeature,
  handleSplitAmount: handleSplitAmountFeature,
  handleSplitPercent: handleSplitPercentFeature,
  executeConfirmedSplit: executeConfirmedSplitFeature,
  startMergeFlow: startMergeFlowFeature,
  handleMergeAmount: handleMergeAmountFeature,
  handleMergeMax: handleMergeMaxFeature,
  executeConfirmedMerge: executeConfirmedMergeFeature,
  executeConfirmedRedeem: executeConfirmedRedeemFeature
} = createTradeOnchainFeature({
  parseMarketTokensAndOutcomes,
  normalizeTokenId,
  formatSignedPercentValue,
  getMarketRefValue,
  getCollateralBalanceBase,
  buildUsdcPercentKeyboard,
  getMainMenuKeyboard,
  createContext,
  safeLogWarn,
  safeLogError,
  ensureAutoAllowancesConfigured,
  ensureContractsInitialized,
  ensureClientInitialized,
  parsePriceMicroSafe,
  applyPercentToPriceMicro,
  getTxHashFromResult,
  getResultErrorMessage,
  extractOrderId,
  encodeStrategyOrderPair,
  formatTxHashLink,
  escapeHtml,
  refreshPositionsAfterMutation,
  showSplitAmountPrompt,
  showSplitConfirmation,
  buildMergeAmountKeyboard,
  parseBaseUnitsBigIntSafe,
  setCachedPositions,
  getPositionTokenId,
  resolvePositionMergeInfo,
  getRedeemActionLabel
});

const handleTextMessage = createHandleTextMessageRouter({
  parsePolymarketEventUrl,
  handlePolymarketEventUrlInput,
  getMainMenuKeyboard,
  handleBuyAmount,
  handleSellAmount,
  handleSplitAmount,
  handleStrategySplitAmount,
  handleMergeAmount,
  handleExportConfirmation,
  handleLimitAmount,
  handleLimitPrice,
  handleStrategySettingsInput,
  handleNotificationSettingsInput,
  handleEventsFilterRangeInput,
  handleWithdrawAddress,
  handleWithdrawAmount
});

// Show markets list - does NOT require initialized clobClient
async function showMarketsList(ctx, page = 1) {
  await showMarketsListFeature(ctx, page);
}

function toFinitePositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function resolveStrategyMaxAskPrice(config) {
  const raw = Number(config?.strategies?.maxAskPrice ?? 0.49);
  if (!Number.isFinite(raw)) return 0.49;
  if (raw < 0.01) return 0.01;
  if (raw > 0.99) return 0.99;
  return Number(raw.toFixed(4));
}

function resolveNotificationAlertCooldownSeconds(config) {
  const notifications = config?.notifications || {};
  const raw = Number(
    notifications.alertCooldownSeconds ??
      notifications.priceAlertCooldownSeconds ??
      300
  );
  if (!Number.isFinite(raw) || raw < 0) return 300;
  return Math.floor(raw);
}

function formatStrategyAskPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 'N/A';
  return num.toFixed(4).replace(/\.?0+$/, '');
}

function formatProbabilityValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1) return 'N/A';
  return num.toFixed(4).replace(/\.?0+$/, '');
}



function parseMarketOutcomePrices(market) {
  if (!market || !market.outcomePrices) return [];
  try {
    const raw = Array.isArray(market.outcomePrices)
      ? market.outcomePrices
      : JSON.parse(market.outcomePrices);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((value) => toUnitIntervalOrNull(value))
      .filter((value) => value !== null);
  } catch {
    return [];
  }
}

function resolveMarketYesProbability(market) {
  const prices = parseMarketOutcomePrices(market);
  if (prices.length > 0) {
    return prices[0];
  }

  const lastTrade = toUnitIntervalOrNull(market?.lastTradePrice);
  if (lastTrade !== null) {
    return lastTrade;
  }

  const bestBid = toUnitIntervalOrNull(market?.bestBid);
  const bestAsk = toUnitIntervalOrNull(market?.bestAsk);
  if (bestBid !== null && bestAsk !== null) {
    return Number(((bestBid + bestAsk) / 2).toFixed(4));
  }
  if (bestBid !== null) return bestBid;
  if (bestAsk !== null) return bestAsk;
  return null;
}

function normalizeEventsPriceFilter(rawFilter) {
  const enabled = rawFilter?.enabled === true;
  if (!enabled) {
    return { enabled: false, min: null, max: null };
  }

  const min = toUnitIntervalOrNull(rawFilter?.min);
  const max = toUnitIntervalOrNull(rawFilter?.max);
  if (min === null || max === null || min >= max) {
    return { enabled: false, min: null, max: null };
  }

  return { enabled: true, min, max };
}

function getEventsPriceFilter(chatId) {
  const cacheKey = `eventsPriceFilter:${chatId}`;
  return normalizeEventsPriceFilter(userStates.get(cacheKey));
}

function setEventsPriceFilter(chatId, nextFilter) {
  const cacheKey = `eventsPriceFilter:${chatId}`;
  userStates.set(cacheKey, {
    ...normalizeEventsPriceFilter(nextFilter),
    timestamp: Date.now()
  });
}

function applyEventsPriceFilterPreset(chatId, preset) {
  switch (preset) {
    case '10_90':
      setEventsPriceFilter(chatId, { enabled: true, min: 0.1, max: 0.9 });
      break;
    case '15_85':
      setEventsPriceFilter(chatId, { enabled: true, min: 0.15, max: 0.85 });
      break;
    case 'off':
    default:
      setEventsPriceFilter(chatId, { enabled: false });
      break;
  }
}

function formatEventsPriceFilterLabel(filter, t) {
  if (!filter?.enabled) {
    return t('events_filter_value_off');
  }
  return t('events_filter_value_on', {
    min: formatProbabilityValue(filter.min),
    max: formatProbabilityValue(filter.max)
  });
}

function marketMatchesEventsPriceFilter(market, filter) {
  if (!filter?.enabled) return true;
  const yesProbability = resolveMarketYesProbability(market);
  if (yesProbability === null) return false;
  return yesProbability >= filter.min && yesProbability <= filter.max;
}

function filterMarketsByEventsPriceFilter(markets, filter) {
  const list = Array.isArray(markets) ? markets : [];
  if (!filter?.enabled) return list;
  return list.filter((market) => marketMatchesEventsPriceFilter(market, filter));
}

function eventMatchesEventsPriceFilter(event, filter) {
  if (!filter?.enabled) return true;
  const markets = filterTradeableSubmarkets(event);
  if (!markets.length) return false;
  return markets.some((market) => marketMatchesEventsPriceFilter(market, filter));
}

async function loadEventsPageWithPriceFilter({ chatId, categoryToken, page, categoryFilter, filter }) {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safeCategoryToken = categoryToken || CATEGORY_ALL_KEY;
  const offsetBase = (safePage - 1) * EVENTS_LIST_PAGE_SIZE;

  if (!filter?.enabled) {
    const eventsRaw = await getEvents(EVENTS_LIST_PAGE_SIZE, offsetBase, categoryFilter, 'liquidity', false);
    return {
      events: sortByLiquidityDesc(eventsRaw),
      hasMore: Array.isArray(eventsRaw) && eventsRaw.length === EVENTS_LIST_PAGE_SIZE
    };
  }

  const filterSignature = `${filter.min}:${filter.max}`;
  const cacheKey = `eventsFiltered:${chatId}:${safeCategoryToken}:${filterSignature}`;
  const cached = userStates.get(cacheKey);
  const now = Date.now();
  const isCacheValid =
    cached &&
    Array.isArray(cached.items) &&
    typeof cached.nextOffset === 'number' &&
    typeof cached.hasMore === 'boolean' &&
    cached.categoryFilter === categoryFilter &&
    now - (cached.timestamp || 0) < EVENTS_FILTER_CACHE_TTL_MS;

  const state = isCacheValid
    ? cached
    : {
      items: [],
      seen: {},
      nextOffset: 0,
      hasMore: true,
      categoryFilter,
      timestamp: now
    };

  const targetCount = safePage * EVENTS_LIST_PAGE_SIZE;
  let scanned = 0;
  let pagesFetched = 0;

  while (state.items.length < targetCount && state.hasMore && pagesFetched <= EVENTS_FILTER_LOOKAHEAD_PAGES) {
    const batchRaw = await getEvents(EVENTS_LIST_PAGE_SIZE, state.nextOffset, categoryFilter, 'liquidity', false);
    const batch = sortByLiquidityDesc(batchRaw);
    pagesFetched += 1;

    if (!batch.length) {
      state.hasMore = false;
      break;
    }

    for (const event of batch) {
      const eventKey = String(event?.id ?? event?.slug ?? '');
      if (!eventKey || state.seen[eventKey]) continue;
      state.seen[eventKey] = true;
      if (eventMatchesEventsPriceFilter(event, filter)) {
        state.items.push(event);
        if (state.items.length >= targetCount) break;
      }
    }

    scanned += batch.length;
    if (batch.length < EVENTS_LIST_PAGE_SIZE) {
      state.hasMore = false;
      break;
    }
    state.nextOffset += EVENTS_LIST_PAGE_SIZE;
    if (scanned >= EVENTS_FILTER_MAX_SCANNED_EVENTS) {
      break;
    }
  }

  state.timestamp = Date.now();
  userStates.set(cacheKey, state);

  const startIndex = (safePage - 1) * EVENTS_LIST_PAGE_SIZE;
  const endIndex = startIndex + EVENTS_LIST_PAGE_SIZE;
  const pageItems = state.items.slice(startIndex, endIndex);
  const hasMore = state.items.length > endIndex || state.hasMore;

  return {
    events: pageItems,
    hasMore
  };
}

function isStrategyMarketPrecheckCandidate(market) {
  if (!market || typeof market !== 'object') return false;
  if (market.enableOrderBook !== true) return false;
  if (market.acceptingOrders === false) return false;
  if (market.active === false) return false;
  if (market.closed === true) return false;
  return true;
}

async function mapWithConcurrencyLimit(list, concurrency, mapper) {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency || 1));
  const results = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function getStrategyMarketsCache(chatId) {
  const cached = strategyMarketsCache.get(chatId);
  if (!cached || !Array.isArray(cached.items)) return null;
  return cached;
}

function getCachedStrategyMarket(chatId, page, index) {
  const cached = getStrategyMarketsCache(chatId);
  if (!cached) return null;
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safeIndex = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  const absoluteIndex = (safePage - 1) * STRATEGY_MARKETS_PAGE_SIZE + safeIndex;
  const item = cached.items[absoluteIndex];
  if (!item) return null;
  return item;
}

async function fetchStrategyMarketsCandidates() {
  const all = [];
  let page = 1;

  while (all.length < STRATEGY_MARKETS_MAX_FETCHED) {
    const batch = await getMarkets(null, page, STRATEGY_MARKETS_FETCH_LIMIT);
    const normalizedBatch = Array.isArray(batch) ? batch : [];
    if (normalizedBatch.length === 0) break;
    all.push(...normalizedBatch);
    if (normalizedBatch.length < STRATEGY_MARKETS_FETCH_LIMIT) break;
    page += 1;
  }

  const sorted = sortByLiquidityDesc(all);
  const unique = [];
  const seen = new Set();
  for (const market of sorted) {
    if (!isStrategyMarketPrecheckCandidate(market)) continue;
    const key = getMarketRefValue(market, market);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(market);
  }

  return unique;
}

async function evaluateStrategyMarketByOrderbook(market, t, maxAskPrice) {
  const { tokenIdYes, tokenIdNo } = extractStrategyTokenPair(market, t);
  if (!tokenIdYes || !tokenIdNo) return null;

  try {
    const [yesBook, noBook] = await Promise.all([
      getBestBidAsk(tokenIdYes),
      getBestBidAsk(tokenIdNo)
    ]);

    const yesAsk = toFinitePositiveNumber(yesBook?.bestAskStr);
    const noAsk = toFinitePositiveNumber(noBook?.bestAskStr);
    if (yesAsk === null || noAsk === null) return null;

    if (yesAsk > maxAskPrice || noAsk > maxAskPrice) return null;

    return {
      market,
      marketRef: getMarketRefValue(market, market),
      yesAsk,
      noAsk
    };
  } catch {
    return null;
  }
}

async function loadStrategyMarkets(chatId, t, maxAskPrice, forceRefresh = false) {
  const now = Date.now();
  const cached = getStrategyMarketsCache(chatId);
  if (
    !forceRefresh &&
    cached &&
    cached.maxAskPrice === maxAskPrice &&
    now - cached.timestamp <= STRATEGY_MARKETS_CACHE_TTL_MS
  ) {
    return cached;
  }

  await ensureClientInitialized();

  const candidates = await fetchStrategyMarketsCandidates();
  const deepCandidates = candidates.slice(0, STRATEGY_MARKETS_MAX_DEEP_SCAN);
  const accepted = [];
  let scanned = 0;

  for (let offset = 0; offset < deepCandidates.length; offset += STRATEGY_MARKETS_SCAN_STEP) {
    const chunk = deepCandidates.slice(offset, offset + STRATEGY_MARKETS_SCAN_STEP);
    if (chunk.length === 0) break;

    const evaluated = await mapWithConcurrencyLimit(
      chunk,
      STRATEGY_MARKETS_ORDERBOOK_CONCURRENCY,
      (market) => evaluateStrategyMarketByOrderbook(market, t, maxAskPrice)
    );

    scanned += chunk.length;

    for (const item of evaluated) {
      if (!item) continue;
      accepted.push(item);
      if (accepted.length >= STRATEGY_MARKETS_TARGET_ITEMS) break;
    }

    if (accepted.length >= STRATEGY_MARKETS_TARGET_ITEMS) break;
  }

  const next = {
    items: accepted,
    timestamp: now,
    maxAskPrice,
    scannedCandidates: scanned
  };
  strategyMarketsCache.set(chatId, next);
  return next;
}

async function showStrategyMarketsList(ctx, page = 1, forceRefresh = false) {
  await showStrategyMarketsListFeature(ctx, page, forceRefresh);
}

function buildEventsListCallback(categoryToken, page) {
  return `evs:${categoryToken}:${page}`;
}

function buildEventsFilterCallback(categoryToken, eventsPage) {
  return `ef:${categoryToken}:${eventsPage}`;
}

function buildEventsFilterPresetCallback(categoryToken, eventsPage, preset) {
  return `efset:${categoryToken}:${eventsPage}:${preset}`;
}

function buildEventsFilterCustomCallback(categoryToken, eventsPage) {
  return `efcustom:${categoryToken}:${eventsPage}`;
}

function buildEventDetailsCallback(categoryToken, eventsPage, eventIndex, submarketsPage = null) {
  const callback = `evd:${categoryToken}:${eventsPage}:${eventIndex}`;
  if (!Number.isFinite(submarketsPage) || submarketsPage <= 1) {
    return callback;
  }
  return `${callback}:${Math.trunc(submarketsPage)}`;
}

function getCategoryToken(categoriesPage, categoryIndex) {
  return `${categoriesPage}_${categoryIndex}`;
}

function normalizeCategoryName(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  const text = String(raw).replace(/\s+/g, ' ').trim();
  return text.length ? text : fallback;
}

function parsePolymarketEventUrl(raw) {
  return parsePolymarketEventUrlFeature(raw);
}

async function handlePolymarketEventUrlInput(ctx, parsedUrl, t) {
  return await handlePolymarketEventUrlInputFeature(ctx, parsedUrl, t);
}

function getLiquidityValue(entity) {
  if (!entity || typeof entity !== 'object') return 0;
  const value = entity.liquidityNum ?? entity.liquidity;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function sortByLiquidityDesc(list) {
  if (!Array.isArray(list)) return [];
  return [...list].sort((a, b) => getLiquidityValue(b) - getLiquidityValue(a));
}

function truncateButtonLabel(raw, maxLength = BUTTON_LABEL_MAX_LEN) {
  const value = normalizeCategoryName(raw, '');
  if (!value) return '';
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.substring(0, maxLength);
  return `${value.substring(0, maxLength - 3)}...`;
}



async function translateUiLabelsForLanguage(language, labels, contextLabel) {
  const normalized = (Array.isArray(labels) ? labels : []).map((label) => normalizeCategoryName(label, ''));
  if (!normalized.length || language !== 'ru') {
    return normalized;
  }

  try {
    const translated = await translateUiTexts(normalized, language, contextLabel);
    return normalized.map((fallback, index) => normalizeCategoryName(translated[index], fallback));
  } catch (error) {
    const ctxLog = createContext('bot', 'translateUiLabelsForLanguage');
    safeLogWarn(ctxLog, 'UI translation failed, using original texts', {
      message: error?.message
    });
    return normalized;
  }
}

async function translateUiLabelForLanguage(language, label, contextLabel) {
  const fallback = normalizeCategoryName(label, '');
  if (!fallback || language !== 'ru') {
    return fallback;
  }

  try {
    const translated = await translateUiText(fallback, language, contextLabel);
    return normalizeCategoryName(translated, fallback);
  } catch (error) {
    const ctxLog = createContext('bot', 'translateUiLabelForLanguage');
    safeLogWarn(ctxLog, 'UI translation failed, using original text', {
      message: error?.message
    });
    return fallback;
  }
}

function normalizeEventTag(tag, t) {
  if (!tag || typeof tag !== 'object') return null;
  const id = tag.id !== null && tag.id !== undefined ? String(tag.id).trim() : '';
  const slug = tag.slug !== null && tag.slug !== undefined ? String(tag.slug).trim().toLowerCase() : '';
  if (!id || !slug) return null;

  return {
    id,
    slug,
    label: normalizeCategoryName(tag.label ?? tag.name ?? tag.slug, t('unknown'))
  };
}

function isOperationalTagSlug(slug) {
  const value = String(slug || '').trim().toLowerCase();
  if (!value) return true;
  if (value === 'hide-from-new' || value === 'recurring' || value === 'up-or-down') return true;
  if (/^\d+[mhdw]$/.test(value)) return true;
  return false;
}

async function collectActiveEventTagStats(t, maxEvents = 1200, batchSize = 200) {
  const bySlug = new Map();

  for (let offset = 0; offset < maxEvents; offset += batchSize) {
    const events = await getEvents(batchSize, offset, null);
    if (!Array.isArray(events) || events.length === 0) {
      break;
    }

    for (const event of events) {
      const tags = Array.isArray(event?.tags) ? event.tags : [];
      for (const rawTag of tags) {
        const normalizedTag = normalizeEventTag(rawTag, t);
        if (!normalizedTag) continue;
        if (isOperationalTagSlug(normalizedTag.slug)) continue;

        const existing = bySlug.get(normalizedTag.slug);
        if (existing) {
          existing.count += 1;
        } else {
          bySlug.set(normalizedTag.slug, {
            id: normalizedTag.id,
            slug: normalizedTag.slug,
            label: normalizedTag.label,
            count: 1
          });
        }
      }
    }

    if (events.length < batchSize) {
      break;
    }
  }

  return bySlug;
}

async function loadCategoryCatalog(t, language) {
  const now = Date.now();
  if (
    Array.isArray(categoriesCatalogCache.items) &&
    now - categoriesCatalogCache.timestamp < CATEGORY_CATALOG_TTL_MS &&
    categoriesCatalogCache.language === language
  ) {
    return categoriesCatalogCache.items;
  }

  let rootCategories = [];
  try {
    const categories = await getCategories();
    rootCategories = (Array.isArray(categories) ? categories : [])
      .filter((category) => !category?.parentCategory);
  } catch (error) {
    const ctxLog = createContext('bot', 'loadCategoryCatalog');
    safeLogWarn(ctxLog, 'Failed to fetch categories taxonomy', {
      message: error?.message
    });
  }

  let categories = [];
  try {
    const activeTagStats = await collectActiveEventTagStats(t);

    if (rootCategories.length > 0) {
      for (const category of rootCategories) {
        const slug = normalizeCategoryName(category.slug, '').toLowerCase();
        if (!slug) continue;

        const stats = activeTagStats.get(slug);
        if (!stats || stats.count <= 0) continue;

        categories.push({
          key: `root:${category.id}`,
          filterValue: stats.id,
          displayName: normalizeCategoryName(category.label, t('unknown')),
          sortCount: stats.count
        });
      }
    }

    // Fallback: if root categories are not resolved to active tags,
    // show most frequent active tags excluding operational/system tags.
    if (categories.length === 0) {
      categories = Array.from(activeTagStats.values())
        .filter((tag) => tag.count >= 2)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
        .slice(0, 24)
        .map((tag) => ({
          key: `tag:${tag.id}`,
          filterValue: tag.id,
          displayName: tag.label,
          sortCount: tag.count
        }));
    }
  } catch (error) {
    const ctxLog = createContext('bot', 'loadCategoryCatalog');
    safeLogWarn(ctxLog, 'Failed to build category catalog from active events', {
      message: error?.message
    });
    categories = [];
  }

  categories.sort((a, b) => {
    const byCount = (b.sortCount || 0) - (a.sortCount || 0);
    if (byCount !== 0) return byCount;
    return String(a.displayName).localeCompare(String(b.displayName));
  });

  const unique = [];
  const seen = new Set();
  for (const category of categories) {
    if (!category?.key || seen.has(category.key)) continue;
    seen.add(category.key);
    unique.push({
      key: category.key,
      filterValue: category.filterValue,
      displayName: category.displayName
    });
  }

  const result = [
    {
      key: CATEGORY_ALL_KEY,
      filterValue: null,
      displayName: t('category_all')
    },
    ...unique
  ];

  setCategoriesCatalogCache({
    items: result,
    timestamp: now,
    language
  });

  return result;
}

async function showMarketCategoriesList(ctx, page = 1) {
  await showMarketCategoriesListFeature(ctx, page);
}

async function showEventsFilterMenu(ctx, nav = {}) {
  await showEventsFilterMenuFeature(ctx, nav);
}

// Show events list - displays unique events filtered by selected category.
// Show events list - displays unique events filtered by selected category.
async function showEventsList(ctx, options = {}) {
  await showEventsListFeature(ctx, options);
}

// Show event details with submarkets
// Show event details with submarkets
async function showEventDetails(ctx, eventRef, nav = {}) {
  await showEventDetailsFeature(ctx, eventRef, nav);
}

// Helper to get cached market by page and index
function getCachedMarket(chatId, page, index) {
  const cacheKey = `markets:${chatId}:${page}`;
  const cached = userStates.get(cacheKey);
  if (!cached || !cached.markets || !cached.markets[index]) {
    return null;
  }
  return cached.markets[index];
}

// Helper to get cached category by page and index
function getCachedCategory(chatId, page, index) {
  const cacheKey = `categories:${chatId}:${page}`;
  const cached = userStates.get(cacheKey);
  if (!cached || !Array.isArray(cached.categories) || !cached.categories[index]) {
    return null;
  }
  return {
    category: cached.categories[index]
  };
}

function getCachedCategoryContext(chatId, categoryToken) {
  const cacheKey = `categoryCtx:${chatId}:${categoryToken}`;
  const cached = userStates.get(cacheKey);
  if (!cached || !cached.category) {
    return null;
  }
  return cached;
}

async function showEventsListByCategoryToken(ctx, categoryToken, eventsPage) {
  return await showEventsListByCategoryTokenFeature(ctx, categoryToken, eventsPage);
}

// Helper to get cached event by category/page/index
function getCachedEvent(chatId, categoryToken, page, index) {
  const cacheKey = `events:${chatId}:${categoryToken}:${page}`;
  const cached = userStates.get(cacheKey);
  if (!cached || !Array.isArray(cached.events) || !cached.events[index]) {
    return null;
  }
  return {
    event: cached.events[index],
    category: cached.category,
    categoriesPage: cached.categoriesPage || 1
  };
}

function getCachedEventDetails(chatId, categoryToken, eventsPage, eventIndex) {
  const detailsKey = `eventDetails:${chatId}:${categoryToken}:${eventsPage}:${eventIndex}`;
  const cached = userStates.get(detailsKey);
  if (!cached || !cached.event) {
    return null;
  }
  return cached;
}

// Helper to get cached submarket from event details
function getCachedSubmarket(chatId, categoryToken, eventsPage, eventIndex, marketIndex) {
  const detailsKey = `eventDetails:${chatId}:${categoryToken}:${eventsPage}:${eventIndex}`;
  const cached = userStates.get(detailsKey);
  if (!cached || !cached.submarkets || !cached.submarkets[marketIndex]) {
    return null;
  }
  return cached.submarkets[marketIndex];
}

// Helper to get cached market details for buy/sell actions
function getCachedMarketDetails(chatId) {
  const cached = getCachedMarketDetailsState(chatId);
  if (!cached) {
    return null;
  }
  return cached.market;
}

function getCachedMarketDetailsState(chatId) {
  const detailsKey = `details:${chatId}`;
  const cached = userStates.get(detailsKey);
  if (!cached || !cached.market) {
    return null;
  }
  return cached;
}

function parseMarketTokensAndOutcomes(marketData, t) {
  let clobTokenIds = [];
  let outcomes = [];
  try {
    if (marketData?.clobTokenIds) {
      clobTokenIds = JSON.parse(marketData.clobTokenIds);
    }
    if (marketData?.outcomes) {
      outcomes = JSON.parse(marketData.outcomes);
    }
  } catch {
    clobTokenIds = [];
    outcomes = [];
  }

  return {
    clobTokenIds,
    outcomes: [
      outcomes[0] || t('yes'),
      outcomes[1] || t('no')
    ]
  };
}

function getActionLabel(actionKey, t) {
  const keyByAction = {
    mb: 'market_buy',
    ms: 'market_sell',
    lb: 'limit_buy',
    ls: 'limit_sell'
  };

  const key = keyByAction[actionKey];
  if (!key) return t('unknown');

  const translated = t(key);
  if (translated !== key) return translated;

  if (actionKey === 'mb') return 'Market Buy';
  if (actionKey === 'ms') return 'Market Sell';
  if (actionKey === 'lb') return 'Limit Buy';
  if (actionKey === 'ls') return 'Limit Sell';
  return t('unknown');
}

function getCachedPosition(chatId, index) {
  const cacheKey = `positions:${chatId}`;
  const cached = userStates.get(cacheKey);
  if (!cached || !Array.isArray(cached.positions) || !cached.positions[index]) {
    return null;
  }
  return cached.positions[index];
}

function getCachedPositions(chatId) {
  const cacheKey = `positions:${chatId}`;
  const cached = userStates.get(cacheKey);
  if (!cached || !Array.isArray(cached.positions)) {
    return [];
  }
  return cached.positions;
}

function setCachedPositions(chatId, positions) {
  const cacheKey = `positions:${chatId}`;
  userStates.set(cacheKey, {
    positions: Array.isArray(positions) ? positions : [],
    timestamp: Date.now()
  });
}

async function refreshPositionsCache(chatId) {
  await ensureClientInitialized();
  const positions = await getPositions();
  setCachedPositions(chatId, positions);
  return positions;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasUnresolvedOnchainPositionLabels(positions) {
  const list = Array.isArray(positions) ? positions : [];
  return list.some((position) => {
    if (String(position?.source || '').trim().toLowerCase() !== 'onchain-explorer') return false;
    const tokenId = normalizeTokenId(position?.token_id ?? position?.tokenId);
    const marketLabel = normalizeTokenId(position?.market ?? position?.market_id ?? position?.marketId);
    return Boolean(tokenId) && tokenId === marketLabel;
  });
}

async function refreshPositionsAfterMutation(chatId, walletAddress, options = {}) {
  const owner = String(walletAddress || '').trim().toLowerCase();
  if (!owner) return [];

  const ctxLog = createContext('bot', 'refreshPositionsAfterMutation');
  let positions = [];
  let shouldRetry = false;
  const sourceTokenId = normalizeTokenId(options?.sourceTokenId);
  const expectedReductionBase = parseBaseUnitsBigIntSafe(options?.expectedReductionBase);

  try {
    invalidateOnchainPositionCaches(owner, { clearAux: true });
    positions = await getPositions(owner, { forceOnchainRefresh: true });
    setCachedPositions(chatId, positions);

    shouldRetry = hasUnresolvedOnchainPositionLabels(positions);

    if (!shouldRetry && sourceTokenId && expectedReductionBase > 0n) {
      const livePosition = positions.find((entry) => getPositionTokenId(entry) === sourceTokenId);
      if (livePosition) {
        const liveBase = parseSharesBaseSafe(livePosition?.size ?? 0);
        if (liveBase >= expectedReductionBase) {
          shouldRetry = true;
        }
      }
    }
  } catch (error) {
    safeLogWarn(ctxLog, 'Post-transaction positions refresh failed on first attempt', {
      walletAddress: owner,
      message: error?.message
    });
    shouldRetry = true;
  }

  if (!shouldRetry) {
    return positions;
  }

  await sleep(POST_TX_POSITIONS_RETRY_DELAY_MS);
  try {
    invalidateOnchainPositionCaches(owner, { clearAux: true });
    positions = await getPositions(owner, { forceOnchainRefresh: true });
    setCachedPositions(chatId, positions);
  } catch (error) {
    safeLogWarn(ctxLog, 'Post-transaction positions refresh retry failed', {
      walletAddress: owner,
      message: error?.message
    });
  }

  return positions;
}

function getCachedOrder(chatId, index) {
  const cacheKey = `orders:${chatId}`;
  const cached = userStates.get(cacheKey);
  if (!cached || !Array.isArray(cached.orders) || !cached.orders[index]) {
    return null;
  }
  return cached.orders[index];
}

function getCachedStrategy(chatId, index) {
  const cacheKey = `strategies:${chatId}`;
  const cached = userStates.get(cacheKey);
  if (!cached || !Array.isArray(cached.strategies) || !cached.strategies[index]) {
    return null;
  }
  return cached.strategies[index];
}

function parseStrategyOrderPair(value) {
  const raw = String(value ?? '').trim();
  const pair = { yes: '', no: '' };
  const extra = [];

  if (!raw) return { ...pair, allIds: [] };

  if (raw.includes('yes:') || raw.includes('no:')) {
    const parts = raw
      .split(';')
      .map((part) => String(part).trim())
      .filter(Boolean);

    for (const part of parts) {
      if (part.startsWith('yes:')) {
        pair.yes = normalizeTokenId(part.slice(4));
      } else if (part.startsWith('no:')) {
        pair.no = normalizeTokenId(part.slice(3));
      } else {
        const id = normalizeTokenId(part);
        if (id) extra.push(id);
      }
    }
  } else {
    const ids = String(raw)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (ids.length > 0) pair.yes = ids[0];
    if (ids.length > 1) pair.no = ids[1];
    if (ids.length > 2) extra.push(...ids.slice(2));
  }

  const allIds = Array.from(new Set([pair.yes, pair.no, ...extra].filter(Boolean)));
  return { ...pair, allIds };
}

function encodeStrategyOrderPair(pair) {
  const yes = normalizeTokenId(pair?.yes);
  const no = normalizeTokenId(pair?.no);
  if (!yes && !no) return null;
  return `yes:${yes};no:${no}`;
}

function extractOrderId(order) {
  const candidates = [order?.id, order?.orderID, order?.orderId, order?.order_id];
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized.length > 0) return normalized;
  }
  return '';
}

function getPositionMarketRef(position) {
  const candidates = [
    position?.slug,
    position?.market_slug,
    position?.marketSlug,
    position?.condition_id,
    position?.conditionId,
    position?.market_id,
    position?.market
  ];

  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized.length > 0) return normalized;
  }

  return String(position?.token_id || 'unknown-market');
}

function getMarketRefValue(marketRef, marketData = null) {
  const candidates = [
    marketData?.slug,
    marketData?.id,
    marketRef?.slug,
    marketRef?.id,
    marketRef,
    marketData?.conditionId
  ];

  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized.length > 0 && normalized !== '[object Object]') return normalized;
  }

  return 'unknown-market';
}

function formatUsdOrNA(value, decimals, t) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return t('na');
  }
  return `$${numeric.toFixed(decimals)}`;
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

function normalizeTokenId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getPositionSharesBaseForToken(positions, tokenId) {
  const targetTokenId = normalizeTokenId(tokenId);
  if (!targetTokenId) return 0n;
  if (!Array.isArray(positions)) return 0n;

  const matched = positions.find((position) => {
    const currentTokenId = normalizeTokenId(position?.token_id ?? position?.tokenId);
    return currentTokenId === targetTokenId;
  });

  if (!matched) return 0n;
  return parseSharesBaseSafe(matched?.size ?? matched?.amount ?? matched?.quantity ?? 0);
}

function isValidMarketAction(actionKey) {
  return actionKey === 'mb' || actionKey === 'ms' || actionKey === 'lb' || actionKey === 'ls';
}

async function showOutcomeSelection(ctx, actionKey, language, t) {
  await showOutcomeSelectionFeature(ctx, actionKey, language, t);
}

async function handleOutcomeSelection(ctx, actionKey, outcomeIndex, language, t) {
  await handleOutcomeSelectionFeature(ctx, actionKey, outcomeIndex, language, t);
}

function parseSharesBaseSafe(value) {
  if (value === null || value === undefined) return 0n;
  const cleaned = String(value).replace(/[^0-9.,]/g, '').trim();
  if (!cleaned) return 0n;
  try {
    return parseSharesToBase(cleaned.replace(',', '.'));
  } catch {
    return 0n;
  }
}



function getPositionTokenId(position) {
  return normalizeTokenId(position?.token_id ?? position?.tokenId ?? position?.asset);
}

function getPositionConditionId(position) {
  return normalizeTokenId(position?.condition_id ?? position?.conditionId);
}

function getPositionOppositeTokenId(position) {
  return normalizeTokenId(position?.oppositeAsset ?? position?.opposite_asset);
}

function parseBooleanLike(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return false;
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}



function hasPositiveNumericField(position, fieldNames) {
  for (const fieldName of fieldNames) {
    if (!(fieldName in (position || {}))) continue;
    const raw = position[fieldName];
    if (raw === null || raw === undefined) continue;
    const parsed = Number(String(raw).replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) {
      return true;
    }
  }
  return false;
}

function canRedeemPosition(position) {
  const conditionId = getPositionConditionId(position);
  if (!conditionId) return false;

  // Check explicit redeemable flags first
  if (parseBooleanLike(position?.redeemable ?? position?.isRedeemable ?? position?.canRedeem)) {
    return true;
  }

  // Check numeric amount fields
  if (hasPositiveNumericField(position, [
    'redeemable_amount',
    'redeemableAmount',
    'claimable',
    'claimable_amount',
    'payout'
  ])) {
    return true;
  }

  // Backup check: curPrice=1 means winning position, realizedPnl=0 means not yet claimed
  // Only applies if these fields exist in the response
  const curPrice = position?.curPrice ?? position?.currentPrice ?? position?.cur_price;
  const realizedPnl = position?.realizedPnl ?? position?.realized_pnl ?? position?.realizedPnl;
  
  if (curPrice !== undefined && Number(curPrice) === 1) {
    // If realizedPnl exists and is > 0, already claimed
    if (realizedPnl !== undefined) {
      const pnl = Number(realizedPnl);
      if (pnl === 0 || pnl === null || isNaN(pnl)) {
        return true;
      }
    } else {
      // No realizedPnl field = not yet claimed
      return true;
    }
  }

  return false;
}

function canSellPosition(position) {
  const tokenId = getPositionTokenId(position);
  if (!tokenId) return false;
  if (position?.sellable === false) return false;
  return !canRedeemPosition(position);
}



function findOppositePositionForMerge(positions, position) {
  const list = Array.isArray(positions) ? positions : [];
  const conditionId = getPositionConditionId(position);
  const oppositeTokenId = getPositionOppositeTokenId(position);
  if (!conditionId || !oppositeTokenId) return null;

  return list.find((candidate) => {
    const candidateConditionId = getPositionConditionId(candidate);
    const candidateTokenId = getPositionTokenId(candidate);
    return candidateConditionId === conditionId && candidateTokenId === oppositeTokenId;
  }) || null;
}

function getMergeablePairSizeBase(primaryPosition, oppositePosition) {
  const primarySizeBase = parseSharesBaseSafe(primaryPosition?.size ?? 0);
  const oppositeSizeBase = parseSharesBaseSafe(oppositePosition?.size ?? 0);
  if (primarySizeBase <= 0n || oppositeSizeBase <= 0n) return 0n;
  return primarySizeBase < oppositeSizeBase ? primarySizeBase : oppositeSizeBase;
}

function resolvePositionMergeInfo(positions, position) {
  const oppositePosition = findOppositePositionForMerge(positions, position);
  if (!oppositePosition) {
    return { available: false, maxMergeBase: 0n, oppositePosition: null };
  }

  const currentMergeable = position?.mergeable !== false;
  const oppositeMergeable = oppositePosition?.mergeable !== false;
  if (!currentMergeable || !oppositeMergeable) {
    return { available: false, maxMergeBase: 0n, oppositePosition };
  }

  const maxMergeBase = getMergeablePairSizeBase(position, oppositePosition);
  return {
    available: maxMergeBase > 0n,
    maxMergeBase,
    oppositePosition
  };
}

function resolveOrderSizeBase(order, keys) {
  const source = order || {};
  for (const key of keys) {
    if (!(key in source)) continue;
    const raw = source[key];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string' && raw.trim().length === 0) continue;
    return parseSharesBaseSafe(raw);
  }
  return 0n;
}

function shortenHexLike(value, start = 8, end = 6) {
  const raw = String(value || '').trim();
  if (raw.length <= start + end + 3) return raw;
  return `${raw.slice(0, start)}...${raw.slice(-end)}`;
}

function isHexLikeId(value) {
  return /^0x[a-fA-F0-9]{16,}$/.test(String(value || '').trim());
}

function getOrderStatusText(status, t) {
  const statusRaw = String(status || t('unknown')).trim();
  const statusLower = statusRaw.toLowerCase();

  switch (statusLower) {
    case 'open':
    case 'live':
      return t('order_status_open');
    case 'filled':
      return t('order_status_filled');
    case 'partial':
    case 'partially_filled':
      return t('order_status_partial');
    case 'cancelled':
      return t('order_status_cancelled');
    default:
      return statusRaw;
  }
}

function getOrderSideText(side, t) {
  const sideRaw = String(side || '').trim();
  const sideLower = sideRaw.toLowerCase();
  if (sideLower === 'buy') return t('buy');
  if (sideLower === 'sell') return t('sell');
  return sideRaw || t('unknown');
}

function isOrderCancellableStatus(status) {
  const statusLower = String(status || '').trim().toLowerCase();
  return statusLower === 'open' || statusLower === 'live' || statusLower === 'partial' || statusLower === 'partially_filled';
}

function getOrderMarketDisplay(order, t) {
  const marketRaw = String(
    order?.question ||
    order?.title ||
    order?.slug ||
    order?.market ||
    order?.condition_id ||
    order?.conditionId ||
    order?.market_id ||
    t('unknown')
  ).trim() || t('unknown');
  if (isHexLikeId(marketRaw)) {
    return `Market ${shortenHexLike(marketRaw)}`;
  }
  return marketRaw;
}

function getOrderTokenId(order) {
  const candidates = [
    order?.token_id,
    order?.tokenId,
    order?.asset,
    order?.asset_id,
    order?.token
  ];

  for (const value of candidates) {
    const normalized = normalizeTokenId(value);
    if (normalized) return normalized;
  }
  return '';
}

function getOrderConditionId(order) {
  const explicit = [
    order?.condition_id,
    order?.conditionId
  ];
  for (const value of explicit) {
    const normalized = normalizeTokenId(value);
    if (normalized) return normalized;
  }

  const fallback = normalizeTokenId(order?.market ?? order?.market_id ?? order?.marketId);
  if (isHexLikeId(fallback)) return fallback;
  return '';
}

function formatSharesCompact(baseValue) {
  const raw = formatSharesFromBase(baseValue);
  return raw.replace(/\.?0+$/, '');
}



function formatOrderRemainingWithNotional(remainingBase, priceNumber, t) {
  const shares = formatSharesCompact(remainingBase);
  if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
    return `${shares} ${t('shares')}`;
  }

  const sharesNumber = Number(formatSharesFromBase(remainingBase));
  if (!Number.isFinite(sharesNumber)) {
    return `${shares} ${t('shares')}`;
  }

  const notional = sharesNumber * priceNumber;
  if (!Number.isFinite(notional)) {
    return `${shares} ${t('shares')}`;
  }

  return `${shares} ${t('shares')} (~$${notional.toFixed(2)})`;
}

function formatStrategyPercentValue(rawStoredPercent) {
  const pct = Number(rawStoredPercent ?? 0) / 100;
  return `${formatSignedPercentValue(pct)}%`;
}

function getStrategyStatusText(status, t) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'active') return t('strategy_status_active');
  if (normalized === 'closed') return t('strategy_status_closed');
  if (normalized === 'partial_close') return t('strategy_status_partial');
  return String(status || t('unknown'));
}

function getPositionSharesForTokenFromList(positions, tokenId) {
  const normalized = normalizeTokenId(tokenId);
  if (!normalized || !Array.isArray(positions)) return 0n;
  const matched = positions.find((pos) => normalizeTokenId(pos?.token_id ?? pos?.tokenId) === normalized);
  return parseSharesBaseSafe(matched?.size ?? 0);
}

function shortOrderIdOrNA(orderId, t) {
  const normalized = String(orderId || '').trim();
  if (!normalized) return t('na');
  return shortenHexLike(normalized);
}

function formatStrategyOrderStatus(orderRow, t) {
  const statusRaw = String(orderRow?.status || '').trim();
  if (!statusRaw) return t('na');
  return getOrderStatusText(statusRaw, t);
}

async function resolveOrderMarketDisplay(order, t, resolverCache) {
  const tokenId = getOrderTokenId(order);
  if (tokenId && resolverCache.byTokenId.has(tokenId)) {
    return resolverCache.byTokenId.get(tokenId);
  }

  const conditionId = getOrderConditionId(order);
  if (conditionId && resolverCache.byConditionId.has(conditionId)) {
    return resolverCache.byConditionId.get(conditionId);
  }

  const direct = String(order?.question || order?.title || '').trim();
  if (direct) {
    if (tokenId) resolverCache.byTokenId.set(tokenId, direct);
    if (conditionId) resolverCache.byConditionId.set(conditionId, direct);
    return direct;
  }

  const marketRef = String(order?.slug || order?.market || order?.market_id || order?.marketId || '').trim();
  const remember = (value) => {
    if (tokenId) resolverCache.byTokenId.set(tokenId, value);
    if (conditionId) resolverCache.byConditionId.set(conditionId, value);
    if (marketRef) resolverCache.byMarketRef.set(marketRef, value);
  };

  const resolveFromCachedMarket = async (cachedMarket) => {
    const marketId = String(cachedMarket?.id || '').trim();
    if (!marketId) return null;

    if (resolverCache.byMarketRef.has(marketId)) {
      return resolverCache.byMarketRef.get(marketId);
    }

    try {
      const details = await getMarketDetails(marketId);
      const label = String(details?.question || details?.title || details?.slug || marketId).trim();
      resolverCache.byMarketRef.set(marketId, label);
      return label;
    } catch {
      resolverCache.byMarketRef.set(marketId, marketId);
      return marketId;
    }
  };

  if (tokenId) {
    try {
      const cachedByToken = await getMarketCacheByTokenId(tokenId);
      const label = await resolveFromCachedMarket(cachedByToken);
      if (label) {
        remember(label);
        return label;
      }
    } catch {}
  }

  if (conditionId) {
    try {
      const cachedByCondition = await getMarketCacheByConditionId(conditionId);
      const label = await resolveFromCachedMarket(cachedByCondition);
      if (label) {
        remember(label);
        return label;
      }
    } catch {}
  }

  const fallback = getOrderMarketDisplay(order, t);
  remember(fallback);
  return fallback;
}

function applyPercentToPriceMicro(priceMicro, percent) {
  if (typeof priceMicro !== 'bigint' || priceMicro <= 0n) return 0n;
  const bps = Math.round(Number(percent) * 100);
  const scale = 10_000n;
  let result = (priceMicro * BigInt(10_000 + bps)) / scale;
  // CLOB price bounds for limit orders: 0.01 .. 0.99
  if (result < 10_000n) result = 10_000n;
  if (result > 990_000n) result = 990_000n;
  return result;
}

function getResultErrorMessage(result, t) {
  const candidates = [
    result?.error,
    result?.errorMsg,
    result?.message,
    result?.reason,
    result?.data?.error,
    result?.data?.errorMsg,
    result?.data?.message,
    result?.response?.data?.error,
    result?.response?.data?.errorMsg,
    result?.response?.data?.message,
    result?.statusText,
    result?.status
  ];

  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text.length > 0 && text !== '[object Object]') {
      return text.substring(0, 220);
    }
  }

  return t('unknown');
}

function getTxHashFromResult(result) {
  const hash = result?.transactionHash || result?.txHash || result?.hash;
  if (!hash) return null;
  const text = String(hash).trim();
  return text.length > 0 ? text : null;
}





function buildUsdcPercentKeyboard(prefix, t) {
  return new InlineKeyboard()
    .text('5%', `${prefix}:5`)
    .text('10%', `${prefix}:10`)
    .text('20%', `${prefix}:20`)
    .row()
    .text('30%', `${prefix}:30`)
    .text('50%', `${prefix}:50`)
    .text('100%', `${prefix}:100`)
    .row()
    .text(t('cancel'), 'cancel');
}

function buildSharesPercentKeyboard(prefix, t) {
  return new InlineKeyboard()
    .text('1%', `${prefix}:1`)
    .text('5%', `${prefix}:5`)
    .text('10%', `${prefix}:10`)
    .row()
    .text('25%', `${prefix}:25`)
    .text('50%', `${prefix}:50`)
    .text('100%', `${prefix}:100`)
    .row()
    .text(t('cancel'), 'cancel');
}



function buildLimitPriceKeyboard(t) {
  return new InlineKeyboard()
    .text(t('limit_price_current'), 'lppct:cur')
    .row()
    .text('-50%', 'lppct:-50')
    .text('-25%', 'lppct:-25')
    .text('-10%', 'lppct:-10')
    .row()
    .text('-5%', 'lppct:-5')
    .text('+5%', 'lppct:5')
    .text('+10%', 'lppct:10')
    .row()
    .text('+25%', 'lppct:25')
    .text('+50%', 'lppct:50')
    .row()
    .text(t('cancel'), 'cancel');
}

async function getTokenSharesBalanceBase(tokenId) {
  await ensureClientInitialized();
  const positions = await getPositions();
  return getPositionSharesBaseForToken(positions, tokenId);
}

async function showBuyAmountPrompt(ctx, state, t, balanceBase = null, sideSharesBalanceBase = null) {
  const chatId = ctx.chat.id;
  const balanceDisplay = balanceBase !== null ? formatUSDCFromBase(balanceBase) : t('na');
  const sideSharesDisplay = sideSharesBalanceBase !== null ? formatSharesFromBase(sideSharesBalanceBase) : t('na');
  const text =
    `${t('enter_amount_usdc')}\n\n` +
    `${t('collateral_balance', { amount: balanceDisplay })}\n` +
    `${t('selected_side_balance', { side: state.side || t('unknown'), amount: sideSharesDisplay })}`;

  userStates.set(chatId, {
    ...state,
    state: 'AWAITING_BUY_AMOUNT',
    collateralBalanceBase: balanceBase !== null ? balanceBase.toString() : null,
    sideSharesBalanceBase: sideSharesBalanceBase !== null ? sideSharesBalanceBase.toString() : null
  });

  await ctx.editMessageText(text, {
    reply_markup: buildUsdcPercentKeyboard('buypct', t)
  });
}

async function showBuyConfirmation(ctx, state, usdcBase, t) {
  const chatId = ctx.chat.id;

  // Initialize client
  await ensureClientInitialized();

  // Get current price
  const { bestBidStr, bestAskStr } = await getBestBidAsk(state.tokenId);
  const price = bestAskStr || bestBidStr || '0.5';
  const priceMicro = parsePriceToMicro(price);

  // Calculate estimated shares using bigint math
  const estimatedShares = computeSharesFromUSDC(usdcBase, priceMicro);
  const estimatedSharesFormatted = formatSharesFromBase(estimatedShares);

  // Show confirmation with formatted amounts
  const confirmText = t('buy_confirm', {
    side: state.side,
    amount: formatUSDCFromBase(usdcBase),
    shares: estimatedSharesFormatted,
    price: formatPriceFromMicro(priceMicro)
  });

  const keyboard = new InlineKeyboard()
    .text(t('confirm'), 'confirm_buy')
    .text(t('cancel'), 'cancel_confirmation');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(confirmText, { reply_markup: keyboard });
  } else {
    await ctx.reply(confirmText, { reply_markup: keyboard });
  }

  // Update state to confirmation with bigint values
  userStates.set(chatId, {
    ...state,
    state: 'CONFIRMING_BUY',
    usdcBase,
    estimatedShares,
    priceMicro
  });
}

async function showSplitAmountPrompt(ctx, state, t, balanceBase = null) {
  const chatId = ctx.chat.id;
  const balanceDisplay = balanceBase !== null ? formatUSDCFromBase(balanceBase) : t('na');
  const text = `${t('enter_amount_split')}\n\n${t('collateral_balance', { amount: balanceDisplay })}`;

  userStates.set(chatId, {
    ...state,
    state: 'AWAITING_SPLIT_AMOUNT',
    collateralBalanceBase: balanceBase !== null ? balanceBase.toString() : null
  });

  await ctx.editMessageText(text, {
    reply_markup: buildUsdcPercentKeyboard('splitpct', t)
  });
}

async function showSplitConfirmation(ctx, state, amountBase, t) {
  const chatId = ctx.chat.id;

  // Show confirmation with formatted amount
  const confirmText = t('split_confirm', { amount: formatUSDCFromBase(amountBase) });

  const keyboard = new InlineKeyboard()
    .text(t('confirm'), 'confirm_split')
    .text(t('cancel'), 'cancel_confirmation');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(confirmText, { reply_markup: keyboard });
  } else {
    await ctx.reply(confirmText, { reply_markup: keyboard });
  }

  // Update state to confirmation with bigint value
  userStates.set(chatId, {
    ...state,
    state: 'CONFIRMING_SPLIT',
    amountBase
  });
}

async function showPositionDetailsFromCache(ctx, index) {
  await showPositionDetailsFromCacheFeature(ctx, index);
}

async function startSellFromCachedPosition(ctx, index) {
  await startSellFromCachedPositionFeature(ctx, index);
}

async function startMergeFromCachedPosition(ctx, index) {
  await startMergeFromCachedPositionFeature(ctx, index);
}

async function startRedeemFromCachedPosition(ctx, index) {
  await startRedeemFromCachedPositionFeature(ctx, index);
}

// Show market details - does NOT require initialized clobClient for basic info
async function showMarketDetails(ctx, marketRef, nav = {}) {
  await showMarketDetailsFeature(ctx, marketRef, nav);
}

// Start buy flow - requires wallet
async function startBuyFlow(ctx, slug, tokenId, side) {
  await startBuyFlowFeature(ctx, slug, tokenId, side);
}

// Handle buy amount input
async function handleBuyAmount(ctx, state, text) {
  await handleBuyAmountFeature(ctx, state, text);
}

// Execute confirmed buy
async function executeConfirmedBuy(ctx) {
  await executeConfirmedBuyFeature(ctx);
}

// Start sell flow - requires wallet
async function startSellFlow(ctx, slug, tokenId, side, meta = {}) {
  await startSellFlowFeature(ctx, slug, tokenId, side, meta);
}

// Handle sell percentage selection
async function handleSellPercent(ctx, percent) {
  await handleSellPercentFeature(ctx, percent);
}

// Handle sell amount input (for manual entry)
async function handleSellAmount(ctx, state, text) {
  await handleSellAmountFeature(ctx, state, text);
}

// Execute confirmed sell
async function executeConfirmedSell(ctx) {
  await executeConfirmedSellFeature(ctx);
}

async function startLimitFlow(ctx, slug, tokenId, sideLabel, tradeSide) {
  await startLimitFlowFeature(ctx, slug, tokenId, sideLabel, tradeSide);
}

async function handleLimitAmount(ctx, state, text) {
  await handleLimitAmountFeature(ctx, state, text);
}

async function showLimitPricePrompt(ctx, state, t, useEdit = false) {
  const chatId = ctx.chat.id;
  let referencePriceMicro = 500_000n;
  try {
    await ensureClientInitialized();
    const { bestBidStr, bestAskStr } = await getBestBidAsk(state.tokenId);
    const reference = state.tradeSide === 'buy'
      ? (bestAskStr || bestBidStr || '0.5')
      : (bestBidStr || bestAskStr || '0.5');
    referencePriceMicro = parsePriceMicroSafe(reference);
    if (referencePriceMicro <= 0n) {
      referencePriceMicro = 500_000n;
    }
  } catch (error) {
    const ctxLog = createContext('bot', 'showLimitPricePrompt');
    safeLogWarn(ctxLog, 'Could not fetch reference price for limit prompt', {
      tokenId: state.tokenId,
      message: error?.message
    });
  }

  userStates.set(chatId, {
    ...state,
    state: 'AWAITING_LIMIT_PRICE',
    referencePriceMicro
  });

  const text =
    `${t('limit_enter_price')}\n\n` +
    `${t('limit_price_reference', { price: formatPriceFromMicro(referencePriceMicro) })}`;

  if (useEdit && ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      reply_markup: buildLimitPriceKeyboard(t)
    });
  } else {
    await ctx.reply(text, {
      reply_markup: buildLimitPriceKeyboard(t)
    });
  }
}

async function showLimitConfirmation(ctx, state, priceMicro, t, useEdit = false) {
  const chatId = ctx.chat.id;
  if (priceMicro <= 0n || priceMicro >= 1_000_000n) {
    const message = t('limit_invalid_price');
    if (useEdit && ctx.callbackQuery) {
      await ctx.editMessageText(message, {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      });
    } else {
      await ctx.reply(message, {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      });
    }
    return;
  }

  const isBuy = state.tradeSide === 'buy';
  let sharesBase = 0n;
  let amountDisplay = '0';
  let confirmKey = 'limit_confirm_sell';

  if (isBuy) {
    const usdcBase = BigInt(state.usdcBase ?? 0);
    sharesBase = computeSharesFromUSDC(usdcBase, priceMicro);
    if (sharesBase <= 0n) {
      const message = t('limit_amount_too_small');
      if (useEdit && ctx.callbackQuery) {
        await ctx.editMessageText(message, {
          reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
        });
      } else {
        await ctx.reply(message, {
          reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
        });
      }
      return;
    }
    amountDisplay = formatUSDCFromBase(usdcBase);
    confirmKey = 'limit_confirm_buy';
  } else {
    sharesBase = BigInt(state.sharesBase ?? 0);
    if (sharesBase <= 0n) {
      const message = t('error_no_positions');
      if (useEdit && ctx.callbackQuery) {
        await ctx.editMessageText(message, {
          reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
        });
      } else {
        await ctx.reply(message, {
          reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
        });
      }
      return;
    }
    const estimatedUsdc = computeUSDCFromShares(sharesBase, priceMicro);
    amountDisplay = formatUSDCFromBase(estimatedUsdc);
    confirmKey = 'limit_confirm_sell';
  }

  if (sharesBase < MIN_LIMIT_ORDER_SHARES_BASE) {
    const message = t('limit_min_size', { min: formatSharesFromBase(MIN_LIMIT_ORDER_SHARES_BASE) });
    if (useEdit && ctx.callbackQuery) {
      await ctx.editMessageText(message, {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      });
    } else {
      await ctx.reply(message, {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      });
    }
    return;
  }

  const confirmText = t(confirmKey, {
    action: isBuy ? t('buy') : t('sell'),
    side: state.sideLabel || t('unknown'),
    amount: amountDisplay,
    shares: formatSharesFromBase(sharesBase),
    price: formatPriceFromMicro(priceMicro)
  });

  const keyboard = new InlineKeyboard()
    .text(t('confirm'), 'confirm_limit')
    .text(t('cancel'), 'cancel_confirmation');

  if (useEdit && ctx.callbackQuery) {
    await ctx.editMessageText(confirmText, { reply_markup: keyboard });
  } else {
    await ctx.reply(confirmText, { reply_markup: keyboard });
  }

  userStates.set(chatId, {
    ...state,
    state: 'CONFIRMING_LIMIT',
    priceMicro,
    sharesBase
  });
}

async function handleLimitPrice(ctx, state, text) {
  await handleLimitPriceFeature(ctx, state, text);
}

async function handleLimitBuyPercent(ctx, percent) {
  await handleLimitBuyPercentFeature(ctx, percent);
}

async function handleLimitSellPercent(ctx, percent) {
  await handleLimitSellPercentFeature(ctx, percent);
}

async function handleLimitPricePreset(ctx, preset) {
  await handleLimitPricePresetFeature(ctx, preset);
}

async function executeConfirmedLimit(ctx) {
  await executeConfirmedLimitFeature(ctx);
}

// Show positions - requires wallet
async function showPositions(ctx) {
  await showPositionsFeature(ctx);
}

async function showStrategies(ctx) {
  await showStrategiesFeature(ctx);
}

async function showStrategyDetailsFromCache(ctx, index) {
  await showStrategyDetailsFromCacheFeature(ctx, index);
}

async function startCloseStrategyFromCache(ctx, index) {
  await startCloseStrategyFromCacheFeature(ctx, index);
}

async function executeConfirmedStrategyClose(ctx) {
  await executeConfirmedStrategyCloseFeature(ctx);
}

// Handle buy percentage selection (percent of available USDC collateral)
async function handleBuyPercent(ctx, percent) {
  await handleBuyPercentFeature(ctx, percent);
}

// Show orders - requires wallet
async function showOrders(ctx) {
  await showOrdersFeature(ctx);
}

async function showOrderDetailsFromCache(ctx, index) {
  await showOrderDetailsFromCacheFeature(ctx, index);
}

async function cancelCachedOrder(ctx, index) {
  await cancelCachedOrderFeature(ctx, index);
}





function extractStrategyTokenPair(market, t) {
  const parsed = parseMarketTokensAndOutcomes(market, t);
  const tokenIds = Array.isArray(parsed.clobTokenIds) ? parsed.clobTokenIds.map((id) => normalizeTokenId(id)) : [];
  const outcomes = Array.isArray(parsed.outcomes) ? parsed.outcomes : [t('yes'), t('no')];

  let tokenIdYes = tokenIds[0] || '';
  let tokenIdNo = tokenIds[1] || '';
  let outcomeYes = outcomes[0] || t('yes');
  let outcomeNo = outcomes[1] || t('no');

  if ((!tokenIdYes || !tokenIdNo) && Array.isArray(market?.tokens)) {
    const tokens = market.tokens.filter(Boolean);
    const yesLike = tokens.find((token) => /^(yes|up)$/i.test(String(token?.outcome || '').trim()));
    const noLike = tokens.find((token) => /^(no|down)$/i.test(String(token?.outcome || '').trim()));

    const first = yesLike || tokens[0];
    const second = noLike && noLike !== first
      ? noLike
      : tokens.find((token) => token !== first) || tokens[1];

    if (first) {
      tokenIdYes = tokenIdYes || normalizeTokenId(first.token_id);
      outcomeYes = first.outcome || outcomeYes;
    }
    if (second) {
      tokenIdNo = tokenIdNo || normalizeTokenId(second.token_id);
      outcomeNo = second.outcome || outcomeNo;
    }
  }

  return { tokenIdYes, tokenIdNo, outcomeYes, outcomeNo };
}





async function startStrategyFlowFromMarket(ctx, marketRef) {
  await startStrategyFlowFromMarketFeature(ctx, marketRef);
}

async function handleStrategySplitAmount(ctx, state, text) {
  await handleStrategySplitAmountFeature(ctx, state, text);
}

async function handleStrategySplitPercent(ctx, percent) {
  await handleStrategySplitPercentFeature(ctx, percent);
}

async function executeConfirmedStrategySplit(ctx) {
  await executeConfirmedStrategySplitFeature(ctx);
}

// Start split flow
async function startSplitFlow(ctx, marketRef) {
  await startSplitFlowFeature(ctx, marketRef);
}

// Handle split amount input
async function handleSplitAmount(ctx, state, text) {
  await handleSplitAmountFeature(ctx, state, text);
}

// Handle split percentage selection (percent of available USDC collateral)
async function handleSplitPercent(ctx, percent) {
  await handleSplitPercentFeature(ctx, percent);
}

// Execute confirmed split
async function executeConfirmedSplit(ctx) {
  await executeConfirmedSplitFeature(ctx);
}

// Start merge flow
async function startMergeFlow(ctx, marketRef) {
  await startMergeFlowFeature(ctx, marketRef);
}

// Handle merge amount input
async function handleMergeAmount(ctx, state, text) {
  await handleMergeAmountFeature(ctx, state, text);
}

async function handleMergeMax(ctx) {
  await handleMergeMaxFeature(ctx);
}

// Execute confirmed merge
async function executeConfirmedMerge(ctx) {
  await executeConfirmedMergeFeature(ctx);
}

async function executeConfirmedRedeem(ctx) {
  await executeConfirmedRedeemFeature(ctx);
}

// Show settings
async function showSettings(ctx) {
  await showSettingsFeature(ctx);
}

async function showStrategySettings(ctx, useEdit = true) {
  await showStrategySettingsFeature(ctx, useEdit);
}

async function showNotificationSettings(ctx, useEdit = true) {
  await showNotificationSettingsFeature(ctx, useEdit);
}











async function startStrategySettingsEdit(ctx, field) {
  await startStrategySettingsEditFeature(ctx, field);
}

async function handleStrategySettingsInput(ctx, state, text) {
  await handleStrategySettingsInputFeature(ctx, state, text);
}

async function startNotificationSettingsEdit(ctx, field) {
  await startNotificationSettingsEditFeature(ctx, field);
}

async function handleNotificationSettingsInput(ctx, state, text) {
  await handleNotificationSettingsInputFeature(ctx, state, text);
}

function createMessageEditContext(chatId, messageId) {
  return {
    chat: { id: chatId },
    editMessageText: async (text, options = {}) => {
      if (!bot) {
        throw new Error('Bot not initialized');
      }
      return bot.api.editMessageText(chatId, messageId, text, options);
    }
  };
}

async function handleEventsFilterRangeInput(ctx, state, text) {
  await handleEventsFilterRangeInputFeature(ctx, state, text);
}

// Handle withdraw address input
async function handleWithdrawAddress(ctx, text) {
  await handleWithdrawAddressFeature(ctx, text);
}

// Handle withdraw amount input
async function handleWithdrawAmount(ctx, text) {
  await handleWithdrawAmountFeature(ctx, text);
}

// Handle wallet initialization
// Handle wallet initialization
async function handleInitWallet(ctx) {
  await handleInitWalletFeature(ctx);
}

// Handle set allowances
// Handle set allowances
async function handleSetAllowances(ctx) {
  await handleSetAllowancesFeature(ctx);
}

// Handle collateral status display
// Handle collateral status display
async function handleCollateralStatus(ctx) {
  await handleCollateralStatusFeature(ctx);
}

// Handle start export private key flow
// Handle start export private key flow
async function handleStartExportPk(ctx) {
  await handleStartExportPkFeature(ctx);
}

// Handle confirm export private key (after warning)
// Handle confirm export private key (after warning)
async function handleConfirmExportPk(ctx) {
  await handleConfirmExportPkFeature(ctx);
}

// Handle cancel export private key
// Handle cancel export private key
async function handleCancelExportPk(ctx) {
  await handleCancelExportPkFeature(ctx);
}

// Handle withdraw flow entry point
async function startWithdrawFlow(ctx) {
  await startWithdrawFlowFeature(ctx);
}

// Handle withdraw percent button
async function handleWithdrawPercent(ctx, percent) {
  await handleWithdrawPercentFeature(ctx, percent);
}

// Execute confirmed withdraw
async function executeWithdraw(ctx) {
  await executeWithdrawFeature(ctx);
}

// Handle confirmation input for export
// Handle confirmation input for export
async function handleExportConfirmation(ctx, state, text) {
  await handleExportConfirmationFeature(ctx, state, text);
}

// Helper: Ensure CLOB client is initialized
// Helper: Ensure CLOB client is initialized
async function ensureClientInitialized() {
  await ensureClientInitializedFeature();
}

// Helper: Ensure contracts are initialized
// Helper: Ensure contracts are initialized
async function ensureContractsInitialized() {
  await ensureContractsInitializedFeature();
}

// Automatically set required approvals on first trading interaction.
// Automatically set required approvals on first trading interaction.
async function ensureAutoAllowancesConfigured() {
  await ensureAutoAllowancesConfiguredFeature();
}

// Send message to user
export async function sendMessage(chatId, text, options = {}) {
  if (!bot) {
    throw new Error('Bot not initialized. Call initBot() first.');
  }

  return await bot.api.sendMessage(chatId, text, options);
}

// Send notification
export async function sendNotification(chatId, message, options = {}) {
  return await sendMessage(chatId, `\uD83D\uDD14 ${message}`, options);
}

const {
  sendPriceAlertNotification: sendPriceAlertNotificationFeature,
  sendStrategyMarketAlertNotification: sendStrategyMarketAlertNotificationFeature
} = createNotificationsFeature({
  sendNotification
});

// Send localized price-alert notification (text + buttons).
// Calculations stay in workers; this function only formats UI.
export async function sendPriceAlertNotification(chatId, payload = {}) {
  await sendPriceAlertNotificationFeature(chatId, payload);
}

// Send strategy-market opportunity notification.
// Worker performs scanning/filtering; this function only renders Telegram UI.
export async function sendStrategyMarketAlertNotification(chatId, payload = {}) {
  await sendStrategyMarketAlertNotificationFeature(chatId, payload);
}

// Show main menu
export async function showMainMenu(chatId) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');

  await sendMessage(chatId, t('main_menu'), {
    reply_markup: await getMainMenuKeyboard(config.language || 'ru')
  });
}

// Start bot
export function startBot() {
  if (!bot) {
    throw new Error('Bot not initialized. Call initBot() first.');
  }

  bot.start();
  const ctx = createContext('bot', 'startBot');
  safeLogInfo(ctx, 'Bot started');
}

// Stop bot
export function stopBot() {
  if (bot) {
    bot.stop();
    const ctx = createContext('bot', 'stopBot');
    safeLogInfo(ctx, 'Bot stopped');
  }
}

// Placeholder exports for future implementation
export async function showMarketCategories(chatId) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, t('categories_title', { page: 1 }));
}

export async function showMarketsListLegacy(chatId, category, page) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, t('markets_title', { page: page || 1 }));
}

export async function showMarketPage(chatId, marketSlug) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, t('market_details'));
}

export async function handleBuyMarket(chatId, marketSlug, tokenId, side) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, `${t('buy')} ${side}`);
}

export async function handleSellMarket(chatId, marketSlug, tokenId, side) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, `${t('sell')} ${side}`);
}

export async function handleBuyLimit(chatId, marketSlug, tokenId, side) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, `${t('limit_buy')}: ${t('select_market_first', { action: t('buy') })}`);
}

export async function handleSellLimit(chatId, marketSlug, tokenId, side) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, `${t('limit_sell')}: ${t('select_market_first', { action: t('sell') })}`);
}

export async function handleSplitLegacy(chatId, marketSlug, conditionId) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, t('split'));
}

export async function handleMergeLegacy(chatId, marketSlug, conditionId, yesTokenId, noTokenId) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, t('merge'));
}

export async function showPositionDetails(chatId, positionId) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, 'Position details feature coming in Phase 2+');
}

export async function showActiveStrategies(chatId) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const strategies = await getDbActiveStrategies();

  if (!strategies || strategies.length === 0) {
    await sendMessage(chatId, t('no_active_strategies'));
    return;
  }

  let text = `${t('menu_settings')}: strategies\n\n`;
  for (const strategy of strategies) {
    text += `#${strategy.id} ${strategy.market_id}\n`;
    text += `status: ${strategy.status}\n`;
    if (strategy.order_id_take) text += `TP: ${strategy.order_id_take}\n`;
    if (strategy.order_id_stop) text += `SL: ${strategy.order_id_stop}\n`;
    text += '\n';
  }
  await sendMessage(chatId, text);
}

export async function handleStartStrategy(chatId, marketSlug) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, `${t('strategy_start')}: ${t('select_market_first', { action: t('strategy_start') })}`);
}

export async function handleIncreasePosition(chatId, strategyId) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, t('error_generic'));
}

export async function handlePartialClose(chatId, strategyId) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, t('error_generic'));
}

export async function handleCloseStrategy(chatId, strategyId) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  if (!strategyId) {
    await sendMessage(chatId, t('error_generic'));
    return;
  }
  await updateStrategy(strategyId, { status: 'closed' });
  await sendMessage(chatId, t('strategy_closed', { id: strategyId }));
}

export async function handleLanguageChange(chatId, language) {
  const t = await getTranslator((await loadConfig()).language || 'ru');
  await sendMessage(chatId, `Language change to ${language} - Coming soon`);
}

export async function handleExportPrivateKey(chatId) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  
  // This is a legacy placeholder - the actual export flow is handled via callbacks
  // This function is kept for API compatibility
  await sendMessage(chatId, t('export_pk_wallet_missing'), {
    reply_markup: new InlineKeyboard().text(t('back'), 'settings')
  });
}




