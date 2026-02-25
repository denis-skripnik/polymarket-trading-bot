import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { createContext, safeLogError } from '../../logger.js';
import { mapErrorToUserMessage } from '../../polymarket.js';
import { busyLocks, userStates } from '../runtime.js';

export function createHandleTextMessageRouter(deps) {
  const {
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
    handleEventsFilterRangeInput
  } = deps;

  return async function handleTextMessage(ctx) {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    
    const state = userStates.get(chatId);
    if (!state) {
      const parsedUrl = parsePolymarketEventUrl(text);
      if (parsedUrl) {
        await handlePolymarketEventUrlInput(ctx, parsedUrl, t);
        return;
      }

      // No active state, show menu
      await ctx.reply(t('main_menu'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }
    
    // Check busy lock - but NOT during confirmation state
    const isInConfirmationState = state.state === 'CONFIRMING_BUY' || state.state === 'CONFIRMING_SELL' ||
                                  state.state === 'CONFIRMING_SPLIT' || state.state === 'CONFIRMING_MERGE' ||
                                  state.state === 'CONFIRMING_LIMIT' || state.state === 'CONFIRMING_STRATEGY_SPLIT' ||
                                  state.state === 'AWAITING_EXPORT_CONFIRMATION';
    
    if (busyLocks.get(chatId) && !isInConfirmationState) {
      await ctx.reply(t('error_busy'));
      return;
    }
    
    try {
      switch (state.state) {
        case 'AWAITING_BUY_AMOUNT':
          await handleBuyAmount(ctx, state, text);
          break;
        case 'AWAITING_SELL_AMOUNT':
          await handleSellAmount(ctx, state, text);
          break;
        case 'AWAITING_SPLIT_AMOUNT':
          await handleSplitAmount(ctx, state, text);
          break;
        case 'AWAITING_STRATEGY_SPLIT_AMOUNT':
          await handleStrategySplitAmount(ctx, state, text);
          break;
        case 'AWAITING_MERGE_AMOUNT':
          await handleMergeAmount(ctx, state, text);
          break;
        case 'AWAITING_EXPORT_CONFIRMATION':
          await handleExportConfirmation(ctx, state, text);
          break;
        case 'AWAITING_LIMIT_AMOUNT':
          await handleLimitAmount(ctx, state, text);
          break;
        case 'AWAITING_LIMIT_PRICE':
          await handleLimitPrice(ctx, state, text);
          break;
        case 'AWAITING_STRATEGY_STOP_LOSS':
        case 'AWAITING_STRATEGY_TAKE_PROFIT':
        case 'AWAITING_STRATEGY_MAX_ASK_PRICE':
          await handleStrategySettingsInput(ctx, state, text);
          break;
        case 'AWAITING_NOTIFICATION_PRICE_CHANGE':
        case 'AWAITING_NOTIFICATION_REPEAT_STEP':
        case 'AWAITING_NOTIFICATION_COOLDOWN':
          await handleNotificationSettingsInput(ctx, state, text);
          break;
        case 'AWAITING_EVENTS_FILTER_RANGE':
          await handleEventsFilterRangeInput(ctx, state, text);
          break;
        default:
          await ctx.reply(t('main_menu'), {
            reply_markup: await getMainMenuKeyboard(config.language || 'ru')
          });
      }
    } catch (error) {
      const ctxLog = createContext('bot', 'handleTextMessage');
      safeLogError(ctxLog, error, { state: state?.state });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.reply(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      userStates.delete(chatId);
    }
  };
}
