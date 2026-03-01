import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { createContext, safeLogError } from '../../logger.js';
import { mapErrorToUserMessage } from '../../polymarket.js';
import { EVENT_DETAILS_SUBMARKETS_PAGE_SIZE } from '../constants.js';
import { busyLocks, confirmationLocks, userStates } from '../runtime.js';

export function createHandleCallbackRouter(deps) {
  const {
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
    startWithdrawFlow,
    executeWithdraw,
    handleWithdrawAddress,
    handleWithdrawAmount,
    handleWithdrawPercent,
    handleStartExportPk,
    handleConfirmExportPk,
    handleCancelExportPk,
    showLanguageSettings,
    handleSettingsLanguageChange
  } = deps;

  return async function handleCallback(ctx) {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat.id;
    const isConfirmCallback = data.startsWith('confirm_');
    if (isConfirmCallback) {
      if (confirmationLocks.get(chatId)) {
        try {
          await ctx.answerCallbackQuery();
        } catch {}
        return;
      }
      confirmationLocks.set(chatId, true);
    }

    try {
      const config = await loadConfig();
      const language = config.language || 'ru';
      const t = await getTranslator(language);
      let callbackAnswered = false;
      const answerCallback = async (text) => {
        if (callbackAnswered) return;
        try {
          if (text) {
            await ctx.answerCallbackQuery(text);
          } else {
            await ctx.answerCallbackQuery();
          }
          callbackAnswered = true;
        } catch {
          callbackAnswered = true;
        }
      };
      
      // Handle language selection first (works even without language configured)
      if (data.startsWith('select_lang:')) {
        const lang = data.split(':')[1];
        await handleLanguageSelection(ctx, lang);
        await answerCallback();
        return;
      }
      
      // Block all operations while busy except explicit cancel actions.
      const isCancelAction = data === 'cancel_confirmation' || data === 'cancel_export_pk';
      if (busyLocks.get(chatId) && !isCancelAction) {
        await answerCallback(t('error_busy'));
        return;
      }

      try {
      // Confirm callback immediately to avoid Telegram query timeout
      // during long-running operations (RPC/allowance/order placement).
      await answerCallback();

      if (data.startsWith('markets:')) {
        const page = parseInt(data.split(':')[1], 10) || 1;
        await showMarketCategoriesList(ctx, page);
      } else if (data.startsWith('strategy_markets:')) {
        const page = parseInt(data.split(':')[1], 10) || 1;
        await showStrategyMarketsList(ctx, page, false);
      } else if (data.startsWith('smrefresh:')) {
        const page = parseInt(data.split(':')[1], 10) || 1;
        await showStrategyMarketsList(ctx, page, true);
      } else if (data.startsWith('smopen:')) {
        const parts = data.split(':');
        const page = parseInt(parts[1], 10) || 1;
        const index = parseInt(parts[2], 10) || 0;
        const cached = getCachedStrategyMarket(ctx.chat.id, page, index);
        if (!cached?.market) {
          await showStrategyMarketsList(ctx, page, true);
        } else {
          await showMarketDetails(ctx, cached.market, {
            backCallback: `strategy_markets:${page}`,
            retryCallback: `smopen:${page}:${index}`
          });
        }
      } else if (data.startsWith('smaopen:')) {
        const marketRef = String(data.slice('smaopen:'.length) || '').trim();
        if (!marketRef) {
          await answerCallback(t('error_generic'));
        } else {
          await showMarketDetails(ctx, marketRef, {
            backCallback: 'strategy_markets:1',
            retryCallback: `smaopen:${marketRef}`
          });
        }
      } else if (data.startsWith('smastr:')) {
        const marketRef = String(data.slice('smastr:'.length) || '').trim();
        if (!marketRef) {
          await answerCallback(t('error_generic'));
        } else {
          await startStrategyFlowFromMarket(ctx, marketRef);
        }
      } else if (data.startsWith('cat:')) {
        // Category selection: cat:<categoriesPage>:<categoryIndex>
        const parts = data.split(':');
        const categoriesPage = parseInt(parts[1], 10) || 1;
        const categoryIndex = parseInt(parts[2], 10) || 0;
        const categoryEntry = getCachedCategory(chatId, categoriesPage, categoryIndex);
        if (!categoryEntry) {
          await showMarketCategoriesList(ctx, categoriesPage);
        } else {
          await showEventsList(ctx, {
            category: categoryEntry.category,
            categoryToken: getCategoryToken(categoriesPage, categoryIndex),
            categoriesPage,
            page: 1
          });
        }
      } else if (data.startsWith('evs:')) {
        // Back to events list: evs:<categoryToken>:<eventsPage>
        const parts = data.split(':');
        const categoryToken = parts[1];
        const page = parseInt(parts[2], 10) || 1;
        const categoryContext = getCachedCategoryContext(chatId, categoryToken);
        if (!categoryContext) {
          await showMarketCategoriesList(ctx, 1);
        } else {
          await showEventsList(ctx, {
            category: categoryContext.category,
            categoryToken,
            categoriesPage: categoryContext.categoriesPage,
            page
          });
        }
      } else if (data.startsWith('ef:')) {
        // Events filter menu: ef:<categoryToken>:<eventsPage>
        const parts = data.split(':');
        const categoryToken = parts[1];
        const eventsPage = parseInt(parts[2], 10) || 1;
        if (userStates.get(chatId)?.state === 'AWAITING_EVENTS_FILTER_RANGE') {
          userStates.delete(chatId);
        }
        await showEventsFilterMenu(ctx, { categoryToken, eventsPage });
      } else if (data.startsWith('efset:')) {
        // Apply events filter preset: efset:<categoryToken>:<eventsPage>:<preset>
        const parts = data.split(':');
        const categoryToken = parts[1];
        const eventsPage = parseInt(parts[2], 10) || 1;
        const preset = parts[3] || 'off';
        if (userStates.get(chatId)?.state === 'AWAITING_EVENTS_FILTER_RANGE') {
          userStates.delete(chatId);
        }
        applyEventsPriceFilterPreset(chatId, preset);
        await showEventsListByCategoryToken(ctx, categoryToken, eventsPage);
      } else if (data.startsWith('efcustom:')) {
        // Await manual events filter input: efcustom:<categoryToken>:<eventsPage>
        const parts = data.split(':');
        const categoryToken = parts[1];
        const eventsPage = parseInt(parts[2], 10) || 1;
        userStates.set(chatId, {
          state: 'AWAITING_EVENTS_FILTER_RANGE',
          categoryToken,
          eventsPage,
          originMessageId: ctx.callbackQuery?.message?.message_id ?? null
        });
        await ctx.editMessageText(t('events_filter_prompt_custom'), {
          reply_markup: new InlineKeyboard()
            .text(t('back'), buildEventsFilterCallback(categoryToken, eventsPage))
        });
      } else if (data.startsWith('evd:')) {
        // Back to event details: evd:<categoryToken>:<eventsPage>:<eventIndex>[:<submarketsPage>]
        const parts = data.split(':');
        const categoryToken = parts[1];
        const eventsPage = parseInt(parts[2], 10) || 1;
        const eventIndex = parseInt(parts[3], 10) || 0;
        const submarketsPage = parseInt(parts[4], 10) || 1;
        const cachedDetails = getCachedEventDetails(chatId, categoryToken, eventsPage, eventIndex);
        if (cachedDetails?.event) {
          await showEventDetails(ctx, cachedDetails.event, {
            categoryToken,
            eventsPage,
            eventIndex,
            submarketsPage,
            categoriesPage: cachedDetails.categoriesPage
          });
          return;
        }
        const eventEntry = getCachedEvent(chatId, categoryToken, eventsPage, eventIndex);
        if (!eventEntry) {
          const categoryContext = getCachedCategoryContext(chatId, categoryToken);
          if (categoryContext) {
            await showEventsList(ctx, {
              category: categoryContext.category,
              categoryToken,
              categoriesPage: categoryContext.categoriesPage,
              page: eventsPage
            });
          } else {
            await showMarketCategoriesList(ctx, 1);
          }
        } else {
          await showEventDetails(ctx, eventEntry.event, {
            categoryToken,
            eventsPage,
            eventIndex,
            submarketsPage,
            categoriesPage: eventEntry.categoriesPage
          });
        }
      } else if (data.startsWith('evt:')) {
        // Event selection: evt:<categoryToken>:<eventsPage>:<eventIndex>
        const parts = data.split(':');
        const categoryToken = parts[1];
        const eventsPage = parseInt(parts[2], 10) || 1;
        const eventIndex = parseInt(parts[3], 10) || 0;
        const eventEntry = getCachedEvent(chatId, categoryToken, eventsPage, eventIndex);
        if (eventEntry) {
          // Pass full cached event so showEventDetails can fallback to cached data
          // when Gamma event lookup returns 404 for ephemeral slugs.
          await showEventDetails(ctx, eventEntry.event, {
            categoryToken,
            eventsPage,
            eventIndex,
            categoriesPage: eventEntry.categoriesPage
          });
        } else {
          const categoryContext = getCachedCategoryContext(chatId, categoryToken);
          if (categoryContext) {
            await showEventsList(ctx, {
              category: categoryContext.category,
              categoryToken,
              categoriesPage: categoryContext.categoriesPage,
              page: eventsPage
            });
          } else {
            await showMarketCategoriesList(ctx, 1);
          }
        }
      } else if (data.startsWith('subm:')) {
        // Submarket selection: subm:<categoryToken>:<eventsPage>:<eventIndex>:<marketIndex>
        const parts = data.split(':');
        const categoryToken = parts[1];
        const eventsPage = parseInt(parts[2], 10) || 1;
        const eventIndex = parseInt(parts[3], 10) || 0;
        const marketIndex = parseInt(parts[4], 10) || 0;
        const submarketsPage = Math.floor(marketIndex / EVENT_DETAILS_SUBMARKETS_PAGE_SIZE) + 1;
        const submarket = getCachedSubmarket(chatId, categoryToken, eventsPage, eventIndex, marketIndex);
        if (submarket) {
          await showMarketDetails(ctx, submarket, {
            backCallback: buildEventDetailsCallback(categoryToken, eventsPage, eventIndex, submarketsPage),
            retryCallback: `subm:${categoryToken}:${eventsPage}:${eventIndex}:${marketIndex}`
          });
        } else {
          const eventEntry = getCachedEvent(chatId, categoryToken, eventsPage, eventIndex);
          if (eventEntry) {
            await showEventDetails(ctx, eventEntry.event, {
              categoryToken,
              eventsPage,
              eventIndex,
              submarketsPage,
              categoriesPage: eventEntry.categoriesPage
            });
          } else {
            const categoryContext = getCachedCategoryContext(chatId, categoryToken);
            if (categoryContext) {
              await showEventsList(ctx, {
                category: categoryContext.category,
                categoryToken,
                categoriesPage: categoryContext.categoriesPage,
                page: eventsPage
              });
            } else {
              await showMarketCategoriesList(ctx, 1);
            }
          }
        }
      } else if (data.startsWith('msel:')) {
        // Market selection: msel:<page>:<index> (from split/merge selection)
        const parts = data.split(':');
        const page = parseInt(parts[1]) || 1;
        const index = parseInt(parts[2]) || 0;
        const market = getCachedMarket(chatId, page, index);
        if (market) {
          await showMarketDetails(ctx, market, {
            backCallback: 'markets:1',
            retryCallback: `msel:${page}:${index}`
          });
        } else {
          await answerCallback(t('error_generic'));
        }
      } else if (data.startsWith('ma:')) {
        const actionKey = data.split(':')[1];
        await showOutcomeSelection(ctx, actionKey, language, t);
      } else if (data.startsWith('mo:')) {
        const parts = data.split(':');
        const actionKey = parts[1];
        const outcomeIndex = parseInt(parts[2], 10);
        await handleOutcomeSelection(ctx, actionKey, outcomeIndex, language, t);
      } else if (data === 'mkt_back') {
        const cachedDetails = getCachedMarketDetailsState(chatId);
        if (!cachedDetails?.market) {
          await answerCallback(t('error_generic'));
        } else {
          await showMarketDetails(ctx, cachedDetails.market, {
            backCallback: cachedDetails.backCallback || 'markets:1',
            retryCallback: cachedDetails.retryCallback || 'markets:1'
          });
        }
      } else if (data.startsWith('b:')) {
        // Legacy callback support: market buy with direct outcome index.
        const outcomeIndex = parseInt(data.split(':')[1], 10);
        await handleOutcomeSelection(ctx, 'mb', outcomeIndex, language, t);
      } else if (data.startsWith('s:')) {
        // Legacy callback support: market sell with direct outcome index.
        const outcomeIndex = parseInt(data.split(':')[1], 10);
        await handleOutcomeSelection(ctx, 'ms', outcomeIndex, language, t);
      } else if (data.startsWith('lb:')) {
        // Legacy callback support: limit buy with direct outcome index.
        const outcomeIndex = parseInt(data.split(':')[1], 10);
        await handleOutcomeSelection(ctx, 'lb', outcomeIndex, language, t);
      } else if (data.startsWith('ls:')) {
        // Legacy callback support: limit sell with direct outcome index.
        const outcomeIndex = parseInt(data.split(':')[1], 10);
        await handleOutcomeSelection(ctx, 'ls', outcomeIndex, language, t);
      } else if (data === 'mkt_strategy') {
        const marketData = getCachedMarketDetails(chatId);
        if (marketData) {
          await startStrategyFlowFromMarket(ctx, marketData);
        } else {
          await answerCallback(t('error_generic'));
        }
      } else if (data === 'mkt_split') {
        const marketData = getCachedMarketDetails(chatId);
        if (marketData) {
          await startSplitFlow(ctx, marketData);
        } else {
          await answerCallback(t('error_generic'));
        }
      } else if (data === 'mkt_merge') {
        const marketData = getCachedMarketDetails(chatId);
        if (marketData) {
          await startMergeFlow(ctx, marketData);
        } else {
          await answerCallback(t('error_generic'));
        }
      } else if (data.startsWith('sellpct:')) {
        const parts = data.split(':');
        const percent = parseInt(parts[1], 10);
        await handleSellPercent(ctx, percent);
      } else if (data.startsWith('lbupct:')) {
        const parts = data.split(':');
        const percent = parseInt(parts[1], 10);
        await handleLimitBuyPercent(ctx, percent);
      } else if (data.startsWith('lspct:')) {
        const parts = data.split(':');
        const percent = parseInt(parts[1], 10);
        await handleLimitSellPercent(ctx, percent);
      } else if (data.startsWith('lppct:')) {
        const parts = data.split(':');
        const preset = parts.slice(1).join(':');
        await handleLimitPricePreset(ctx, preset);
      } else if (data.startsWith('buypct:')) {
        const parts = data.split(':');
        const percent = parseInt(parts[1], 10);
        await handleBuyPercent(ctx, percent);
      } else if (data.startsWith('splitpct:')) {
        const parts = data.split(':');
        const percent = parseInt(parts[1], 10);
        await handleSplitPercent(ctx, percent);
      } else if (data.startsWith('stratpct:')) {
        const parts = data.split(':');
        const percent = parseInt(parts[1], 10);
        await handleStrategySplitPercent(ctx, percent);
      } else if (data === 'merge_max') {
        await handleMergeMax(ctx);
      } else if (data === 'confirm_buy' || data.startsWith('confirm_buy:')) {
        // Keep compatibility with legacy callbacks: confirm_buy:<slug>:<tokenId>
        await executeConfirmedBuy(ctx);
      } else if (data === 'confirm_sell' || data.startsWith('confirm_sell:')) {
        // Keep compatibility with legacy callbacks: confirm_sell:<slug>:<tokenId>
        await executeConfirmedSell(ctx);
      } else if (data === 'confirm_limit') {
        await executeConfirmedLimit(ctx);
      } else if (data === 'confirm_strategy') {
        await executeConfirmedStrategySplit(ctx);
      } else if (data === 'cancel_confirmation') {
        userStates.delete(chatId);
        await ctx.editMessageText(t('cancelled'), {
          reply_markup: await getMainMenuKeyboard(config.language || 'ru')
        });
      } else if (data === 'positions') {
        await showPositions(ctx);
      } else if (data.startsWith('pos:')) {
        const index = parseInt(data.split(':')[1], 10);
        await showPositionDetailsFromCache(ctx, index);
      } else if (data.startsWith('psell:')) {
        const index = parseInt(data.split(':')[1], 10);
        await startSellFromCachedPosition(ctx, index);
      } else if (data.startsWith('pmrg:')) {
        const index = parseInt(data.split(':')[1], 10);
        await startMergeFromCachedPosition(ctx, index);
      } else if (data.startsWith('pred:')) {
        const index = parseInt(data.split(':')[1], 10);
        await startRedeemFromCachedPosition(ctx, index);
      } else if (data.startsWith('od:')) {
        const index = parseInt(data.split(':')[1], 10);
        await showOrderDetailsFromCache(ctx, index);
      } else if (data === 'orders') {
        await showOrders(ctx);
      } else if (data === 'strategies') {
        await showStrategies(ctx);
      } else if (data.startsWith('st:')) {
        const index = parseInt(data.split(':')[1], 10);
        await showStrategyDetailsFromCache(ctx, index);
      } else if (data.startsWith('stclose:')) {
        const index = parseInt(data.split(':')[1], 10);
        await startCloseStrategyFromCache(ctx, index);
      } else if (data === 'confirm_strategy_close') {
        await executeConfirmedStrategyClose(ctx);
      } else if (data.startsWith('oc:')) {
        const index = parseInt(data.split(':')[1], 10);
        await cancelCachedOrder(ctx, index);
      } else if (data === 'confirm_split' || data.startsWith('confirm_split:')) {
        await executeConfirmedSplit(ctx);
      } else if (data === 'confirm_merge' || data.startsWith('confirm_merge:')) {
        await executeConfirmedMerge(ctx);
      } else if (data === 'confirm_redeem') {
        await executeConfirmedRedeem(ctx);
      } else if (data === 'settings') {
        await showSettings(ctx);
      } else if (data === 'settings_strategy') {
        await showStrategySettings(ctx);
      } else if (data === 'settings_notifications') {
        await showNotificationSettings(ctx);
      } else if (data === 'settings_strategy_stop_loss') {
        await startStrategySettingsEdit(ctx, 'stopLoss');
      } else if (data === 'settings_strategy_take_profit') {
        await startStrategySettingsEdit(ctx, 'takeProfit');
      } else if (data === 'settings_strategy_max_ask') {
        await startStrategySettingsEdit(ctx, 'maxAskPrice');
      } else if (data === 'settings_notifications_price_change') {
        await startNotificationSettingsEdit(ctx, 'priceChangePercent');
      } else if (data === 'settings_notifications_repeat_step') {
        await startNotificationSettingsEdit(ctx, 'priceRepeatStepPercent');
      } else if (data === 'settings_notifications_cooldown') {
        await startNotificationSettingsEdit(ctx, 'alertCooldownSeconds');
      } else if (data === 'init_wallet') {
        await handleInitWallet(ctx);
      } else if (data === 'set_allowances') {
        await handleSetAllowances(ctx);
      } else if (data === 'collateral_status') {
        await handleCollateralStatus(ctx);
      } else if (data === 'start_withdraw') {
        await startWithdrawFlow(ctx);
      } else if (data === 'confirm_withdraw') {
        await executeWithdraw(ctx);
      } else if (data.startsWith('withdrawpct:')) {
        const parts = data.split(':');
        const percent = parts[1];
        await handleWithdrawPercent(ctx, percent);
      } else if (data === 'start_export_pk') {
        await handleStartExportPk(ctx);
      } else if (data === 'confirm_export_pk') {
        await handleConfirmExportPk(ctx);
      } else if (data === 'cancel_export_pk') {
        await handleCancelExportPk(ctx);
      } else if (data === 'change_language') {
        await showLanguageSettings(ctx);
      } else if (data.startsWith('set_lang:')) {
        const lang = data.split(':')[1];
        await handleSettingsLanguageChange(ctx, lang);
      } else if (data === 'back_menu') {
        await ctx.editMessageText(t('main_menu'), {
          reply_markup: await getMainMenuKeyboard(config.language || 'ru')
        });
      } else if (data === 'cancel') {
        userStates.delete(chatId);
        await ctx.editMessageText(t('cancelled'), {
          reply_markup: await getMainMenuKeyboard(config.language || 'ru')
        });
      }
      } catch (error) {
        const ctxLog = createContext('bot', 'handleCallback');
        safeLogError(ctxLog, error, { callbackData: data });
        const errorInfo = mapErrorToUserMessage(error);
        await answerCallback(t(errorInfo.key, errorInfo.params));
      }
    } finally {
      if (isConfirmCallback) {
        confirmationLocks.delete(chatId);
      }
    }
  };
}
