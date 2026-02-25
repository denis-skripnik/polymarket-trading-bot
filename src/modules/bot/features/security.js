import { InlineKeyboard } from 'grammy';
import { Wallet } from 'ethers';
import { loadConfig, getPolygonRpcUrl } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getDecryptedPrivateKey, getDecryptedL2Credentials, initializeWallet } from '../../auth.js';
import { createContext, safeLogError, safeLogWarn } from '../../logger.js';
import {
  initClient,
  initContracts,
  setAllAllowances,
  getCollateralStatus,
  getOnchainAllowancesUSDC,
  formatUSDCFromBase
} from '../../polymarket.js';
import {
  busyLocks,
  userStates,
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
  setBotContractsReady
} from '../runtime.js';

export function createSecurityFeature(deps) {
  const { getMainMenuKeyboard, formatTxHashLink, escapeHtml } = deps;

  // Helper: Ensure CLOB client is initialized
  async function ensureClientInitialized() {
    const config = await loadConfig();
    const walletAddress = String(config.walletAddress || '').trim().toLowerCase();
    if (!walletAddress) {
      throw new Error('Wallet not configured');
    }

    if (botClientInitPromise && botClientInitializedWallet === walletAddress) {
      await botClientInitPromise;
      return;
    }
    if (botClientReady && botClientInitializedWallet === walletAddress) {
      return;
    }

    setBotClientInitializedWallet(walletAddress);
    setBotClientReady(false);
    setBotClientInitPromise((async () => {
      const privateKey = await getDecryptedPrivateKey();
      const l2Creds = await getDecryptedL2Credentials();
      await initClient(privateKey, l2Creds);
      setBotClientReady(true);
    })());

    try {
      await botClientInitPromise;
    } finally {
      setBotClientInitPromise(null);
    }
  }

  // Helper: Ensure contracts are initialized
  async function ensureContractsInitialized() {
    const config = await loadConfig();
    const walletAddress = String(config.walletAddress || '').trim().toLowerCase();
    if (!walletAddress) {
      throw new Error('Wallet not configured');
    }

    if (botContractsInitPromise && botContractsInitializedWallet === walletAddress) {
      await botContractsInitPromise;
      return;
    }
    if (botContractsReady && botContractsInitializedWallet === walletAddress) {
      return;
    }

    setBotContractsInitializedWallet(walletAddress);
    setBotContractsReady(false);
    setBotContractsInitPromise((async () => {
      const privateKey = await getDecryptedPrivateKey();
      const signer = new Wallet(privateKey);
      await initContracts(signer, getPolygonRpcUrl());
      setBotContractsReady(true);
    })());

    try {
      await botContractsInitPromise;
    } finally {
      setBotContractsInitPromise(null);
    }
  }

  // Automatically set required approvals on first trading interaction.
  async function ensureAutoAllowancesConfigured() {
    const config = await loadConfig();
    const walletAddress = (config.walletAddress || '').toLowerCase();

    if (!walletAddress) {
      throw new Error('Wallet not configured');
    }
    if (autoAllowanceReady.has(walletAddress)) {
      return;
    }

    const inFlight = autoAllowanceInFlight.get(walletAddress);
    if (inFlight) {
      await inFlight;
      return;
    }

    const allowancePromise = (async () => {
      const privateKey = await getDecryptedPrivateKey();
      const signer = new Wallet(privateKey);
      try {
        await setAllAllowances(signer);
        autoAllowanceReady.add(walletAddress);
      } catch (error) {
        throw new Error(`AUTO_ALLOWANCE_SETUP_FAILED: ${error?.message || error}`);
      }
    })();

    autoAllowanceInFlight.set(walletAddress, allowancePromise);

    try {
      await allowancePromise;
    } finally {
      if (autoAllowanceInFlight.get(walletAddress) === allowancePromise) {
        autoAllowanceInFlight.delete(walletAddress);
      }
    }
  }

  // Handle wallet initialization
  async function handleInitWallet(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');

    // Set busy lock
    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText(t('loading'));

      const result = await initializeWallet();

      await ctx.editMessageText(result.warning, {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'handleInitWallet');
      safeLogError(ctxLog, error);
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('try_again'), 'init_wallet').text(t('back'), 'back_menu')
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  // Handle set allowances
  async function handleSetAllowances(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    // Set busy lock
    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText(t('loading'));

      // Initialize contracts
      const privateKey = await getDecryptedPrivateKey();
      const signer = new Wallet(privateKey);

      const results = await setAllAllowances(signer);
      if (config.walletAddress) {
        autoAllowanceReady.add(config.walletAddress.toLowerCase());
      }

      let text = t('allowances_set') + ':\n';
      results.forEach(r => {
        const hash = String(r?.hash || '').trim();
        const anchorLabel = hash.length > 20 ? `${hash.substring(0, 20)}...` : hash;
        const hashLabel = hash ? formatTxHashLink(hash, anchorLabel) : escapeHtml(t('unknown'));
        text += `- ${escapeHtml(r.type)}: ${hashLabel}\n`;
      });

      // Show CLOB collateral allowance after setting allowances
      try {
        await ensureClientInitialized();
        const { allowances } = await getCollateralStatus();
        const ctfAllowanceBig = BigInt(allowances.ctfExchange);
        const ctfAllowanceDisplay = formatUSDCFromBase(ctfAllowanceBig);
        text += `\n<b>${t('clob_collateral_allowance')}</b>: ${ctfAllowanceDisplay} USDC`;
      } catch (clobError) {
        text += `\n<i>${t('clob_allowance_unavailable')}</i>`;
      }

      await ctx.editMessageText(text, {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru'),
        parse_mode: 'HTML'
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'handleSetAllowances');
      safeLogError(ctxLog, error);
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('try_again'), 'set_allowances').text(t('back'), 'back_menu')
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  // Handle collateral status display
  async function handleCollateralStatus(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    // Set busy lock
    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText(t('loading'));

      // Initialize client
      await ensureClientInitialized();

      // Initialize contracts for on-chain checks
      const privateKey = await getDecryptedPrivateKey();
      const signer = new Wallet(privateKey);
      await initContracts(signer, getPolygonRpcUrl());

      // Get collateral status
      const { balance, allowances } = await getCollateralStatus();

      // Format values from base units
      const balanceBig = BigInt(balance);
      const ctfAllowanceBig = BigInt(allowances.ctfExchange);
      const negRiskExchangeAllowanceBig = BigInt(allowances.negRiskExchange);
      const negRiskAdapterAllowanceBig = BigInt(allowances.negRiskAdapter);
      const balanceDisplay = formatUSDCFromBase(balanceBig);
      const ctfAllowanceDisplay = formatUSDCFromBase(ctfAllowanceBig);
      const negRiskExchangeAllowanceDisplay = formatUSDCFromBase(negRiskExchangeAllowanceBig);
      const negRiskAdapterAllowanceDisplay = formatUSDCFromBase(negRiskAdapterAllowanceBig);

      let text = `<b>${t('collateral_status_title')}</b>\n\n` +
                `${t('collateral_balance', { amount: balanceDisplay })}\n\n` +
                `<b>${t('clob_allowances_title')}</b>\n` +
                `${t('allowance_ctf_exchange', { amount: ctfAllowanceDisplay })}\n` +
                `${t('allowance_neg_risk_exchange', { amount: negRiskExchangeAllowanceDisplay })}\n` +
                `${t('allowance_neg_risk_adapter', { amount: negRiskAdapterAllowanceDisplay })}`;

      // Get on-chain allowances for diagnostic
      try {
        const onchainAllowances = await getOnchainAllowancesUSDC(config.walletAddress);
        text += `\n\n<b>${t('onchain_allowances_title')}</b>:`;
        onchainAllowances.forEach(item => {
          const allowanceBn = BigInt(item.allowance);
          const display = formatUSDCFromBase(allowanceBn);
          text += `\n${item.name}: ${display} USDC`;
        });
      } catch (onchainError) {
        text += `\n\n<i>${t('onchain_allowances_unavailable')}</i>`;
      }

      await ctx.editMessageText(text, {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings'),
        parse_mode: 'HTML'
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'handleCollateralStatus');
      safeLogError(ctxLog, error);
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('try_again'), 'collateral_status').text(t('back'), 'settings')
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  // Handle start export private key flow
  async function handleStartExportPk(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');

    // Check if wallet is configured
    if (!config.walletAddress) {
      await ctx.editMessageText(t('export_pk_wallet_missing'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings')
      });
      return;
    }

    // Show warning and ask for confirmation
    const keyboard = new InlineKeyboard()
      .text(t('export_pk_confirm'), 'confirm_export_pk')
      .text(t('export_pk_cancel'), 'cancel_export_pk');

    await ctx.editMessageText(t('export_pk_warning'), { reply_markup: keyboard });
  }

  // Handle confirm export private key (after warning)
  async function handleConfirmExportPk(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    // Check busy lock
    if (busyLocks.get(chatId)) {
      await ctx.answerCallbackQuery(t('error_busy'));
      return;
    }

    // Set busy lock
    busyLocks.set(chatId, true);

    try {
      // Set state to await explicit confirmation text
      userStates.set(chatId, {
        state: 'AWAITING_EXPORT_CONFIRMATION',
        warningMessageId: ctx.callbackQuery.message.message_id
      });

      // Ask for confirmation word
      await ctx.editMessageText(t('export_pk_enter_password'), {
        reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel_export_pk')
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'handleConfirmExportPk');
      safeLogError(ctxLog, error);
      busyLocks.delete(chatId);
      userStates.delete(chatId);
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings')
      });
    }
  }

  // Handle cancel export private key
  async function handleCancelExportPk(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    // Clear state
    userStates.delete(chatId);
    busyLocks.delete(chatId);

    await ctx.editMessageText(t('cancelled'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'ru')
    });
  }

  // Handle confirmation input for export
  async function handleExportConfirmation(ctx, state, text) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    // Delete the user's confirmation message immediately for security
    try {
      await ctx.api.deleteMessage(chatId, ctx.message.message_id);
    } catch (deleteError) {
      // Log but continue - message might already be deleted
      const ctxLog = createContext('bot', 'handleExportConfirmation');
      safeLogWarn(ctxLog, 'Failed to delete confirmation message', { error: deleteError.message });
    }

    try {
      const confirmationText = String(text || '').trim();
      if (confirmationText !== 'confirm') {
        userStates.delete(chatId);
        busyLocks.delete(chatId);

        await ctx.reply(t('export_pk_invalid_password'), {
          reply_markup: await getMainMenuKeyboard(config.language || 'ru')
        });
        return;
      }

      const privateKey = await getDecryptedPrivateKey();

      // Confirmation valid - send private key
      const messageText = t('export_pk_sent_will_delete', { privateKey });
      
      // Send the private key message
      const sentMessage = await ctx.reply(messageText, { parse_mode: 'HTML' });

      // Clear state and busy lock
      userStates.delete(chatId);
      busyLocks.delete(chatId);

      // Schedule auto-deletion after 90 seconds
      setTimeout(async () => {
        try {
          await ctx.api.deleteMessage(chatId, sentMessage.message_id);
        } catch (deleteError) {
          const ctxLog = createContext('bot', 'autoDeleteExportMessage');
          safeLogWarn(ctxLog, 'Failed to auto-delete private key message', { error: deleteError.message });
        }
      }, 90000);

      // Also try to delete the warning/prompt messages
      if (state.warningMessageId) {
        setTimeout(async () => {
          try {
            await ctx.api.deleteMessage(chatId, state.warningMessageId);
          } catch (deleteError) {
            // Message might already be deleted or too old
          }
        }, 1000);
      }

    } catch (error) {
      const ctxLog = createContext('bot', 'handleExportConfirmation');
      safeLogError(ctxLog, error);
      
      userStates.delete(chatId);
      busyLocks.delete(chatId);
      
      await ctx.reply(t('error_generic'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'ru')
      });
    }
  }

  return {
    handleInitWallet,
    handleSetAllowances,
    handleCollateralStatus,
    handleStartExportPk,
    handleConfirmExportPk,
    handleCancelExportPk,
    handleExportConfirmation,
    ensureClientInitialized,
    ensureContractsInitialized,
    ensureAutoAllowancesConfigured
  };
}
