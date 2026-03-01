import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import {
  getPositions,
  getBestBidAsk,
  placeMarketBuyFOK,
  placeMarketSellWithFallback,
  parseUSDCToBase,
  formatUSDCFromBase,
  parseSharesToBase,
  formatSharesFromBase,
  parsePriceToMicro,
  formatPriceFromMicro,
  computeSharesFromUSDC,
  computeUSDCFromShares,
  mapErrorToUserMessage
} from '../../polymarket.js';
import {
  MIN_PERCENT_SELL_SHARES_BASE,
  MIN_MARKET_SELL_NOTIONAL_USDC_BASE
} from '../constants.js';
import { userStates, busyLocks } from '../runtime.js';

const SELL_PERCENT_OPTIONS = [1, 5, 10, 25, 50, 100];

function getEnabledSellPercents({
  totalSharesBase,
  referencePriceMicro,
  minSharesBase,
  minNotionalUsdcBase
}) {
  if (typeof totalSharesBase !== 'bigint' || totalSharesBase <= 0n) return [];
  if (typeof minSharesBase !== 'bigint' || minSharesBase <= 0n) return [];

  const minNotional = typeof minNotionalUsdcBase === 'bigint' ? minNotionalUsdcBase : 0n;
  const hasPriceForNotional = typeof referencePriceMicro === 'bigint' && referencePriceMicro > 0n;
  const enabled = [];

  for (const percent of SELL_PERCENT_OPTIONS) {
    const sharesBase = (totalSharesBase * BigInt(percent)) / 100n;
    if (sharesBase < minSharesBase) continue;

    if (minNotional > 0n && hasPriceForNotional) {
      const notionalUsdcBase = computeUSDCFromShares(sharesBase, referencePriceMicro);
      if (notionalUsdcBase < minNotional) continue;
    }

    enabled.push(percent);
  }

  return enabled;
}

