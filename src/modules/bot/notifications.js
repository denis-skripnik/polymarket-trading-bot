import { loadConfig } from '../config.js';
import { getTranslator } from '../i18n.js';
import { formatPriceFromMicro } from '../polymarket.js';

export function createNotificationsFeature(deps) {
  const { sendNotification } = deps;

  function localizeOutcomeLabel(value, t) {
    const raw = String(value ?? '').trim();
    if (!raw) return t('unknown');

    const normalized = raw.toLowerCase();
    if (normalized === 'yes') return t('yes');
    if (normalized === 'no') return t('no');
    return raw;
  }

  function formatStrategyWatcherPriceLabel(value, t) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return t('unknown');
    return numeric.toFixed(4).replace(/\.?0+$/, '');
  }

  function truncateNotificationMarketLabel(value, fallback) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    if (text.length <= 180) return text;
    return `${text.slice(0, 177)}...`;
  }

  function resolveAlertMarketRefForCallback(payload = {}) {
    const candidates = [
      payload.marketId,
      payload.id,
      payload.slug
    ];
    for (const value of candidates) {
      const normalized = String(value ?? '').trim();
      if (normalized) return normalized;
    }
    return '';
  }

  function buildAlertCallbackData(prefix, marketRef) {
    const callback = `${prefix}:${marketRef}`;
    if (callback.length > 64) return null;
    return callback;
  }

  // Send localized price-alert notification (text + buttons).
  // Calculations stay in workers; this function only formats UI.
  async function sendPriceAlertNotification(chatId, payload = {}) {
    if (!chatId) return;

    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');

    const market = String(payload.market ?? payload.marketId ?? t('unknown')).trim() || t('unknown');
    const side = localizeOutcomeLabel(payload.side, t);
    const direction = payload.direction === '-' ? '-' : '+';
    const movePercent = Number(payload.movePercent);
    const moveLabel = Number.isFinite(movePercent)
      ? `${direction}${movePercent.toFixed(2)}%`
      : `${direction}0.00%`;

    let priceLabel = t('unknown');
    try {
      const priceMicro = BigInt(payload.priceMicro?.toString?.() ?? payload.priceMicro);
      if (priceMicro > 0n) {
        priceLabel = formatPriceFromMicro(priceMicro);
      }
    } catch {}

    let referencePriceLabel = t('unknown');
    try {
      const referencePriceMicro = BigInt(payload.referencePriceMicro?.toString?.() ?? payload.referencePriceMicro);
      if (referencePriceMicro > 0n) {
        referencePriceLabel = formatPriceFromMicro(referencePriceMicro);
      }
    } catch {}

    const message =
      `${t('price_alert_title')}: ${market}\n` +
      `${t('price_alert_side')}: ${side}\n` +
      `${t('confirm_best_price', { price: referencePriceLabel })}\n` +
      `${t('price_alert_move')}: ${moveLabel}\n` +
      `${t('price')}: ${priceLabel}`;

    const replyMarkup = {
      inline_keyboard: [[
        { text: t('menu_positions'), callback_data: 'positions' },
        { text: t('menu_orders'), callback_data: 'orders' }
      ]]
    };

    await sendNotification(chatId, message, { reply_markup: replyMarkup });
  }

  // Send strategy-market opportunity notification.
  // Worker performs scanning/filtering; this function only renders Telegram UI.
  async function sendStrategyMarketAlertNotification(chatId, payload = {}) {
    if (!chatId) return;

    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');

    const marketLabel = truncateNotificationMarketLabel(
      payload.market ?? payload.question ?? payload.marketId,
      t('unknown')
    );
    const yesAskLabel = formatStrategyWatcherPriceLabel(payload.yesAsk, t);
    const noAskLabel = formatStrategyWatcherPriceLabel(payload.noAsk, t);
    const sumAskLabel = formatStrategyWatcherPriceLabel(payload.askSum, t);
    const maxAskLabel = formatStrategyWatcherPriceLabel(payload.maxAskPrice, t);
    const slug = String(payload.slug ?? '').trim();
    const marketRef = resolveAlertMarketRefForCallback(payload);

    const message =
      `${t('menu_strategy_markets')}\n` +
      `${t('market_question')}: ${marketLabel}\n` +
      `${t('strategy_markets_filter', { maxAsk: maxAskLabel })}\n` +
      `${t('yes')} ${t('ask')}: ${yesAskLabel}\n` +
      `${t('no')} ${t('ask')}: ${noAskLabel}\n` +
      `YES+NO ${t('ask')}: ${sumAskLabel}`;

    const openCallback = marketRef ? buildAlertCallbackData('smaopen', marketRef) : null;
    const strategyCallback = marketRef ? buildAlertCallbackData('smastr', marketRef) : null;
    const inlineKeyboard = [];

    if (openCallback && strategyCallback) {
      inlineKeyboard.push([
        { text: t('market_details'), callback_data: openCallback },
        { text: t('strategy_start'), callback_data: strategyCallback }
      ]);
    } else if (openCallback) {
      inlineKeyboard.push([{ text: t('market_details'), callback_data: openCallback }]);
    } else {
      inlineKeyboard.push([{ text: t('menu_strategy_markets'), callback_data: 'strategy_markets:1' }]);
    }

    if (slug) {
      inlineKeyboard.push([{ text: 'Polymarket', url: `https://polymarket.com/event/${encodeURIComponent(slug)}` }]);
    }

    await sendNotification(chatId, message, {
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  }

  return {
    sendPriceAlertNotification,
    sendStrategyMarketAlertNotification
  };
}
