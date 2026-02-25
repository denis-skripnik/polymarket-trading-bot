import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getOrders, cancelOrder, mapErrorToUserMessage } from '../../polymarket.js';
import { busyLocks, userStates } from '../runtime.js';

export function createOrdersFeature(deps) {
  const {
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
  } = deps;

  async function showOrders(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    
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
      
      // Get orders from API
      const orders = await getOrders();
      
      if (!orders || orders.length === 0) {
        await ctx.editMessageText(t('error_no_orders'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
        });
        return;
      }
      
      const cacheKey = `orders:${chatId}`;
      userStates.set(cacheKey, { orders, timestamp: Date.now() });

      let text = t('orders_title') + '\n\n';
      const keyboard = new InlineKeyboard();
      const resolverCache = {
        byTokenId: new Map(),
        byConditionId: new Map(),
        byMarketRef: new Map()
      };

      for (let index = 0; index < orders.length; index += 1) {
        const order = orders[index];
        const market = await resolveOrderMarketDisplay(order, t, resolverCache);
        const side = getOrderSideText(order.side, t);
        const status = order.status || t('unknown');
        const statusText = getOrderStatusText(status, t);
        const orderId = extractOrderId(order);
        const shortOrderId = orderId ? shortenHexLike(orderId) : '';

        const priceNumber = Number(order.price);
        const price = formatOrderPriceDisplay(priceNumber, t);

        const remainingBase = resolveOrderSizeBase(order, ['remaining_size', 'remainingSize', 'amount', 'size']);
        const originalBase = resolveOrderSizeBase(order, ['original_size', 'originalSize', 'size', 'amount']);
        let filledBase = resolveOrderSizeBase(order, ['filled_size', 'filledSize', 'size_matched', 'filled']);
        if (filledBase <= 0n && originalBase > remainingBase) {
          filledBase = originalBase - remainingBase;
        }

        text += `${index + 1}. ${market}\n`;
        text += `   ${side}: ${price}  |  ${t('status')}: ${statusText}\n`;
        text += `   ${t('order_remaining')}: ${formatOrderRemainingWithNotional(remainingBase, priceNumber, t)}\n`;
        if (filledBase > 0n) {
          text += `   ${t('order_filled')}: ${formatSharesCompact(filledBase)} ${t('shares')}\n`;
        }
        if (orderId) {
          text += `   ID: ${shortOrderId}\n`;
        }
        text += '\n';

        keyboard.text(`${index + 1}`, `od:${index}`);
        if ((index + 1) % 4 === 0) {
          keyboard.row();
        }
      }
      keyboard.row();
      keyboard.text(t('refresh'), 'orders');
      keyboard.text(t('back'), 'back_menu');

      await ctx.editMessageText(text, {
        reply_markup: keyboard
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'showOrders');
      safeLogError(ctxLog, error);
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('try_again'), 'orders').text(t('back'), 'back_menu')
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function showOrderDetailsFromCache(ctx, index) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    if (Number.isNaN(index) || index < 0) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'orders')
      });
      return;
    }

    const order = getCachedOrder(chatId, index);
    if (!order) {
      await showOrders(ctx);
      return;
    }

    const market = await resolveOrderMarketDisplay(order, t, {
      byTokenId: new Map(),
      byConditionId: new Map(),
      byMarketRef: new Map()
    });
    const side = getOrderSideText(order.side, t);
    const status = order.status || t('unknown');
    const statusText = getOrderStatusText(status, t);
    const orderId = extractOrderId(order);

    const priceNumber = Number(order.price);
    const price = formatOrderPriceDisplay(priceNumber, t);

    const remainingBase = resolveOrderSizeBase(order, ['remaining_size', 'remainingSize', 'amount', 'size']);
    const originalBase = resolveOrderSizeBase(order, ['original_size', 'originalSize', 'size', 'amount']);
    let filledBase = resolveOrderSizeBase(order, ['filled_size', 'filledSize', 'size_matched', 'filled']);
    if (filledBase <= 0n && originalBase > remainingBase) {
      filledBase = originalBase - remainingBase;
    }

    let text = `${t('orders_title')}\n\n`;
    text += `${t('market_question')}: ${market}\n`;
    text += `${side}: ${price}\n`;
    text += `${t('order_remaining')}: ${formatOrderRemainingWithNotional(remainingBase, priceNumber, t)}\n`;
    if (filledBase > 0n) {
      text += `${t('order_filled')}: ${formatSharesCompact(filledBase)} ${t('shares')}\n`;
    }
    text += `${t('status')}: ${statusText}\n`;
    if (orderId) {
      text += `ID: ${orderId}\n`;
    }

    const keyboard = new InlineKeyboard();
    if (orderId && isOrderCancellableStatus(status)) {
      keyboard.text(t('order_cancel'), `oc:${index}`).row();
    }
    keyboard
      .text(t('refresh'), 'orders')
      .text(t('back'), 'orders');

    await ctx.editMessageText(text, { reply_markup: keyboard });
  }

  async function cancelCachedOrder(ctx, index) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    if (Number.isNaN(index) || index < 0) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'orders')
      });
      return;
    }

    const order = getCachedOrder(chatId, index);
    if (!order) {
      await showOrders(ctx);
      return;
    }

    const orderId = extractOrderId(order);
    if (!orderId) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'orders')
      });
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await ctx.editMessageText(t('loading'));
      await ensureClientInitialized();
      await cancelOrder(orderId);
      try {
        await updateOrderStatus(orderId, 'cancelled');
      } catch {}

      await ctx.editMessageText(t('order_cancelled', { orderId }), {
        reply_markup: new InlineKeyboard().text(t('back'), 'orders').text(t('menu_orders'), 'orders')
      });
    } catch (error) {
      const ctxLog = createContext('bot', 'cancelCachedOrder');
      safeLogError(ctxLog, error, { orderId });
      const errorInfo = mapErrorToUserMessage(error);
      await ctx.editMessageText(t(errorInfo.key, errorInfo.params), {
        reply_markup: new InlineKeyboard().text(t('try_again'), `oc:${index}`).text(t('back'), 'orders')
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  return {
    showOrders,
    showOrderDetailsFromCache,
    cancelCachedOrder
  };
}