function buildSellPercentKeyboard(prefix, t, enabledPercents = SELL_PERCENT_OPTIONS) {
  const enabledSet = new Set(
    (Array.isArray(enabledPercents) ? enabledPercents : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  );
  const rows = [
    [1, 5, 10],
    [25, 50, 100]
  ];
  const keyboard = new InlineKeyboard();

  for (const rowValues of rows) {
    const visible = rowValues.filter((value) => enabledSet.has(value));
    if (visible.length === 0) continue;

    for (const value of visible) {
      keyboard.text(`${value}%`, `${prefix}:${value}`);
    }
    keyboard.row();
  }
  keyboard.text(t('cancel'), 'cancel');

  return keyboard;
}

function buildMinSellThresholdMessage(totalSharesBase, minSharesBase, minNotionalUsdcBase) {
  const totalLabel = formatSharesFromBase(totalSharesBase);
  const minSharesLabel = formatSharesFromBase(minSharesBase);
  const minNotionalLabel = formatUSDCFromBase(minNotionalUsdcBase);
  return (
    `Position is too small for percentage sell. ` +
    `Balance: ${totalLabel} SHARES, minimum required: ${minSharesLabel} SHARES and ${minNotionalLabel} USDC notional.`
  );
}

export function createTradeMarketFeature(deps) {
  const {
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
  } = deps;

  async function showOutcomeSelection(ctx, actionKey, language, t) {
    if (!isValidMarketAction(actionKey)) {
      await ctx.answerCallbackQuery(t('error_generic'));
      return;
    }

    const chatId = ctx.chat.id;
    const cachedDetails = getCachedMarketDetailsState(chatId);
    if (!cachedDetails?.market) {
      await ctx.answerCallbackQuery(t('error_generic'));
      return;
    }

    const marketData = cachedDetails.market;
    const marketRef = getMarketRefValue(marketData, marketData);
    const { clobTokenIds, outcomes } = parseMarketTokensAndOutcomes(marketData, t);
    if (!Array.isArray(clobTokenIds) || clobTokenIds.length < 2) {
      await ctx.answerCallbackQuery(t('error_generic'));
      return;
    }

    const [translatedFirstOutcome, translatedSecondOutcome] = await translateUiLabelsForLanguage(
      language,
      [outcomes[0], outcomes[1]],
      'outcome selection labels'
    );

    const firstOutcome = translatedFirstOutcome || outcomes[0];
    const secondOutcome = translatedSecondOutcome || outcomes[1];
    const isSellAction = actionKey === 'ms' || actionKey === 'ls';
    let balancesBlock = '';
    if (isSellAction) {
      let firstBalance = '0';
      let secondBalance = '0';
      try {
        await ensureClientInitialized();
        const positions = await getPositions();
        const firstBalanceBase = getPositionSharesBaseForToken(positions, clobTokenIds[0]);
        const secondBalanceBase = getPositionSharesBaseForToken(positions, clobTokenIds[1]);
        firstBalance = formatSharesFromBase(firstBalanceBase);
        secondBalance = formatSharesFromBase(secondBalanceBase);
      } catch (error) {
        const ctxLog = createContext('bot', 'showOutcomeSelection');
        safeLogWarn(ctxLog, 'Could not load balances for outcome selection', {
          message: error?.message
        });
      }
      balancesBlock =
        `\n${escapeHtml(firstOutcome)} - ${escapeHtml(firstBalance)}` +
        `\n${escapeHtml(secondOutcome)} - ${escapeHtml(secondBalance)}`;
    }

    const actionLabel = getActionLabel(actionKey, t);
    const text =
      `<b>${escapeHtml(actionLabel)}</b>\n` +
      `<b>${t('market_question')}:</b> ${escapeHtml(marketData.question || marketData.title || marketRef)}\n\n` +
      `${t('select_outcome')}${balancesBlock}`;

    const keyboard = new InlineKeyboard()
      .text(truncateButtonLabel(firstOutcome) || t('yes'), `mo:${actionKey}:0`)
      .row()
      .text(truncateButtonLabel(secondOutcome) || t('no'), `mo:${actionKey}:1`)
      .row()
      .text(t('back'), 'mkt_back');

    await ctx.editMessageText(text, {
      reply_markup: keyboard,
      parse_mode: 'HTML'
    });
  }

  async function handleOutcomeSelection(ctx, actionKey, outcomeIndex, language, t) {
    if (!isValidMarketAction(actionKey)) {
      await ctx.answerCallbackQuery(t('error_generic'));
      return;
    }

    if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex > 1) {
      await ctx.answerCallbackQuery(t('error_generic'));
      return;
    }

    const chatId = ctx.chat.id;
    const marketData = getCachedMarketDetails(chatId);
    if (!marketData) {
      await ctx.answerCallbackQuery(t('error_generic'));
      return;
    }

    const { clobTokenIds, outcomes } = parseMarketTokensAndOutcomes(marketData, t);
    const tokenId = clobTokenIds[outcomeIndex];
    if (!tokenId) {
      await ctx.answerCallbackQuery(t('error_generic'));
      return;
    }

    const rawOutcomeName = outcomes[outcomeIndex];
    const translatedOutcomeName = await translateUiLabelForLanguage(
      language,
      rawOutcomeName,
      'selected outcome label'
    );
    const outcomeName = translatedOutcomeName || rawOutcomeName;
    const marketRef = marketData.slug || getMarketRefValue(marketData, marketData);

    if (actionKey === 'mb') {
      await startBuyFlow(ctx, marketRef, tokenId, outcomeName);
      return;
    }
    if (actionKey === 'ms') {
      await startSellFlow(ctx, marketRef, tokenId, outcomeName);
      return;
    }
    if (actionKey === 'lb') {
      await startLimitFlow(ctx, marketRef, tokenId, outcomeName, 'buy');
      return;
    }
    if (actionKey === 'ls') {
      await startLimitFlow(ctx, marketRef, tokenId, outcomeName, 'sell');
      return;
    }

    await ctx.answerCallbackQuery(t('error_generic'));
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

    await ensureClientInitialized();

    const { bestBidStr, bestAskStr } = await getBestBidAsk(state.tokenId);
    const price = bestAskStr || bestBidStr || '0.5';
    const priceMicro = parsePriceToMicro(price);

    const estimatedShares = computeSharesFromUSDC(usdcBase, priceMicro);
    const estimatedSharesFormatted = formatSharesFromBase(estimatedShares);

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

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_BUY',
      usdcBase,
      estimatedShares,
      priceMicro
    });
  }

  async function startBuyFlow(ctx, slug, tokenId, side) {
    const config = await loadConfig();
    const language = config.language || 'ru';
    const t = await getTranslator(language);
    const translatedSide = await translateUiLabelForLanguage(language, side, 'buy flow side label');

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    let balanceBase = null;
    let sideSharesBalanceBase = null;
    try {
      balanceBase = await getCollateralBalanceBase();
    } catch (error) {
      const ctxLog = createContext('bot', 'startBuyFlow');
      safeLogWarn(ctxLog, 'Failed to fetch collateral balance for buy prompt', {
        message: error?.message
      });
    }
    try {
      sideSharesBalanceBase = await getTokenSharesBalanceBase(tokenId);
    } catch (error) {
      const ctxLog = createContext('bot', 'startBuyFlow');
      safeLogWarn(ctxLog, 'Failed to fetch selected side shares balance for buy prompt', {
        tokenId,
        message: error?.message
      });
    }

    await showBuyAmountPrompt(
      ctx,
      { slug, tokenId, side: translatedSide || side },
      t,
      balanceBase,
      sideSharesBalanceBase
    );
  }

  async function handleBuyAmount(ctx, state, text) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    let usdcBase;
    try {
      usdcBase = parseUSDCToBase(text);
    } catch {
      await ctx.reply(t('error_invalid_amount'), {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      });
      return;
    }

    if (usdcBase <= 0n) {
      await ctx.reply(t('error_invalid_amount'), {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      });
      return;
    }

    busyLocks.set(chatId, true);

    try {
      await showBuyConfirmation(ctx, state, usdcBase, t);
    } catch (error) {
      const ctxLog = createContext('bot', 'handleBuyAmount');
      safeLogError(ctxLog, error, { state });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.reply(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      userStates.delete(chatId);
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function executeConfirmedBuy(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    const state = userStates.get(chatId);
    if (!state || !state.usdcBase || !state.slug || !state.tokenId) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }
    const slug = state.slug;
    const tokenId = state.tokenId;

    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText(t('loading'));

      await ensureAutoAllowancesConfigured();
      await ensureClientInitialized();

      const result = await placeMarketBuyFOK(tokenId, state.usdcBase);

      if (result.success) {
        const orderId = extractOrderId(result) || t('unknown');
        // Try to get transaction hash for link
        let orderIdDisplay = orderId;
        if (formatTxHashLink && result.transactionsHashes && result.transactionsHashes.length > 0) {
          orderIdDisplay = formatTxHashLink(result.transactionsHashes[0]);
        } else if (formatTxHashLink && result.transactionHash) {
          orderIdDisplay = formatTxHashLink(result.transactionHash);
        }
        await ctx.editMessageText(
          t('order_executed', { orderId: orderIdDisplay }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru'), parse_mode: 'HTML' }
        );
      } else {
        await ctx.editMessageText(
          t('error_order_failed', { message: getResultErrorMessage(result, t) }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
        );
      }
    } catch (error) {
      const ctxLog = createContext('bot', 'executeConfirmedBuy');
      safeLogError(ctxLog, error, { slug, tokenId, usdcBase: state.usdcBase.toString() });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  async function startSellFlow(ctx, slug, tokenId, side, meta = {}) {
    const config = await loadConfig();
    const language = config.language || 'ru';
    const t = await getTranslator(language);
    const translatedSide = await translateUiLabelForLanguage(language, side, 'sell flow side label');

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    let totalSharesBase = 0n;
    let referencePriceMicro = 500_000n;
    let enabledPercents = [];
    try {
      await ensureClientInitialized();

      const positions = await getPositions();
      const position = positions.find((p) => p.token_id === tokenId);
      if (!position || !position.size) {
        await ctx.editMessageText(t('error_no_positions'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
        });
        return;
      }

      totalSharesBase = parseSharesToBase(position.size.toString());
      if (totalSharesBase <= 0n) {
        await ctx.editMessageText(t('error_no_positions'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
        });
        return;
      }

      if (totalSharesBase < MIN_PERCENT_SELL_SHARES_BASE) {
        await ctx.editMessageText(
          t('error_order_failed', {
            message: buildMinSellThresholdMessage(
              totalSharesBase,
              MIN_PERCENT_SELL_SHARES_BASE,
              MIN_MARKET_SELL_NOTIONAL_USDC_BASE
            )
          }),
          { reply_markup: new InlineKeyboard().text(t('back'), 'back_menu') }
        );
        return;
      }

      try {
        const { bestBidStr, bestAskStr } = await getBestBidAsk(tokenId);
        const referencePrice = bestBidStr || bestAskStr || '0.5';
        referencePriceMicro = parsePriceToMicro(referencePrice);
      } catch (error) {
        const ctxLog = createContext('bot', 'startSellFlow');
        safeLogWarn(ctxLog, 'Failed to fetch reference price for market sell percentage buttons', {
          tokenId,
          message: error?.message
        });
      }

      enabledPercents = getEnabledSellPercents({
        totalSharesBase,
        referencePriceMicro,
        minSharesBase: MIN_PERCENT_SELL_SHARES_BASE,
        minNotionalUsdcBase: MIN_MARKET_SELL_NOTIONAL_USDC_BASE
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'startSellFlow');
      safeLogError(ctxLog, error, { tokenId });
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    if (enabledPercents.length === 0) {
      await ctx.editMessageText(
        t('error_order_failed', {
          message: buildMinSellThresholdMessage(
            totalSharesBase,
            MIN_PERCENT_SELL_SHARES_BASE,
            MIN_MARKET_SELL_NOTIONAL_USDC_BASE
          )
        }),
        { reply_markup: new InlineKeyboard().text(t('back'), 'back_menu') }
      );
      return;
    }

    const chatId = ctx.chat.id;

    userStates.set(chatId, {
      state: 'AWAITING_SELL_PERCENT',
      slug,
      tokenId,
      side: translatedSide || side,
      conditionId: meta?.conditionId ? String(meta.conditionId).trim() : null,
      totalSharesBase: totalSharesBase.toString(),
      referencePriceMicro: referencePriceMicro.toString()
    });

    await ctx.editMessageText(t('select_percentage'), {
      reply_markup: buildSellPercentKeyboard('sellpct', t, enabledPercents)
    });
  }

  async function handleSellPercent(ctx, percent) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (
      !state ||
      state.state !== 'AWAITING_SELL_PERCENT' ||
      !state.slug ||
      !state.tokenId ||
      !state.side ||
      Number.isNaN(percent)
    ) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      userStates.delete(chatId);
      return;
    }
    const slug = state.slug;
    const tokenId = state.tokenId;
    const side = state.side;

    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText(t('loading'));

      await ensureAutoAllowancesConfigured();
      await ensureClientInitialized();

      const positions = await getPositions();
      const position = positions.find((p) => p.token_id === tokenId);

      if (!position || !position.size) {
        await ctx.editMessageText(t('error_no_positions'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
        });
        return;
      }

      const totalSharesBase = parseSharesToBase(position.size.toString());
      if (totalSharesBase <= 0n) {
        await ctx.editMessageText(t('error_no_positions'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
        });
        return;
      }

      if (totalSharesBase < MIN_PERCENT_SELL_SHARES_BASE) {
        await ctx.editMessageText(
          t('error_order_failed', {
            message: buildMinSellThresholdMessage(
              totalSharesBase,
              MIN_PERCENT_SELL_SHARES_BASE,
              MIN_MARKET_SELL_NOTIONAL_USDC_BASE
            )
          }),
          { reply_markup: new InlineKeyboard().text(t('back'), 'back_menu') }
        );
        return;
      }

      const sharesToSellBase = (totalSharesBase * BigInt(percent)) / 100n;
      if (sharesToSellBase < MIN_PERCENT_SELL_SHARES_BASE) {
        const { bestBidStr, bestAskStr } = await getBestBidAsk(tokenId);
        const referencePrice = bestBidStr || bestAskStr || '0.5';
        const referencePriceMicro = parsePriceToMicro(referencePrice);
        const enabledPercents = getEnabledSellPercents({
          totalSharesBase,
          referencePriceMicro,
          minSharesBase: MIN_PERCENT_SELL_SHARES_BASE,
          minNotionalUsdcBase: MIN_MARKET_SELL_NOTIONAL_USDC_BASE
        });

        await ctx.editMessageText(
          t('error_order_failed', {
            message:
              `Selected percentage is too small. ` +
              `Sell amount must be at least ${formatSharesFromBase(MIN_PERCENT_SELL_SHARES_BASE)} SHARES.`
          }),
          {
            reply_markup: buildSellPercentKeyboard('sellpct', t, enabledPercents)
          }
        );
        return;
      }

      const { bestBidStr, bestAskStr } = await getBestBidAsk(tokenId);
      const price = bestBidStr || bestAskStr || '0.5';
      const priceMicro = parsePriceToMicro(price);

      const estimatedUsdc = computeUSDCFromShares(sharesToSellBase, priceMicro);
      if (estimatedUsdc < MIN_MARKET_SELL_NOTIONAL_USDC_BASE) {
        const enabledPercents = getEnabledSellPercents({
          totalSharesBase,
          referencePriceMicro: priceMicro,
          minSharesBase: MIN_PERCENT_SELL_SHARES_BASE,
          minNotionalUsdcBase: MIN_MARKET_SELL_NOTIONAL_USDC_BASE
        });

        await ctx.editMessageText(
          t('error_order_failed', {
            message:
              `Selected percentage is too small. ` +
              `Estimated notional must be at least ${formatUSDCFromBase(MIN_MARKET_SELL_NOTIONAL_USDC_BASE)} USDC.`
          }),
          {
            reply_markup: buildSellPercentKeyboard('sellpct', t, enabledPercents)
          }
        );
        return;
      }

      const confirmText = t('sell_confirm', {
        side,
        shares: formatSharesFromBase(sharesToSellBase),
        amount: formatUSDCFromBase(estimatedUsdc),
        price: formatPriceFromMicro(priceMicro)
      });

      const keyboard = new InlineKeyboard()
        .text(t('confirm'), 'confirm_sell')
        .text(t('cancel'), 'cancel_confirmation');

      await ctx.editMessageText(confirmText, { reply_markup: keyboard });

      userStates.set(chatId, {
        state: 'CONFIRMING_SELL',
        slug,
        tokenId,
        conditionId: state.conditionId || null,
        side,
        sharesBase: sharesToSellBase,
        estimatedUsdc,
        priceMicro
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'handleSellPercent');
      safeLogError(ctxLog, error, { slug, tokenId, percent });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      userStates.delete(chatId);
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function handleSellAmount(ctx, state, text) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    let sharesBase;
    try {
      sharesBase = parseSharesToBase(text);
    } catch {
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

    busyLocks.set(chatId, true);

    try {
      await ensureClientInitialized();

      const { bestBidStr, bestAskStr } = await getBestBidAsk(state.tokenId);
      const price = bestBidStr || bestAskStr || '0.5';
      const priceMicro = parsePriceToMicro(price);

      const estimatedUsdc = computeUSDCFromShares(sharesBase, priceMicro);

      const confirmText = t('sell_confirm', {
        side: state.side,
        shares: formatSharesFromBase(sharesBase),
        amount: formatUSDCFromBase(estimatedUsdc),
        price: formatPriceFromMicro(priceMicro)
      });

      const keyboard = new InlineKeyboard()
        .text(t('confirm'), 'confirm_sell')
        .text(t('cancel'), 'cancel_confirmation');

      await ctx.reply(confirmText, { reply_markup: keyboard });

      userStates.set(chatId, {
        ...state,
        state: 'CONFIRMING_SELL',
        sharesBase,
        estimatedUsdc,
        priceMicro
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'handleSellAmount');
      safeLogError(ctxLog, error, { state });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.reply(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      userStates.delete(chatId);
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function executeConfirmedSell(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    const state = userStates.get(chatId);
    if (!state || !state.sharesBase || !state.slug || !state.tokenId) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }
    const slug = state.slug;
    const tokenId = state.tokenId;
    const conditionId = state.conditionId ? String(state.conditionId).trim() : '';
    const outcomeSide = normalizeOutcomeSideHint(state.side);

    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText(t('loading'));

      await ensureAutoAllowancesConfigured();
      await ensureClientInitialized();
      await ensureContractsInitialized();

      const result = await placeMarketSellWithFallback(tokenId, state.sharesBase, {
        conditionId,
        outcome: outcomeSide
      });

      if (result.success) {
        await refreshPositionsAfterMutation(chatId, config.walletAddress, {
          sourceTokenId: tokenId,
          expectedReductionBase: state.sharesBase.toString()
        });

        const orderId = extractOrderId(result) || t('unknown');
        // Try to get transaction hash for link
        let orderIdDisplay = orderId;
        if (formatTxHashLink && result.transactionsHashes && result.transactionsHashes.length > 0) {
          orderIdDisplay = formatTxHashLink(result.transactionsHashes[0]);
        } else if (formatTxHashLink && result.transactionHash) {
          orderIdDisplay = formatTxHashLink(result.transactionHash);
        }

        await ctx.editMessageText(
          t('order_executed', { orderId: orderIdDisplay }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru'), parse_mode: 'HTML' }
        );
      } else {
        await ctx.editMessageText(
          t('error_order_failed', { message: getResultErrorMessage(result, t) }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
        );
      }
    } catch (error) {
      const ctxLog = createContext('bot', 'executeConfirmedSell');
      safeLogError(ctxLog, error, { slug, tokenId, sharesBase: state.sharesBase.toString() });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  async function handleBuyPercent(ctx, percent) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (
      !state ||
      state.state !== 'AWAITING_BUY_AMOUNT' ||
      !state.slug ||
      !state.tokenId ||
      !state.side ||
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

      const usdcBase = (balanceBase * BigInt(percent)) / 100n;
      if (usdcBase <= 0n) {
        await showBuyAmountPrompt(ctx, state, t, balanceBase);
        return;
      }

      await showBuyConfirmation(ctx, { ...state, collateralBalanceBase: balanceBase.toString() }, usdcBase, t);
    } catch (error) {
      const ctxLog = createContext('bot', 'handleBuyPercent');
      safeLogError(ctxLog, error, { slug: state.slug, tokenId: state.tokenId, percent });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      userStates.delete(chatId);
    } finally {
      busyLocks.delete(chatId);
    }
  }

  return {
    showOutcomeSelection,
    handleOutcomeSelection,
    startBuyFlow,
    handleBuyAmount,
    executeConfirmedBuy,
    startSellFlow,
    handleSellPercent,
    handleSellAmount,
    executeConfirmedSell,
    handleBuyPercent
  };
}
