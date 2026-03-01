import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getCollateralBalanceBase, withdrawUSDC, formatUSDCFromBase, parseUSDCToBase, mapErrorToUserMessage } from '../../polymarket.js';
import { userStates, busyLocks } from '../runtime.js';
import { createContext, safeLogError, safeLogWarn } from '../../logger.js';

const WITHDRAW_PERCENT_OPTIONS = [10, 20, 30, 50];

function isValidEthAddress(address) {
  if (!address || typeof address !== 'string') return false;
  const normalized = address.toLowerCase().trim();
  return /^0x[a-f0-9]{40}$/.test(normalized);
}

function buildWithdrawPercentKeyboard(prefix, t) {
  const keyboard = new InlineKeyboard();
  keyboard.text('10%', `${prefix}:10`);
  keyboard.text('20%', `${prefix}:20`);
  keyboard.text('30%', `${prefix}:30`);
  keyboard.row();
  keyboard.text('50%', `${prefix}:50`);
  keyboard.text(t('withdraw_max'), 'withdraw_max');
  keyboard.row();
  keyboard.text(t('cancel'), 'cancel');
  return keyboard;
}

export function createWithdrawFeature(deps) {
  const {
    getMainMenuKeyboard,
    ensureClientInitialized,
    ensureContractsInitialized,
    formatTxHashLink
  } = deps;

  async function startWithdrawFlow(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings')
      });
      return;
    }

    // Set state to await address input
    userStates.set(chatId, {
      state: 'AWAITING_WITHDRAW_ADDRESS'
    });

    await ctx.editMessageText(t('withdraw_prompt_address'), {
      reply_markup: new InlineKeyboard().text(t('back'), 'settings')
    });
  }

  async function handleWithdrawAddress(ctx, text) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    const address = text.trim();

    if (!isValidEthAddress(address)) {
      await ctx.reply(t('withdraw_invalid_address'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings')
      });
      return;
    }

    let balanceBase = null;
    try {
      await ensureClientInitialized();
      balanceBase = await getCollateralBalanceBase();
    } catch (error) {
      const ctxLog = createContext('bot', 'handleWithdrawAddress');
      safeLogWarn(ctxLog, 'Failed to fetch collateral balance for withdraw', {
        message: error?.message
      });
    }

    const balanceDisplay = balanceBase !== null ? formatUSDCFromBase(balanceBase) : t('na');

    // Set state to await amount input
    userStates.set(chatId, {
      state: 'AWAITING_WITHDRAW_AMOUNT',
      withdrawAddress: address.toLowerCase(),
      balanceBase: balanceBase !== null ? balanceBase.toString() : null
    });

    const textMessage = 
      `${t('withdraw_balance', { amount: balanceDisplay })}\n\n` +
      `${t('withdraw_enter_amount_or_use_percent')}`;

    await ctx.reply(textMessage, {
      reply_markup: buildWithdrawPercentKeyboard('withdrawpct', t)
    });
  }

  async function handleWithdrawAmount(ctx, text) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    const state = userStates.get(chatId);
    if (!state || state.state !== 'AWAITING_WITHDRAW_AMOUNT' || !state.withdrawAddress) {
      await ctx.reply(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    let amountBase;
    try {
      amountBase = parseUSDCToBase(text);
    } catch {
      await ctx.reply(t('withdraw_invalid_amount'), {
        reply_markup: buildWithdrawPercentKeyboard('withdrawpct', t)
      });
      return;
    }

    if (amountBase <= 0n) {
      await ctx.reply(t('withdraw_invalid_amount'), {
        reply_markup: buildWithdrawPercentKeyboard('withdrawpct', t)
      });
      return;
    }

    const balanceBase = state.balanceBase ? BigInt(state.balanceBase) : 0n;
    if (balanceBase > 0n && amountBase > balanceBase) {
      await ctx.reply(t('withdraw_insufficient', { available: formatUSDCFromBase(balanceBase) }), {
        reply_markup: buildWithdrawPercentKeyboard('withdrawpct', t)
      });
      return;
    }

    // Show confirmation
    await showWithdrawConfirmation(ctx, state.withdrawAddress, amountBase, t);
  }

  async function handleWithdrawPercent(ctx, percent) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    const state = userStates.get(chatId);
    if (!state || state.state !== 'AWAITING_WITHDRAW_AMOUNT' || !state.withdrawAddress) {
      await ctx.reply(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    const balanceBase = state.balanceBase ? BigInt(state.balanceBase) : 0n;
    if (balanceBase <= 0n) {
      await ctx.reply(t('error_insufficient_funds'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings')
      });
      return;
    }

    let amountBase;
    if (percent === 'max') {
      amountBase = balanceBase;
    } else {
      const percentNum = parseInt(percent, 10);
      if (isNaN(percentNum) || percentNum <= 0) {
        await ctx.reply(t('withdraw_invalid_amount'), {
          reply_markup: buildWithdrawPercentKeyboard('withdrawpct', t)
        });
        return;
      }
      amountBase = (balanceBase * BigInt(percentNum)) / 100n;
    }

    if (amountBase <= 0n) {
      await ctx.reply(t('withdraw_invalid_amount'), {
        reply_markup: buildWithdrawPercentKeyboard('withdrawpct', t)
      });
      return;
    }

    await showWithdrawConfirmation(ctx, state.withdrawAddress, amountBase, t);
  }

  async function showWithdrawConfirmation(ctx, address, amountBase, t) {
    const chatId = ctx.chat.id;
    const amountDisplay = formatUSDCFromBase(amountBase);

    const confirmText = t('withdraw_confirm', {
      amount: amountDisplay,
      address: address
    });

    const keyboard = new InlineKeyboard()
      .text(t('confirm'), 'confirm_withdraw')
      .text(t('cancel'), 'cancel_confirmation');

    userStates.set(chatId, {
      state: 'CONFIRMING_WITHDRAW',
      withdrawAddress: address,
      withdrawAmountBase: amountBase.toString()
    });

    if (ctx.callbackQuery) {
      await ctx.editMessageText(confirmText, { reply_markup: keyboard });
    } else {
      await ctx.reply(confirmText, { reply_markup: keyboard });
    }
  }

  async function executeWithdraw(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    const state = userStates.get(chatId);
    if (!state || state.state !== 'CONFIRMING_WITHDRAW' || !state.withdrawAddress || !state.withdrawAmountBase) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
      return;
    }

    const address = state.withdrawAddress;
    const amountBase = BigInt(state.withdrawAmountBase);

    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText(t('loading'));

      await ensureContractsInitialized();

      const receipt = await withdrawUSDC(address, amountBase);

      if (receipt && (receipt.hash || receipt.transactionHash)) {
        const txHash = receipt.hash || receipt.transactionHash;
        const txLink = formatTxHashLink ? formatTxHashLink(txHash) : txHash;
        await ctx.editMessageText(
          t('withdraw_success', { txHash: txLink }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
        );
      } else {
        await ctx.editMessageText(
          t('withdraw_success', { txHash: 'unknown' }),
          { reply_markup: await getMainMenuKeyboard(config.language || 'ru') }
        );
      }
    } catch (error) {
      const ctxLog = createContext('bot', 'executeWithdraw');
      safeLogError(ctxLog, error, { address, amountBase: amountBase.toString() });
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
    startWithdrawFlow,
    handleWithdrawAddress,
    handleWithdrawAmount,
    handleWithdrawPercent,
    executeWithdraw
  };
}
