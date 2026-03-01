import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import {
  getMarketDetails,
  getBestBidAsk,
  createOrder,
  cancelOrder,
  getPositions,
  split,
  merge,
  redeem,
  mapErrorToUserMessage,
  parseUSDCToBase,
  formatUSDCFromBase,
  parseSharesToBase,
  formatSharesFromBase,
  formatPriceFromMicro
} from '../../polymarket.js';
import {
  cacheMarket,
  saveOrder,
  saveStrategy,
  updateStrategy,
  updateOrderStatus
} from '../../database.js';
import {
  MIN_SPLIT_USDC_BASE,
  MIN_LIMIT_ORDER_SHARES_BASE
} from '../constants.js';
import { userStates, busyLocks } from '../runtime.js';

export function createTradeOnchainFeature(deps) {
  const {
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
  } = deps;

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

async function showStrategySplitAmountPrompt(ctx, state, t, balanceBase = null, useEdit = true) {
  const chatId = ctx.chat.id;
  const config = await loadConfig();
  const stopLossPercent = Number(config?.strategies?.stopLoss ?? -10);
  const takeProfitPercent = Number(config?.strategies?.takeProfit ?? 30);
  const balanceDisplay = balanceBase !== null ? formatUSDCFromBase(balanceBase) : t('na');

  userStates.set(chatId, {
    ...state,
    state: 'AWAITING_STRATEGY_SPLIT_AMOUNT',
    stopLossPercent,
    takeProfitPercent,
    collateralBalanceBase: balanceBase !== null ? balanceBase.toString() : null
  });

  const text =
    `${t('enter_amount_split')}\n\n` +
    `${t('collateral_balance', { amount: balanceDisplay })}\n` +
    `Stop-loss: ${formatSignedPercentValue(stopLossPercent)}%\n` +
    `Take-profit: ${formatSignedPercentValue(takeProfitPercent)}%`;

  const options = { reply_markup: buildUsdcPercentKeyboard('stratpct', t) };
  if (useEdit && ctx.callbackQuery) {
    await ctx.editMessageText(text, options);
  } else {
    await ctx.reply(text, options);
  }
}

async function showStrategySplitConfirmation(ctx, state, amountBase, t, useEdit = false) {
  const chatId = ctx.chat.id;
  const stopLossPercent = Number(state.stopLossPercent ?? -10);
  const takeProfitPercent = Number(state.takeProfitPercent ?? 30);
  const marketQuestion = state.marketQuestion || state.slug || t('unknown');

  const confirmText =
    `${t('split_confirm', { amount: formatUSDCFromBase(amountBase) })}\n\n` +
    `${t('market_question')}: ${marketQuestion}\n` +
    `Stop-loss: ${formatSignedPercentValue(stopLossPercent)}%\n` +
    `Take-profit: ${formatSignedPercentValue(takeProfitPercent)}%`;

  const keyboard = new InlineKeyboard()
    .text(t('confirm'), 'confirm_strategy')
    .text(t('cancel'), 'cancel_confirmation');

  if (useEdit && ctx.callbackQuery) {
    await ctx.editMessageText(confirmText, { reply_markup: keyboard });
  } else {
    await ctx.reply(confirmText, { reply_markup: keyboard });
  }

  userStates.set(chatId, {
    ...state,
    state: 'CONFIRMING_STRATEGY_SPLIT',
    amountBase
  });
}

async function startStrategyFlowFromMarket(ctx, marketRef) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;

  let market;
  try {
    market = await getMarketDetails(marketRef);
  } catch (error) {
    const canUseCachedMarket =
      error?.status === 404 &&
      marketRef &&
      typeof marketRef === 'object' &&
      (marketRef.question || marketRef.title || marketRef.conditionId);

    if (!canUseCachedMarket) {
      throw error;
    }

    const ctxLog = createContext('bot', 'startStrategyFlowFromMarket');
    safeLogWarn(ctxLog, 'Market lookup returned 404, using cached market payload', {
      slug: marketRef.slug,
      id: marketRef.id
    });
    market = marketRef;
  }

  const marketKey = getMarketRefValue(marketRef, market);
  if (!market?.conditionId) {
    await ctx.editMessageText(t('error_no_condition_id'), {
      reply_markup: new InlineKeyboard().text(t('back'), 'mkt_back')
    });
    return;
  }

  const { tokenIdYes, tokenIdNo, outcomeYes, outcomeNo } = extractStrategyTokenPair(market, t);
  if (!tokenIdYes || !tokenIdNo) {
    await ctx.editMessageText(t('error_generic'), {
      reply_markup: new InlineKeyboard().text(t('back'), 'mkt_back')
    });
    return;
  }

  await cacheMarket(marketKey, market.conditionId, tokenIdYes, tokenIdNo);

  let balanceBase = null;
  try {
    balanceBase = await getCollateralBalanceBase();
  } catch (error) {
    const ctxLog = createContext('bot', 'startStrategyFlowFromMarket');
    safeLogWarn(ctxLog, 'Failed to fetch collateral balance for strategy split prompt', {
      message: error?.message
    });
  }

  await showStrategySplitAmountPrompt(
    ctx,
    {
      slug: marketKey,
      conditionId: market.conditionId,
      tokenIdYes,
      tokenIdNo,
      outcomeYes,
      outcomeNo,
      splitUseNegRisk: Boolean(market?.negRisk),
      marketQuestion: market.question || market.title || marketKey
    },
    t,
    balanceBase,
    true
  );
}

