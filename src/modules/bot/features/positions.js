import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getPositions, formatSharesFromBase, parseSharesToBase } from '../../polymarket.js';
import { busyLocks, userStates } from '../runtime.js';

// Minimum display threshold: $0.01 OR 0.01 shares (whichever is easier to meet)
const MIN_DISPLAY_VALUE_USD = 0.01;
const MIN_DISPLAY_SHARES_BASE = parseSharesToBase('0.01');

export function createPositionsFeature(deps) {
  const {
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
  } = deps;

  async function showPositions(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const explorerApiConfigured = Boolean(String(process.env.ETHERSCAN_API_KEY || '').trim());
    
    // Check if wallet is configured
    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }
    
    await ctx.editMessageText(t('loading'));
    
    // Set busy lock
    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);
    
    try {
      // Initialize client
      await ensureClientInitialized();
      
      // Get positions from API
      const positions = await getPositions();
      
      // Filter out dust positions (too small to sell profitably)
      const filteredPositions = positions.filter(pos => {
        const sizeBase = parseSharesBaseSafe(pos.size ?? 0);
        const currentValue = Number(pos.currentValue ?? 0);
        // Keep if: shares >= min threshold OR value >= $0.01
        return sizeBase >= MIN_DISPLAY_SHARES_BASE || currentValue >= MIN_DISPLAY_VALUE_USD;
      });
      
      if (!filteredPositions || filteredPositions.length === 0) {
        let message = t('error_no_positions');
        if (!explorerApiConfigured) {
          message += `\n\n${t('positions_onchain_api_key_hint')}`;
        }

        await ctx.editMessageText(message, {
          reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
        });
        return;
      }

      // Cache latest positions for callbacks (pos:<index>, psell:<index>, pmrg:<index>)
      // Use filtered positions for display, but keep full list for reference
      setCachedPositions(chatId, filteredPositions);

      let text = t('positions_title') + '\n\n';
      const keyboard = new InlineKeyboard();

      filteredPositions.forEach((pos, index) => {
        const market = pos.market || t('unknown');
        const side = pos.outcome || pos.side || t('unknown');
        const size = pos.size || '0';
        const avgPrice = formatUsdOrNA(pos.avgPrice, 4, t);
        const value = formatUsdOrNA(pos.currentValue, 2, t);

        text += `${index + 1}. ${market}\n`;
        text += `   ${side}: ${size} ${t('shares')} @ ${avgPrice}\n`;
        text += `   ${t('current_value')}: ${value}\n\n`;

        keyboard.text(`${index + 1}`, `pos:${index}`);
        if ((index + 1) % 4 === 0) {
          keyboard.row();
        }
      });

      keyboard.row();
      keyboard.text(t('refresh'), 'positions');
      keyboard.text(t('back'), 'back_menu');

      await ctx.editMessageText(text, {
        reply_markup: keyboard
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'showPositions');
      safeLogError(ctxLog, error);
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('try_again'), 'positions').text(t('back'), 'back_menu')
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function showPositionDetailsFromCache(ctx, index) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    if (Number.isNaN(index) || index < 0) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'positions')
      });
      return;
    }

    const cachedPosition = getCachedPosition(chatId, index);
    if (!cachedPosition) {
      await showPositions(ctx);
      return;
    }
    let position = cachedPosition;
    let positionsForMerge = getCachedPositions(chatId);
    const tokenId = getPositionTokenId(cachedPosition);

    if (tokenId) {
      try {
        const freshPositions = await refreshPositionsCache(chatId);
        positionsForMerge = freshPositions;
        const freshPosition = freshPositions.find((entry) => getPositionTokenId(entry) === tokenId);
        if (!freshPosition) {
          await showPositions(ctx);
          return;
        }
        position = freshPosition;
      } catch (error) {
        const ctxLog = createContext('bot', 'showPositionDetailsFromCache');
        safeLogWarn(ctxLog, 'Failed to refresh positions before rendering details, using cached snapshot', {
          message: error?.message
        });
      }
    }

    const mergeInfo = resolvePositionMergeInfo(positionsForMerge, position);

    const market = position.market || t('unknown');
    const side = position.outcome || position.side || t('unknown');
    const size = position.size || '0';
    const avgPrice = formatUsdOrNA(position.avgPrice, 4, t);
    const currentValue = formatUsdOrNA(position.currentValue, 2, t);
    const tokenIdForSell = getPositionTokenId(position);
    const language = config.language || 'ru';
    const redeemAvailable = canRedeemPosition(position);
    const sellAvailable = canSellPosition(position);

    let text = `${t('positions_title')}\n\n`;
    text += `${t('market_question')}: ${market}\n`;
    text += `${t('confirm_outcome', { side })}\n`;
    text += `${t('shares')}: ${size}\n`;
    text += `${t('price')}: ${avgPrice}\n`;
    text += `${t('current_value')}: ${currentValue}`;
    if (redeemAvailable) {
      text += `\n${getRedeemActionLabel(language)}: available`;
    }

    const keyboard = new InlineKeyboard();
    if (tokenIdForSell && sellAvailable) {
      keyboard.text(t('sell'), `psell:${index}`).row();
    }
    if (mergeInfo.available) {
      keyboard.text(t('merge'), `pmrg:${index}`).row();
    }
    if (redeemAvailable) {
      keyboard.text(getRedeemActionLabel(language), `pred:${index}`).row();
    }
    keyboard
      .text(t('menu_positions'), 'positions')
      .text(t('back'), 'back_menu');

    await ctx.editMessageText(text, { reply_markup: keyboard });
  }

  async function startSellFromCachedPosition(ctx, index) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    if (Number.isNaN(index) || index < 0) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'positions')
      });
      return;
    }

    const position = getCachedPosition(chatId, index);
    if (!position) {
      await showPositions(ctx);
      return;
    }

    const tokenId = position.token_id ? String(position.token_id).trim() : '';
    if (!tokenId) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'positions')
      });
      return;
    }

    if (!canSellPosition(position)) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), `pos:${index}`).text(t('menu_positions'), 'positions')
      });
      return;
    }

    const slug = getPositionMarketRef(position);
    const side = position.outcome || position.side || t('unknown');
    await startSellFlow(ctx, slug, tokenId, side, {
      conditionId: getPositionConditionId(position)
    });
  }

  async function startMergeFromCachedPosition(ctx, index) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    if (Number.isNaN(index) || index < 0) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'positions')
      });
      return;
    }

    const cachedPosition = getCachedPosition(chatId, index);
    if (!cachedPosition) {
      await showPositions(ctx);
      return;
    }

    let position = cachedPosition;
    let positionsForMerge = getCachedPositions(chatId);
    const sourceTokenIdFromCache = getPositionTokenId(cachedPosition);
    if (sourceTokenIdFromCache) {
      try {
        const freshPositions = await refreshPositionsCache(chatId);
        positionsForMerge = freshPositions;
        const freshPosition = freshPositions.find((entry) => getPositionTokenId(entry) === sourceTokenIdFromCache);
        if (!freshPosition) {
          await showPositions(ctx);
          return;
        }
        position = freshPosition;
      } catch (error) {
        const ctxLog = createContext('bot', 'startMergeFromCachedPosition');
        safeLogWarn(ctxLog, 'Failed to refresh positions before merge flow start, using cached snapshot', {
          message: error?.message
        });
      }
    }

    const conditionId = getPositionConditionId(position);
    if (!conditionId) {
      await ctx.editMessageText(t('error_no_condition_id'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'positions')
      });
      return;
    }

    const mergeInfo = resolvePositionMergeInfo(positionsForMerge, position);
    if (!mergeInfo.available) {
      await ctx.editMessageText(t('error_order_failed', { message: 'Merge is unavailable for this position' }), {
        reply_markup: new InlineKeyboard().text(t('back'), `pos:${index}`).text(t('menu_positions'), 'positions')
      });
      return;
    }

    const slug = getPositionMarketRef(position);
    const sourceTokenId = getPositionTokenId(position);
    userStates.set(chatId, {
      state: 'AWAITING_MERGE_AMOUNT',
      slug,
      conditionId,
      maxMergeBase: mergeInfo.maxMergeBase.toString(),
      sourceTokenId
    });

    const maxMergeLabel = formatSharesFromBase(mergeInfo.maxMergeBase);
    await ctx.editMessageText(
      `${t('enter_amount_merge')}\n\nMax: ${maxMergeLabel} ${t('shares')}`,
      {
        reply_markup: buildMergeAmountKeyboard(t, true)
      }
    );
  }

  async function startRedeemFromCachedPosition(ctx, index) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const language = config.language || 'ru';

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    if (Number.isNaN(index) || index < 0) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'positions')
      });
      return;
    }

    const position = getCachedPosition(chatId, index);
    if (!position) {
      await showPositions(ctx);
      return;
    }

    const conditionId = getPositionConditionId(position);
    if (!conditionId) {
      await ctx.editMessageText(t('error_no_condition_id'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'positions')
      });
      return;
    }

    if (!canRedeemPosition(position)) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), `pos:${index}`).text(t('menu_positions'), 'positions')
      });
      return;
    }

    const market = String(position.market || t('unknown'));
    const side = String(position.outcome || position.side || t('unknown'));
    const sharesBase = parseSharesBaseSafe(position.size ?? position.amount ?? position.quantity ?? 0);
    const redeemLabel = getRedeemActionLabel(language);

    userStates.set(chatId, {
      state: 'CONFIRMING_REDEEM',
      conditionId,
      positionIndex: index
    });

    await ctx.editMessageText(
      `${redeemLabel}\n\n` +
        `${t('market_question')}: ${market}\n` +
        `${t('confirm_outcome', { side })}\n` +
        `${t('shares')}: ${formatSharesFromBase(sharesBase)}\n\n` +
        `${t('confirm')}?`,
      {
        reply_markup: new InlineKeyboard()
          .text(t('confirm'), 'confirm_redeem')
          .text(t('cancel'), 'cancel_confirmation')
      }
    );
  }

  return {
    showPositions,
    showPositionDetailsFromCache,
    startSellFromCachedPosition,
    startMergeFromCachedPosition,
    startRedeemFromCachedPosition
  };
}
