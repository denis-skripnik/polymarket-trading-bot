import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import {
  getBestBidAsk,
  parseUSDCToBase,
  parseSharesToBase,
  formatUSDCFromBase,
  formatSharesFromBase,
  parsePriceToMicro,
  formatPriceFromMicro,
  computeSharesFromUSDC,
  computeUSDCFromShares,
  createOrder,
  mapErrorToUserMessage
} from '../../polymarket.js';
import { saveOrder } from '../../database.js';
import {
  MIN_PERCENT_SELL_SHARES_BASE,
  MIN_LIMIT_SELL_NOTIONAL_USDC_BASE,
  MIN_LIMIT_ORDER_SHARES_BASE
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

export function createTradeLimitFeature(deps) {
  const {
    ensureClientInitialized,
    ensureAutoAllowancesConfigured,
    getMainMenuKeyboard,
    createContext,
    safeLogWarn,
    safeLogError,
    getCollateralBalanceBase,
    getTokenSharesBalanceBase,
    buildUsdcPercentKeyboard,
    buildLimitPriceKeyboard,
    parsePriceMicroSafe,
    applyPercentToPriceMicro,
    extractOrderId,
    getResultErrorMessage
  } = deps;

  async function startLimitFlow(ctx, slug, tokenId, sideLabel, tradeSide) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    if (tradeSide === 'buy') {
      let collateralBalanceBase = null;
      try {
        collateralBalanceBase = await getCollateralBalanceBase();
      } catch (error) {
        const ctxLog = createContext('bot', 'startLimitFlow');
        safeLogWarn(ctxLog, 'Failed to fetch collateral balance for limit buy', {
          tokenId,
          message: error?.message
        });
      }

      const balanceDisplay = collateralBalanceBase !== null ? formatUSDCFromBase(collateralBalanceBase) : t('na');
      const prompt =
        `${t('limit_enter_usdc', { action: t('buy'), side: sideLabel })}\n\n` +
        `${t('collateral_balance', { amount: balanceDisplay })}`;

      userStates.set(chatId, {
        state: 'AWAITING_LIMIT_AMOUNT',
        slug,
        tokenId,
        sideLabel,
        tradeSide,
        limitAmountMode: 'usdc',
        collateralBalanceBase: collateralBalanceBase !== null ? collateralBalanceBase.toString() : null
      });

      await ctx.editMessageText(prompt, {
        reply_markup: buildUsdcPercentKeyboard('lbupct', t)
      });
      return;
    }

    let sharesBalanceBase = 0n;
    try {
      sharesBalanceBase = await getTokenSharesBalanceBase(tokenId);
    } catch (error) {
      const ctxLog = createContext('bot', 'startLimitFlow');
      safeLogWarn(ctxLog, 'Failed to fetch shares balance for limit sell', {
        tokenId,
        message: error?.message
      });
    }

    if (sharesBalanceBase <= 0n) {
      await ctx.editMessageText(t('error_no_positions'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'mkt_back')
      });
      return;
    }

    if (sharesBalanceBase < MIN_PERCENT_SELL_SHARES_BASE) {
      await ctx.editMessageText(
        t('error_order_failed', {
          message: buildMinSellThresholdMessage(
            sharesBalanceBase,
            MIN_PERCENT_SELL_SHARES_BASE,
            MIN_LIMIT_SELL_NOTIONAL_USDC_BASE
          )
        }),
        { reply_markup: new InlineKeyboard().text(t('back'), 'mkt_back') }
      );
      return;
    }

    let referencePriceMicro = 500_000n;
    try {
      await ensureClientInitialized();
      const { bestBidStr, bestAskStr } = await getBestBidAsk(tokenId);
      const referencePrice = bestBidStr || bestAskStr || '0.5';
      referencePriceMicro = parsePriceToMicro(referencePrice);
    } catch (error) {
      const ctxLog = createContext('bot', 'startLimitFlow');
      safeLogWarn(ctxLog, 'Failed to fetch reference price for limit sell percentage buttons', {
        tokenId,
        message: error?.message
      });
    }

    const minSharesForLimitPercent = MIN_LIMIT_ORDER_SHARES_BASE > MIN_PERCENT_SELL_SHARES_BASE
      ? MIN_LIMIT_ORDER_SHARES_BASE
      : MIN_PERCENT_SELL_SHARES_BASE;
    const enabledPercents = getEnabledSellPercents({
      totalSharesBase: sharesBalanceBase,
      referencePriceMicro,
      minSharesBase: minSharesForLimitPercent,
      minNotionalUsdcBase: MIN_LIMIT_SELL_NOTIONAL_USDC_BASE
    });

    if (enabledPercents.length === 0) {
      await ctx.editMessageText(
        t('error_order_failed', {
          message: buildMinSellThresholdMessage(
            sharesBalanceBase,
            minSharesForLimitPercent,
            MIN_LIMIT_SELL_NOTIONAL_USDC_BASE
          )
        }),
        { reply_markup: new InlineKeyboard().text(t('back'), 'mkt_back') }
      );
      return;
    }

    const prompt =
      `${t('limit_enter_shares', { action: t('sell'), side: sideLabel })}\n\n` +
      `${t('limit_shares_balance', { amount: formatSharesFromBase(sharesBalanceBase) })}`;

    userStates.set(chatId, {
      state: 'AWAITING_LIMIT_AMOUNT',
      slug,
      tokenId,
      sideLabel,
      tradeSide,
      limitAmountMode: 'shares',
      sharesBalanceBase: sharesBalanceBase.toString(),
      referencePriceMicro: referencePriceMicro.toString()
    });

    await ctx.editMessageText(prompt, {
      reply_markup: buildSellPercentKeyboard('lspct', t, enabledPercents)
    });
  }

  async function handleLimitAmount(ctx, state, text) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const amountMode = state.limitAmountMode || (state.tradeSide === 'sell' ? 'shares' : 'usdc');
    if (amountMode === 'shares') {
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

      await showLimitPricePrompt(ctx, { ...state, sharesBase }, t, false);
      return;
    }

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

    await showLimitPricePrompt(ctx, { ...state, usdcBase }, t, false);
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
      if (estimatedUsdc < MIN_LIMIT_SELL_NOTIONAL_USDC_BASE) {
        const message =
          `Limit sell notional is too small. ` +
          `Minimum required: ${formatUSDCFromBase(MIN_LIMIT_SELL_NOTIONAL_USDC_BASE)} USDC.`;
        if (useEdit && ctx.callbackQuery) {
          await ctx.editMessageText(t('error_order_failed', { message }), {
            reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
          });
        } else {
          await ctx.reply(t('error_order_failed', { message }), {
            reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
          });
        }
        return;
      }
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
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    let priceMicro;
    try {
      priceMicro = parsePriceToMicro(text.replace(',', '.'));
    } catch {
      await ctx.reply(t('limit_invalid_price'), {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      });
      return;
    }

    if (priceMicro <= 0n || priceMicro >= 1_000_000n) {
      await ctx.reply(t('limit_invalid_price'), {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      });
      return;
    }
    await showLimitConfirmation(ctx, state, priceMicro, t, false);
  }

  async function handleLimitBuyPercent(ctx, percent) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (
      !state ||
      state.state !== 'AWAITING_LIMIT_AMOUNT' ||
      state.tradeSide !== 'buy' ||
      Number.isNaN(percent)
    ) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    let balanceBase = 0n;
    try {
      balanceBase = BigInt(state.collateralBalanceBase ?? 0);
    } catch {
      balanceBase = 0n;
    }
    if (balanceBase <= 0n) {
      try {
        balanceBase = await getCollateralBalanceBase();
      } catch {
        balanceBase = 0n;
      }
    }

    const usdcBase = (balanceBase * BigInt(percent)) / 100n;
    if (usdcBase <= 0n) {
      await ctx.editMessageText(t('error_invalid_amount'), {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
      });
      return;
    }

    await showLimitPricePrompt(
      ctx,
      {
        ...state,
        usdcBase,
        collateralBalanceBase: balanceBase.toString()
      },
      t,
      true
    );
  }

  async function handleLimitSellPercent(ctx, percent) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (
      !state ||
      state.state !== 'AWAITING_LIMIT_AMOUNT' ||
      state.tradeSide !== 'sell' ||
      Number.isNaN(percent)
    ) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    let sharesBalanceBase = 0n;
    try {
      sharesBalanceBase = BigInt(state.sharesBalanceBase ?? 0);
    } catch {
      sharesBalanceBase = 0n;
    }
    if (sharesBalanceBase <= 0n) {
      try {
        sharesBalanceBase = await getTokenSharesBalanceBase(state.tokenId);
      } catch {
        sharesBalanceBase = 0n;
      }
    }

    const sharesBase = (sharesBalanceBase * BigInt(percent)) / 100n;
    const minSharesForLimitPercent = MIN_LIMIT_ORDER_SHARES_BASE > MIN_PERCENT_SELL_SHARES_BASE
      ? MIN_LIMIT_ORDER_SHARES_BASE
      : MIN_PERCENT_SELL_SHARES_BASE;
    if (sharesBase < minSharesForLimitPercent) {
      let referencePriceMicro = 500_000n;
      try {
        const { bestBidStr, bestAskStr } = await getBestBidAsk(state.tokenId);
        const referencePrice = bestBidStr || bestAskStr || '0.5';
        referencePriceMicro = parsePriceToMicro(referencePrice);
      } catch {}

      const enabledPercents = getEnabledSellPercents({
        totalSharesBase: sharesBalanceBase,
        referencePriceMicro,
        minSharesBase: minSharesForLimitPercent,
        minNotionalUsdcBase: MIN_LIMIT_SELL_NOTIONAL_USDC_BASE
      });

      await ctx.editMessageText(t('error_invalid_amount'), {
        reply_markup: buildSellPercentKeyboard('lspct', t, enabledPercents)
      });
      return;
    }

    let referencePriceMicro = 500_000n;
    try {
      const { bestBidStr, bestAskStr } = await getBestBidAsk(state.tokenId);
      const referencePrice = bestBidStr || bestAskStr || '0.5';
      referencePriceMicro = parsePriceToMicro(referencePrice);
    } catch {}

    const estimatedUsdc = computeUSDCFromShares(sharesBase, referencePriceMicro);
    if (estimatedUsdc < MIN_LIMIT_SELL_NOTIONAL_USDC_BASE) {
      const enabledPercents = getEnabledSellPercents({
        totalSharesBase: sharesBalanceBase,
        referencePriceMicro,
        minSharesBase: minSharesForLimitPercent,
        minNotionalUsdcBase: MIN_LIMIT_SELL_NOTIONAL_USDC_BASE
      });

      await ctx.editMessageText(
        t('error_order_failed', {
          message:
            `Selected percentage is too small. ` +
            `Estimated notional must be at least ${formatUSDCFromBase(MIN_LIMIT_SELL_NOTIONAL_USDC_BASE)} USDC.`
        }),
        { reply_markup: buildSellPercentKeyboard('lspct', t, enabledPercents) }
      );
      return;
    }

    await showLimitPricePrompt(
      ctx,
      {
        ...state,
        sharesBase,
        sharesBalanceBase: sharesBalanceBase.toString()
      },
      t,
      true
    );
  }

  async function handleLimitPricePreset(ctx, preset) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (!state || state.state !== 'AWAITING_LIMIT_PRICE') {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    let referencePriceMicro = 0n;
    try {
      referencePriceMicro = BigInt(state.referencePriceMicro ?? 0);
    } catch {
      referencePriceMicro = 0n;
    }
    if (referencePriceMicro <= 0n) {
      referencePriceMicro = 500_000n;
    }

    let priceMicro = referencePriceMicro;
    if (preset !== 'cur') {
      const deltaPercent = parseInt(String(preset), 10);
      if (Number.isNaN(deltaPercent)) {
        await ctx.editMessageText(t('limit_invalid_price'), {
          reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel')
        });
        return;
      }
      priceMicro = applyPercentToPriceMicro(referencePriceMicro, deltaPercent);
    }

    await showLimitConfirmation(ctx, state, priceMicro, t, true);
  }

  async function executeConfirmedLimit(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (
      !state ||
      state.state !== 'CONFIRMING_LIMIT' ||
      !state.slug ||
      !state.tokenId ||
      !state.sharesBase ||
      !state.priceMicro ||
      !state.tradeSide
    ) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    let sharesBase;
    let priceMicro;
    try {
      sharesBase = BigInt(state.sharesBase?.toString?.() ?? state.sharesBase);
      priceMicro = BigInt(state.priceMicro?.toString?.() ?? state.priceMicro);
    } catch {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    if (sharesBase <= 0n || priceMicro <= 0n || priceMicro >= 1_000_000n) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    if (sharesBase < MIN_LIMIT_ORDER_SHARES_BASE) {
      await ctx.editMessageText(
        t('limit_min_size', { min: formatSharesFromBase(MIN_LIMIT_ORDER_SHARES_BASE) }),
        { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
      );
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await ctx.editMessageText(t('loading'));

      await ensureAutoAllowancesConfigured();
      await ensureClientInitialized();

      const order = await createOrder({
        tokenId: state.tokenId,
        price: formatPriceFromMicro(priceMicro),
        sizeShares: formatSharesFromBase(sharesBase),
        side: state.tradeSide === 'buy' ? 'BUY' : 'SELL',
        orderType: 'GTC'
      });

      const orderId = extractOrderId(order);
      if (!orderId) {
        throw new Error('LIMIT_ORDER_ID_MISSING');
      }
      await saveOrder(
        orderId,
        state.slug,
        state.tokenId,
        state.tradeSide,
        'limit',
        'GTC',
        priceMicro,
        sharesBase
      );

      await ctx.editMessageText(
        t('limit_order_placed', {
          orderId,
          action: state.tradeSide === 'buy' ? t('buy') : t('sell'),
          side: state.sideLabel || t('unknown')
        }),
        { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
      );
    } catch (error) {
      const ctxLog = createContext('bot', 'executeConfirmedLimit');
      safeLogError(ctxLog, error, {
        tokenId: state.tokenId,
        tradeSide: state.tradeSide
      });
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
    startLimitFlow,
    handleLimitAmount,
    handleLimitPrice,
    handleLimitBuyPercent,
    handleLimitSellPercent,
    handleLimitPricePreset,
    executeConfirmedLimit
  };
}