async function handleStrategySplitAmount(ctx, state, text) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');

  let amountBase;
  try {
    amountBase = parseUSDCToBase(text);
  } catch {
    await ctx.reply(t('error_invalid_amount'), {
      reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
    });
    return;
  }

  if (amountBase <= 0n) {
    await ctx.reply(t('error_invalid_amount'), {
      reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
    });
    return;
  }

  if (amountBase < MIN_SPLIT_USDC_BASE) {
    await ctx.reply(
      t('error_split_min_amount', {
        amount: formatUSDCFromBase(amountBase),
        min: formatUSDCFromBase(MIN_SPLIT_USDC_BASE)
      }),
      { reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel') }
    );
    return;
  }

  if (amountBase < MIN_LIMIT_ORDER_SHARES_BASE) {
    await ctx.reply(
      t('limit_min_size', { min: formatSharesFromBase(MIN_LIMIT_ORDER_SHARES_BASE) }),
      { reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel') }
    );
    return;
  }

  await showStrategySplitConfirmation(ctx, state, amountBase, t, false);
}

async function handleStrategySplitPercent(ctx, percent) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);

  if (
    !state ||
    state.state !== 'AWAITING_STRATEGY_SPLIT_AMOUNT' ||
    !state.slug ||
    !state.conditionId ||
    !state.tokenIdYes ||
    !state.tokenIdNo ||
    Number.isNaN(percent)
  ) {
    await ctx.editMessageText(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    userStates.delete(chatId);
    return;
  }

  busyLocks.set(chatId, true);
  try {
    await ctx.editMessageText(t('loading'));

    const balanceBase = await getCollateralBalanceBase();
    if (balanceBase <= 0n) {
      await ctx.editMessageText(t('error_insufficient_funds'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    const amountBase = (balanceBase * BigInt(percent)) / 100n;
    if (amountBase <= 0n) {
      await showStrategySplitAmountPrompt(ctx, state, t, balanceBase, true);
      return;
    }

    if (amountBase < MIN_SPLIT_USDC_BASE) {
      await ctx.editMessageText(
        t('error_split_min_amount', {
          amount: formatUSDCFromBase(amountBase),
          min: formatUSDCFromBase(MIN_SPLIT_USDC_BASE)
        }),
        { reply_markup: buildUsdcPercentKeyboard('stratpct', t) }
      );
      return;
    }

    if (amountBase < MIN_LIMIT_ORDER_SHARES_BASE) {
      await ctx.editMessageText(
        t('limit_min_size', { min: formatSharesFromBase(MIN_LIMIT_ORDER_SHARES_BASE) }),
        { reply_markup: buildUsdcPercentKeyboard('stratpct', t) }
      );
      return;
    }

    await showStrategySplitConfirmation(
      ctx,
      { ...state, collateralBalanceBase: balanceBase.toString() },
      amountBase,
      t,
      true
    );
  } catch (error) {
    const ctxLog = createContext('bot', 'handleStrategySplitPercent');
    safeLogError(ctxLog, error, { percent });
    const errorInfo = mapErrorToUserMessage(error);
    await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    userStates.delete(chatId);
  } finally {
    busyLocks.delete(chatId);
  }
}

async function executeConfirmedStrategySplit(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);

  if (
    !state ||
    state.state !== 'CONFIRMING_STRATEGY_SPLIT' ||
    !state.slug ||
    !state.conditionId ||
    !state.tokenIdYes ||
    !state.tokenIdNo ||
    !state.amountBase
  ) {
    await ctx.editMessageText(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    return;
  }

  let amountBase;
  try {
    amountBase = BigInt(state.amountBase?.toString?.() ?? state.amountBase);
  } catch {
    await ctx.editMessageText(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    return;
  }

  if (amountBase <= 0n) {
    await ctx.editMessageText(t('error_invalid_amount'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    return;
  }

  if (amountBase < MIN_SPLIT_USDC_BASE) {
    await ctx.editMessageText(
      t('error_split_min_amount', {
        amount: formatUSDCFromBase(amountBase),
        min: formatUSDCFromBase(MIN_SPLIT_USDC_BASE)
      }),
      { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
    );
    return;
  }

  if (amountBase < MIN_LIMIT_ORDER_SHARES_BASE) {
    await ctx.editMessageText(
      t('limit_min_size', { min: formatSharesFromBase(MIN_LIMIT_ORDER_SHARES_BASE) }),
      { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
    );
    return;
  }

  busyLocks.set(chatId, true);

  let splitCompleted = false;
  let splitTxHash = null;
  const createdTakeOrders = [];

  try {
    await ctx.editMessageText(t('loading'));

    const stopLossPercent = Number(state.stopLossPercent ?? config?.strategies?.stopLoss ?? -10);
    const takeProfitPercent = Number(state.takeProfitPercent ?? config?.strategies?.takeProfit ?? 30);

    await ensureAutoAllowancesConfigured();
    await ensureContractsInitialized();
    await ensureClientInitialized();

    let entryPriceYesMicro = 500_000n;
    let entryPriceNoMicro = 500_000n;
    try {
      const yesBook = await getBestBidAsk(state.tokenIdYes);
      const parsed = parsePriceMicroSafe(yesBook?.bestBidStr || yesBook?.bestAskStr || '0.5');
      if (parsed > 0n) entryPriceYesMicro = parsed;
    } catch (error) {
      const ctxLog = createContext('bot', 'executeConfirmedStrategySplit');
      safeLogWarn(ctxLog, 'Could not fetch YES reference price, using fallback 0.5', {
        tokenId: state.tokenIdYes,
        message: error?.message
      });
    }
    try {
      const noBook = await getBestBidAsk(state.tokenIdNo);
      const parsed = parsePriceMicroSafe(noBook?.bestBidStr || noBook?.bestAskStr || '0.5');
      if (parsed > 0n) entryPriceNoMicro = parsed;
    } catch (error) {
      const ctxLog = createContext('bot', 'executeConfirmedStrategySplit');
      safeLogWarn(ctxLog, 'Could not fetch NO reference price, using fallback 0.5', {
        tokenId: state.tokenIdNo,
        message: error?.message
      });
    }

    const stopPriceYesMicro = applyPercentToPriceMicro(entryPriceYesMicro, stopLossPercent);
    const stopPriceNoMicro = applyPercentToPriceMicro(entryPriceNoMicro, stopLossPercent);
    const takePriceYesMicro = applyPercentToPriceMicro(entryPriceYesMicro, takeProfitPercent);
    const takePriceNoMicro = applyPercentToPriceMicro(entryPriceNoMicro, takeProfitPercent);

    if (takePriceYesMicro <= 0n || takePriceNoMicro <= 0n) {
      throw new Error('Invalid take-profit price calculation');
    }

    const splitResult = await split(state.conditionId, amountBase, {
      negRisk: state.splitUseNegRisk === true
    });
    splitTxHash = getTxHashFromResult(splitResult);
    splitCompleted = splitResult?.success === true || splitResult?.status === 1 || Boolean(splitTxHash);
    if (!splitCompleted) {
      throw new Error(`Split failed: ${getResultErrorMessage(splitResult, t)}`);
    }

    const orderSize = formatSharesFromBase(amountBase);
    const takeOrderSpecs = [
      { tokenId: state.tokenIdYes, takePriceMicro: takePriceYesMicro },
      { tokenId: state.tokenIdNo, takePriceMicro: takePriceNoMicro }
    ];

    for (const spec of takeOrderSpecs) {
      const created = await createOrder({
        tokenId: spec.tokenId,
        side: 'SELL',
        orderType: 'GTC',
        price: formatPriceFromMicro(spec.takePriceMicro),
        sizeShares: orderSize
      });
      const orderId = extractOrderId(created);
      if (!orderId) {
        throw new Error('TAKE_PROFIT_ORDER_ID_MISSING');
      }
      createdTakeOrders.push({
        orderId,
        tokenId: spec.tokenId,
        priceMicro: spec.takePriceMicro
      });

      await saveOrder(
        orderId,
        state.slug,
        spec.tokenId,
        'sell',
        'limit',
        'GTC',
        spec.takePriceMicro,
        amountBase
      );
    }

    const strategyResult = await saveStrategy({
      marketId: state.slug,
      conditionId: state.conditionId,
      tokenIdYes: state.tokenIdYes,
      tokenIdNo: state.tokenIdNo,
      stopLossPercent,
      takeProfitPercent,
      entryPriceYesMicro,
      entryPriceNoMicro,
      quantityBase: amountBase * 2n
    });
    const strategyId = Number(strategyResult?.lastInsertRowid || strategyResult?.lastID || 0);
    if (strategyId <= 0) {
      throw new Error('STRATEGY_ID_MISSING');
    }

    await updateStrategy(strategyId, {
      order_id_take: encodeStrategyOrderPair({
        yes: createdTakeOrders[0]?.orderId || '',
        no: createdTakeOrders[1]?.orderId || ''
      }),
      order_id_stop: null,
      status: 'active'
    });

    const strategyMessage = t('strategy_created', {
      id: strategyId,
      stop: `YES ${formatPriceFromMicro(stopPriceYesMicro)}, NO ${formatPriceFromMicro(stopPriceNoMicro)}`,
      take: `YES ${formatPriceFromMicro(takePriceYesMicro)}, NO ${formatPriceFromMicro(takePriceNoMicro)}`,
      orderId: createdTakeOrders.map((item) => item.orderId).join(', ')
    });
    const splitTxLabel = splitTxHash ? formatTxHashLink(splitTxHash) : escapeHtml(t('unknown'));

    await ctx.editMessageText(
      `${escapeHtml(strategyMessage)}\nSplit tx: ${splitTxLabel}`,
      {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru'),
        parse_mode: 'HTML'
      }
    );
  } catch (error) {
    const ctxLog = createContext('bot', 'executeConfirmedStrategySplit');
    safeLogError(ctxLog, error, {
      splitCompleted,
      splitTxHash,
      marketRef: state.slug,
      tokenIdYes: state.tokenIdYes,
      tokenIdNo: state.tokenIdNo
    });

    for (const order of createdTakeOrders) {
      try {
        await cancelOrder(order.orderId);
      } catch {}
      try {
        await updateOrderStatus(order.orderId, 'cancelled');
      } catch {}
    }

    if (splitCompleted) {
      const splitTxLabel = splitTxHash ? formatTxHashLink(splitTxHash) : escapeHtml(t('unknown'));
      const failureMessage = escapeHtml(String(error?.message || t('unknown')).slice(0, 140));
      const message =
        `Split tx ${splitTxLabel} created, ` +
        `but strategy setup failed: ${failureMessage}`;
      await ctx.editMessageText(
        t('error_order_failed', { message }),
        {
          reply_markup: await getMainMenuKeyboard(config.language || 'ru'),
          parse_mode: 'HTML'
        }
      );
    } else {
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
    }
  } finally {
    userStates.delete(chatId);
    busyLocks.delete(chatId);
  }
}

async function startSplitFlow(ctx, marketRef) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  
  // Get market details
  let market;
  try {
    market = await getMarketDetails(marketRef);
  } catch (error) {
    const canUseCachedMarket =
      error?.status === 404 &&
      marketRef &&
      typeof marketRef === 'object' &&
      (marketRef.question || marketRef.title || marketRef.conditionId);

    if (!canUseCachedMarket) {
      throw error;
    }

    const ctxLog = createContext('bot', 'startSplitFlow');
    safeLogWarn(ctxLog, 'Market lookup returned 404, using cached market payload', {
      slug: marketRef.slug,
      id: marketRef.id
    });
    market = marketRef;
  }

  const marketKey = getMarketRefValue(marketRef, market);
  
  if (!market.conditionId) {
    await ctx.editMessageText(t('error_no_condition_id'), {
      reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
    });
    return;
  }
  
  // Cache market data
  if (market.tokens && market.tokens.length >= 2) {
    const yesToken = market.tokens.find(t => t.outcome === 'Yes');
    const noToken = market.tokens.find(t => t.outcome === 'No');
    if (yesToken && noToken) {
      await cacheMarket(marketKey, market.conditionId, yesToken.token_id, noToken.token_id);
    }
  }
  
  userStates.set(chatId, {
    slug: marketKey,
    conditionId: market.conditionId,
    splitUseNegRisk: Boolean(market?.negRisk)
  });

  let balanceBase = null;
  try {
    balanceBase = await getCollateralBalanceBase();
  } catch (error) {
    const ctxLog = createContext('bot', 'startSplitFlow');
    safeLogWarn(ctxLog, 'Failed to fetch collateral balance for split prompt', {
      message: error?.message
    });
  }

  await showSplitAmountPrompt(
    ctx,
    { slug: marketKey, conditionId: market.conditionId, splitUseNegRisk: Boolean(market?.negRisk) },
    t,
    balanceBase
  );
}

async function handleSplitAmount(ctx, state, text) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  
  // Parse USDC amount from string input (handles "15.2" or "15,2")
  let amountBase;
  try {
    amountBase = parseUSDCToBase(text);
  } catch (e) {
    await ctx.reply(t('error_invalid_amount'), {
      reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
    });
    return;
  }
  
  if (amountBase <= 0n) {
    await ctx.reply(t('error_invalid_amount'), {
      reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
    });
    return;
  }

  if (amountBase < MIN_SPLIT_USDC_BASE) {
    await ctx.reply(
      t('error_split_min_amount', {
        amount: formatUSDCFromBase(amountBase),
        min: formatUSDCFromBase(MIN_SPLIT_USDC_BASE)
      }),
      {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      }
    );
    return;
  }
  
  await showSplitConfirmation(ctx, state, amountBase, t);
}

async function handleSplitPercent(ctx, percent) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);

  if (
    !state ||
    state.state !== 'AWAITING_SPLIT_AMOUNT' ||
    !state.slug ||
    !state.conditionId ||
    Number.isNaN(percent)
  ) {
    await ctx.editMessageText(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    userStates.delete(chatId);
    return;
  }

  busyLocks.set(chatId, true);

  try {
    await ctx.editMessageText(t('loading'));

    const balanceBase = await getCollateralBalanceBase();
    if (balanceBase <= 0n) {
      await ctx.editMessageText(t('error_insufficient_funds'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    const amountBase = (balanceBase * BigInt(percent)) / 100n;
    if (amountBase <= 0n) {
      await showSplitAmountPrompt(ctx, state, t, balanceBase);
      return;
    }

    if (amountBase < MIN_SPLIT_USDC_BASE) {
      await ctx.editMessageText(
        t('error_split_min_amount', {
          amount: formatUSDCFromBase(amountBase),
          min: formatUSDCFromBase(MIN_SPLIT_USDC_BASE)
        }),
        {
          reply_markup: buildUsdcPercentKeyboard('splitpct', t)
        }
      );
      return;
    }

    await showSplitConfirmation(ctx, { ...state, collateralBalanceBase: balanceBase.toString() }, amountBase, t);
  } catch (error) {
    const ctxLog = createContext('bot', 'handleSplitPercent');
    safeLogError(ctxLog, error, { slug: state.slug, conditionId: state.conditionId, percent });
    const errorInfo = mapErrorToUserMessage(error);
    await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    userStates.delete(chatId);
  } finally {
    busyLocks.delete(chatId);
  }
}

async function executeConfirmedSplit(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);
  
  if (!state || !state.amountBase || !state.conditionId) {
    await ctx.editMessageText(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    return;
  }
  
  // Set busy lock
  busyLocks.set(chatId, true);
  
  try {
    await ctx.editMessageText(t('loading'));

    if (state.amountBase < MIN_SPLIT_USDC_BASE) {
      await ctx.editMessageText(
        t('error_split_min_amount', {
          amount: formatUSDCFromBase(state.amountBase),
          min: formatUSDCFromBase(MIN_SPLIT_USDC_BASE)
        }),
        { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
      );
      return;
    }

    // One-time automatic allowance setup for split/merge flows.
    await ensureAutoAllowancesConfigured();
    
    // Initialize contracts
    await ensureContractsInitialized();
    
    // Execute split with bigint amount
    const result = await split(state.conditionId, state.amountBase, {
      negRisk: state.splitUseNegRisk === true
    });

    const txHash = getTxHashFromResult(result);
    const isSuccess = result?.success === true || result?.status === 1 || Boolean(txHash);

    if (isSuccess) {
      await refreshPositionsAfterMutation(chatId, config.walletAddress);

      const txLabel = txHash ? formatTxHashLink(txHash) : escapeHtml(t('unknown'));
      await ctx.editMessageText(
        t('split_success', { hash: txLabel, amount: formatUSDCFromBase(state.amountBase) }),
        {
          reply_markup: await getMainMenuKeyboard(config.language || 'ru'),
          parse_mode: 'HTML'
        }
      );
    } else {
      await ctx.editMessageText(
        t('error_order_failed', { message: getResultErrorMessage(result, t) }),
        { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
      );
    }
  } catch (error) {
    const ctxLog = createContext('bot', 'executeConfirmedSplit');
    safeLogError(ctxLog, error, { state, amountBase: state.amountBase?.toString() });
    const errorInfo = mapErrorToUserMessage(error);
    await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
  } finally {
    userStates.delete(chatId);
    busyLocks.delete(chatId);
  }
}

async function startMergeFlow(ctx, marketRef) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  
  // Get market details
  let market;
  try {
    market = await getMarketDetails(marketRef);
  } catch (error) {
    const canUseCachedMarket =
      error?.status === 404 &&
      marketRef &&
      typeof marketRef === 'object' &&
      (marketRef.question || marketRef.title || marketRef.conditionId);

    if (!canUseCachedMarket) {
      throw error;
    }

    const ctxLog = createContext('bot', 'startMergeFlow');
    safeLogWarn(ctxLog, 'Market lookup returned 404, using cached market payload', {
      slug: marketRef.slug,
      id: marketRef.id
    });
    market = marketRef;
  }

  const marketKey = getMarketRefValue(marketRef, market);
  
  if (!market.conditionId) {
    await ctx.editMessageText(t('error_no_condition_id'), {
      reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
    });
    return;
  }
  
  // Cache market data
  if (market.tokens && market.tokens.length >= 2) {
    const yesToken = market.tokens.find(t => t.outcome === 'Yes');
    const noToken = market.tokens.find(t => t.outcome === 'No');
    if (yesToken && noToken) {
      await cacheMarket(marketKey, market.conditionId, yesToken.token_id, noToken.token_id);
    }
  }
  
  userStates.set(chatId, {
    state: 'AWAITING_MERGE_AMOUNT',
    slug: marketKey,
    conditionId: market.conditionId,
    mergeUseNegRisk: Boolean(market?.negRisk)
  });

  let maxMergeBase = 0n;
  try {
    const { tokenIdYes, tokenIdNo } = extractStrategyTokenPair(market, t);
    if (tokenIdYes && tokenIdNo) {
      await ensureClientInitialized();
      const positions = await getPositions();
      const yesBase = getPositionSharesBaseForToken(positions, tokenIdYes);
      const noBase = getPositionSharesBaseForToken(positions, tokenIdNo);
      maxMergeBase = yesBase < noBase ? yesBase : noBase;
      if (maxMergeBase > 0n) {
        userStates.set(chatId, {
          state: 'AWAITING_MERGE_AMOUNT',
          slug: marketKey,
          conditionId: market.conditionId,
          maxMergeBase: maxMergeBase.toString(),
          mergeUseNegRisk: Boolean(market?.negRisk)
        });
      }
    }
  } catch (error) {
    const ctxLog = createContext('bot', 'startMergeFlow');
    safeLogWarn(ctxLog, 'Could not determine max merge size', {
      message: error?.message
    });
  }

  const hasMaxOption = maxMergeBase > 0n;
  const prompt = hasMaxOption
    ? `${t('enter_amount_merge')}\n\nMax: ${formatSharesFromBase(maxMergeBase)} ${t('shares')}`
    : t('enter_amount_merge');

  await ctx.editMessageText(prompt, {
    reply_markup: buildMergeAmountKeyboard(t, hasMaxOption)
  });
}

async function handleMergeAmount(ctx, state, text) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  
  // Parse shares amount from string input (handles "15.2" or "15,2")
  let sharesBase;
  try {
    sharesBase = parseSharesToBase(text);
  } catch (e) {
    await ctx.reply(t('error_invalid_amount'), {
      reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
    });
    return;
  }
  
  if (sharesBase <= 0n) {
    await ctx.reply(t('error_invalid_amount'), {
      reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
    });
    return;
  }

  const maxMergeBase = parseBaseUnitsBigIntSafe(state.maxMergeBase);
  if (maxMergeBase > 0n && sharesBase > maxMergeBase) {
    await ctx.reply(
      t('error_order_failed', {
        message: `Merge amount exceeds available pair size (${formatSharesFromBase(maxMergeBase)} ${t('shares')})`
      }),
      {
        reply_markup: buildMergeAmountKeyboard(t, maxMergeBase > 0n)
      }
    );
    return;
  }

  const estimatedUsdcBase = sharesBase;
  const confirmText =
    `${t('merge_confirm', { amount: formatSharesFromBase(sharesBase) })}\n\n` +
    `~ ${formatUSDCFromBase(estimatedUsdcBase)} USDC`;
  
  const keyboard = new InlineKeyboard()
    .text(t('confirm'), 'confirm_merge')
    .text(t('cancel'), 'cancel_confirmation');
  
  await ctx.reply(confirmText, { reply_markup: keyboard });
  
  // Update state to confirmation with bigint value
  userStates.set(chatId, {
    ...state,
    state: 'CONFIRMING_MERGE',
    sharesBase
  });
}

async function handleMergeMax(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);

  if (
    !state ||
    state.state !== 'AWAITING_MERGE_AMOUNT'
  ) {
    await ctx.editMessageText(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    userStates.delete(chatId);
    return;
  }

  const maxMergeBase = parseBaseUnitsBigIntSafe(state.maxMergeBase);
  if (maxMergeBase <= 0n) {
    await ctx.editMessageText(
      t('error_order_failed', { message: 'Maximum merge amount is unavailable for this market' }),
      {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      }
    );
    return;
  }

  const confirmText =
    `${t('merge_confirm', { amount: formatSharesFromBase(maxMergeBase) })}\n\n` +
    `~ ${formatUSDCFromBase(maxMergeBase)} USDC`;

  const keyboard = new InlineKeyboard()
    .text(t('confirm'), 'confirm_merge')
    .text(t('cancel'), 'cancel_confirmation');

  await ctx.editMessageText(confirmText, { reply_markup: keyboard });

  userStates.set(chatId, {
    ...state,
    state: 'CONFIRMING_MERGE',
    sharesBase: maxMergeBase
  });
}

async function executeConfirmedMerge(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);
  
  if (!state || !state.sharesBase || !state.conditionId) {
    await ctx.editMessageText(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    return;
  }
  
  // Set busy lock
  busyLocks.set(chatId, true);
  
  try {
    await ctx.editMessageText(t('loading'));

    // One-time automatic allowance setup for split/merge flows.
    await ensureAutoAllowancesConfigured();

    await ensureClientInitialized();
    const livePositions = await getPositions();
    setCachedPositions(chatId, livePositions);

    const sourceTokenId = normalizeTokenId(state.sourceTokenId);
    if (sourceTokenId) {
      const livePosition = livePositions.find((entry) => getPositionTokenId(entry) === sourceTokenId);
      if (!livePosition) {
        await ctx.editMessageText(
          t('error_order_failed', { message: 'Merge is unavailable: position is no longer present' }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
        );
        return;
      }

      const liveMergeInfo = resolvePositionMergeInfo(livePositions, livePosition);
      if (!liveMergeInfo.available || liveMergeInfo.maxMergeBase <= 0n) {
        await ctx.editMessageText(
          t('error_order_failed', { message: 'Merge is unavailable: opposite side balance is insufficient' }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
        );
        return;
      }

      if (state.sharesBase > liveMergeInfo.maxMergeBase) {
        const maxLabel = formatSharesFromBase(liveMergeInfo.maxMergeBase);
        await ctx.editMessageText(
          t('error_order_failed', { message: `Merge amount exceeds available pair balance (max ${maxLabel} shares)` }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
        );
        return;
      }
    }

    // Initialize contracts
    await ensureContractsInitialized();
    
    // Execute merge with bigint shares amount
    const result = await merge(state.conditionId, state.sharesBase, {
      negRisk: state.mergeUseNegRisk === true,
      sourceTokenId: state.sourceTokenId || null
    });

    const txHash = getTxHashFromResult(result);
    const isSuccess = result?.success === true || result?.status === 1 || Boolean(txHash);

    if (isSuccess) {
      await refreshPositionsAfterMutation(chatId, config.walletAddress, {
        sourceTokenId: state.sourceTokenId || null,
        expectedReductionBase: state.sharesBase.toString()
      });

      const txLabel = txHash ? formatTxHashLink(txHash) : escapeHtml(t('unknown'));
      await ctx.editMessageText(
        t('merge_success', { hash: txLabel, amount: formatSharesFromBase(state.sharesBase) }),
        {
          reply_markup: await getMainMenuKeyboard(config.language || 'ru'),
          parse_mode: 'HTML'
        }
      );
    } else {
      await ctx.editMessageText(
        t('error_order_failed', { message: getResultErrorMessage(result, t) }),
        { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
      );
    }
  } catch (error) {
    const ctxLog = createContext('bot', 'executeConfirmedMerge');
    safeLogError(ctxLog, error, { state, sharesBase: state.sharesBase?.toString() });
    const errorInfo = mapErrorToUserMessage(error);
    await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
  } finally {
    userStates.delete(chatId);
    busyLocks.delete(chatId);
  }
}

async function executeConfirmedRedeem(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  const chatId = ctx.chat.id;
  const language = config.language || 'ru';
  const state = userStates.get(chatId);

  if (!state || state.state !== 'CONFIRMING_REDEEM' || !state.conditionId) {
    await ctx.editMessageText(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
    return;
  }

  busyLocks.set(chatId, true);
  try {
    await ctx.editMessageText(t('loading'));

    await ensureContractsInitialized();

    const result = await redeem(state.conditionId);
    const txHash = getTxHashFromResult(result);
    const isSuccess = result?.success === true || result?.status === 1 || Boolean(txHash);

    if (!isSuccess) {
      await ctx.editMessageText(
        t('error_order_failed', { message: getResultErrorMessage(result, t) }),
        { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
      );
      return;
    }

    await refreshPositionsAfterMutation(chatId, config.walletAddress);

    const txLabel = txHash ? formatTxHashLink(txHash) : escapeHtml(t('unknown'));
    const redeemLabel = getRedeemActionLabel(language);
    await ctx.editMessageText(
      `${redeemLabel}\n${t('transaction_confirmed', { hash: txLabel })}`,
      {
        reply_markup: new InlineKeyboard()
          .text(t('menu_positions'), 'positions')
          .text(t('back'), 'back_menu'),
        parse_mode: 'HTML'
      }
    );
  } catch (error) {
    const ctxLog = createContext('bot', 'executeConfirmedRedeem');
    safeLogError(ctxLog, error, { conditionId: state?.conditionId });
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
    startStrategyFlowFromMarket,
    handleStrategySplitAmount,
    handleStrategySplitPercent,
    executeConfirmedStrategySplit,
    startSplitFlow,
    handleSplitAmount,
    handleSplitPercent,
    executeConfirmedSplit,
    startMergeFlow,
    handleMergeAmount,
    handleMergeMax,
    executeConfirmedMerge,
    executeConfirmedRedeem
  };
}
