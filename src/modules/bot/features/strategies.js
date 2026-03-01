import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import {
  getPositions,
  getOrders,
  cancelOrder,
  merge,
  placeMarketSellWithFallback,
  createOrder,
  formatSharesFromBase,
  formatPriceFromMicro,
  mapErrorToUserMessage
} from '../../polymarket.js';
import { getActiveStrategies as getDbActiveStrategies, saveOrder } from '../../database.js';
import { busyLocks, userStates } from '../runtime.js';

export function createStrategiesFeature(deps) {
  const {
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
  } = deps;

  async function showStrategies(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    await ctx.editMessageText(t('loading'));
    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      await ensureClientInitialized();
      const [strategies, positions] = await Promise.all([getDbActiveStrategies(), getPositions()]);

      if (!Array.isArray(strategies) || strategies.length === 0) {
        await ctx.editMessageText(t('no_active_strategies'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
        });
        return;
      }

      const cacheKey = `strategies:${chatId}`;
      userStates.set(cacheKey, { strategies, positions, timestamp: Date.now() });

      let text = `${t('strategies_title')}\n\n`;
      const keyboard = new InlineKeyboard();

      for (let index = 0; index < strategies.length; index += 1) {
        const strategy = strategies[index];
        const yesQtyBase = getPositionSharesForTokenFromList(positions, strategy.token_id_yes);
        const noQtyBase = getPositionSharesForTokenFromList(positions, strategy.token_id_no);
        const statusText = getStrategyStatusText(strategy.status, t);

        text += `${index + 1}. #${strategy.id} ${strategy.market_id}\n`;
        text += `   ${t('status')}: ${statusText}\n`;
        text += `   YES: ${formatSharesFromBase(yesQtyBase)} ${t('shares')} | NO: ${formatSharesFromBase(noQtyBase)} ${t('shares')}\n`;
        text += `   SL: ${formatStrategyPercentValue(strategy.stop_loss_percent)} | TP: ${formatStrategyPercentValue(strategy.take_profit_percent)}\n\n`;

        keyboard.text(`${index + 1}`, `st:${index}`);
        if ((index + 1) % 4 === 0) keyboard.row();
      }

      keyboard.row();
      keyboard.text(t('refresh'), 'strategies');
      keyboard.text(t('back'), 'back_menu');

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const ctxLog = createContext('bot', 'showStrategies');
      safeLogError(ctxLog, error);
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('try_again'), 'strategies').text(t('back'), 'back_menu')
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function showStrategyDetailsFromCache(ctx, index) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    if (Number.isNaN(index) || index < 0) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'strategies')
      });
      return;
    }

    const strategy = getCachedStrategy(chatId, index);
    if (!strategy) {
      await showStrategies(ctx);
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await ctx.editMessageText(t('loading'));
      await ensureClientInitialized();
      await ensureAutoAllowancesConfigured();
      await ensureContractsInitialized();
      const [positions, openOrders] = await Promise.all([getPositions(), getOrders()]);

      const yesQtyBase = getPositionSharesForTokenFromList(positions, strategy.token_id_yes);
      const noQtyBase = getPositionSharesForTokenFromList(positions, strategy.token_id_no);
      const takePair = parseStrategyOrderPair(strategy.order_id_take);
      const stopPair = parseStrategyOrderPair(strategy.order_id_stop);

      const [takeYes, takeNo, stopYes, stopNo] = await Promise.all([
        takePair.yes ? getOrderById(takePair.yes) : Promise.resolve(null),
        takePair.no ? getOrderById(takePair.no) : Promise.resolve(null),
        stopPair.yes ? getOrderById(stopPair.yes) : Promise.resolve(null),
        stopPair.no ? getOrderById(stopPair.no) : Promise.resolve(null)
      ]);
      const liveStatusByOrderId = new Map();
      for (const order of Array.isArray(openOrders) ? openOrders : []) {
        const orderId = extractOrderId(order);
        if (!orderId) continue;
        const status = String(order?.status || 'open').trim();
        if (!status) continue;
        liveStatusByOrderId.set(orderId, status);
      }

      const getDisplayedOrderStatus = (orderId, orderRow) => {
        const normalizedId = String(orderId || '').trim();
        if (normalizedId && liveStatusByOrderId.has(normalizedId)) {
          const liveStatusRaw = String(liveStatusByOrderId.get(normalizedId)).trim().toLowerCase();
          if (liveStatusRaw === 'partial' || liveStatusRaw === 'partially_filled') {
            return getOrderStatusText('partially_filled', t);
          }
          if (liveStatusRaw === 'filled') {
            return getOrderStatusText('filled', t);
          }
          return getOrderStatusText('open', t);
        }
        return formatStrategyOrderStatus(orderRow, t);
      };

      const statusText = getStrategyStatusText(strategy.status, t);
      let text = `${t('strategies_title')}\n\n`;
      text += `#${strategy.id}\n`;
      text += `${t('market_question')}: ${strategy.market_id}\n`;
      text += `${t('status')}: ${statusText}\n`;
      text += `SL: ${formatStrategyPercentValue(strategy.stop_loss_percent)} | TP: ${formatStrategyPercentValue(strategy.take_profit_percent)}\n\n`;
      text += `YES: ${formatSharesFromBase(yesQtyBase)} ${t('shares')} (${formatPriceFromMicro(parseBaseUnitsBigIntSafe(strategy.entry_price_yes_micro))})\n`;
      text += `NO: ${formatSharesFromBase(noQtyBase)} ${t('shares')} (${formatPriceFromMicro(parseBaseUnitsBigIntSafe(strategy.entry_price_no_micro))})\n\n`;
      text += `${t('strategy_orders_take')} YES: ${shortOrderIdOrNA(takePair.yes, t)} (${getDisplayedOrderStatus(takePair.yes, takeYes)})\n`;
      text += `${t('strategy_orders_take')} NO: ${shortOrderIdOrNA(takePair.no, t)} (${getDisplayedOrderStatus(takePair.no, takeNo)})\n`;
      text += `${t('strategy_orders_stop')} YES: ${shortOrderIdOrNA(stopPair.yes, t)} (${getDisplayedOrderStatus(stopPair.yes, stopYes)})\n`;
      text += `${t('strategy_orders_stop')} NO: ${shortOrderIdOrNA(stopPair.no, t)} (${getDisplayedOrderStatus(stopPair.no, stopNo)})`;

      const keyboard = new InlineKeyboard()
        .text(t('strategy_close_action'), `stclose:${index}`)
        .row()
        .text(t('refresh'), `st:${index}`)
        .text(t('back'), 'strategies');

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const ctxLog = createContext('bot', 'showStrategyDetailsFromCache');
      safeLogError(ctxLog, error, { index });
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'strategies')
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function startCloseStrategyFromCache(ctx, index) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    if (Number.isNaN(index) || index < 0) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'strategies')
      });
      return;
    }

    const strategy = getCachedStrategy(chatId, index);
    if (!strategy) {
      await showStrategies(ctx);
      return;
    }

    userStates.set(chatId, {
      state: 'CONFIRMING_STRATEGY_CLOSE',
      strategyId: Number(strategy.id),
      marketId: String(strategy.market_id || ''),
      conditionId: String(strategy.condition_id || ''),
      tokenIdYes: String(strategy.token_id_yes || ''),
      tokenIdNo: String(strategy.token_id_no || ''),
      orderIdTake: strategy.order_id_take || null,
      orderIdStop: strategy.order_id_stop || null
    });

    const keyboard = new InlineKeyboard()
      .text(t('confirm'), 'confirm_strategy_close')
      .text(t('cancel'), 'cancel_confirmation');

    await ctx.editMessageText(
      t('strategy_close_confirm', {
        id: strategy.id,
        market: strategy.market_id
      }),
      { reply_markup: keyboard }
    );
  }

  async function createEmergencyStrategyCloseOrder(strategyState, tokenId, qtyBase) {
    const created = await createOrder({
      tokenId,
      side: 'SELL',
      orderType: 'GTC',
      price: '0.010000',
      sizeShares: formatSharesFromBase(qtyBase)
    });
    const orderId = extractOrderId(created);
    if (!orderId) {
      throw new Error('EMERGENCY_CLOSE_ORDER_ID_MISSING');
    }
    await saveOrder(
      orderId,
      strategyState.marketId || strategyState.conditionId || 'unknown-market',
      tokenId,
      'sell',
      'limit',
      'GTC',
      10_000n,
      qtyBase
    );
    return orderId;
  }

  async function executeConfirmedStrategyClose(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (
      !state ||
      state.state !== 'CONFIRMING_STRATEGY_CLOSE' ||
      !state.strategyId ||
      !state.tokenIdYes ||
      !state.tokenIdNo ||
      !state.conditionId
    ) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await ctx.editMessageText(t('loading'));
      await ensureClientInitialized();

      const takePair = parseStrategyOrderPair(state.orderIdTake);
      const stopPair = parseStrategyOrderPair(state.orderIdStop);
      const orderIdsToCancel = Array.from(new Set([...takePair.allIds, ...stopPair.allIds]));

      for (const orderId of orderIdsToCancel) {
        try {
          await cancelOrder(orderId);
        } catch {}
        try {
          await updateOrderStatus(orderId, 'cancelled');
        } catch {}
      }

      let positions = await getPositions();
      let yesQtyBase = getPositionSharesForTokenFromList(positions, state.tokenIdYes);
      let noQtyBase = getPositionSharesForTokenFromList(positions, state.tokenIdNo);
      let mergeTxHash = null;

      const mergeQtyBase = yesQtyBase > 0n && noQtyBase > 0n
        ? (yesQtyBase < noQtyBase ? yesQtyBase : noQtyBase)
        : 0n;

      if (mergeQtyBase > 0n) {
        try {
          const mergeResult = await merge(state.conditionId, mergeQtyBase, {
            sourceTokenId: state.tokenIdYes || null
          });
          mergeTxHash = getTxHashFromResult(mergeResult);
        } catch (error) {
          const ctxLog = createContext('bot', 'executeConfirmedStrategyClose');
          safeLogWarn(ctxLog, 'Merge during strategy close failed, continuing with market exits', {
            strategyId: state.strategyId,
            message: error?.message
          });
        }
      }

      positions = await getPositions();
      yesQtyBase = getPositionSharesForTokenFromList(positions, state.tokenIdYes);
      noQtyBase = getPositionSharesForTokenFromList(positions, state.tokenIdNo);

      const fallbackStopPair = { yes: '', no: '' };
      const closeTargets = [
        { key: 'yes', tokenId: state.tokenIdYes, qtyBase: yesQtyBase, label: 'YES' },
        { key: 'no', tokenId: state.tokenIdNo, qtyBase: noQtyBase, label: 'NO' }
      ];

      for (const target of closeTargets) {
        if (target.qtyBase <= 0n) continue;
        try {
          const result = await placeMarketSellWithFallback(target.tokenId, target.qtyBase, {
            conditionId: state.conditionId,
            outcome: target.label
          });
          if (!result?.success) {
            throw new Error(result?.error || `market close failed for ${target.label}`);
          }
        } catch (error) {
          const ctxLog = createContext('bot', 'executeConfirmedStrategyClose');
          safeLogWarn(ctxLog, 'Market close failed during manual strategy close, posting fallback stop', {
            strategyId: state.strategyId,
            leg: target.key,
            tokenId: target.tokenId,
            message: error?.message
          });
          try {
            const fallbackId = await createEmergencyStrategyCloseOrder(state, target.tokenId, target.qtyBase);
            fallbackStopPair[target.key] = fallbackId;
          } catch (fallbackError) {
            safeLogWarn(ctxLog, 'Fallback stop posting failed during manual strategy close', {
              strategyId: state.strategyId,
              leg: target.key,
              tokenId: target.tokenId,
              message: fallbackError?.message
            });
          }
        }
      }

      positions = await getPositions();
      yesQtyBase = getPositionSharesForTokenFromList(positions, state.tokenIdYes);
      noQtyBase = getPositionSharesForTokenFromList(positions, state.tokenIdNo);

      const fullyClosed = yesQtyBase <= 0n && noQtyBase <= 0n && !fallbackStopPair.yes && !fallbackStopPair.no;
      const nextStatus = fullyClosed ? 'closed' : 'active';
      await updateStrategy(state.strategyId, {
        status: nextStatus,
        order_id_take: null,
        order_id_stop: encodeStrategyOrderPair(fallbackStopPair)
      });

      if (fullyClosed) {
        let mergeLabel = '';
        if (mergeTxHash) {
          const txLink = formatTxHashLink ? formatTxHashLink(mergeTxHash) : mergeTxHash;
          mergeLabel = `\nMerge tx: ${txLink}`;
        }
        await ctx.editMessageText(
          t('strategy_close_done', {
            id: state.strategyId,
            details: mergeLabel
          }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru'), parse_mode: 'HTML' }
        );
      } else {
        await ctx.editMessageText(
          t('strategy_close_partial', { id: state.strategyId }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
        );
      }
    } catch (error) {
      const ctxLog = createContext('bot', 'executeConfirmedStrategyClose');
      safeLogError(ctxLog, error, { strategyId: state?.strategyId });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  return {
    showStrategies,
    showStrategyDetailsFromCache,
    startCloseStrategyFromCache,
    executeConfirmedStrategyClose
  };
}
