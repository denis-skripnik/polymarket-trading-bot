import { InlineKeyboard } from 'grammy';
import { loadConfig, updateConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { userStates } from '../runtime.js';
import { CATEGORY_ALL_KEY } from '../constants.js';

export function createSettingsFeature(deps) {
  const {
    resolveStrategyMaxAskPrice,
    resolveNotificationAlertCooldownSeconds,
    formatSignedPercentValue,
    formatStrategyAskPrice,
    formatPlainNumber,
    parsePercentInput,
    parsePositiveNumberInput,
    parseUnitIntervalInput,
    parseNonNegativeIntegerInput,
    parseEventsFilterRangeInput,
    getEventsPriceFilter,
    setEventsPriceFilter,
    formatEventsPriceFilterLabel,
    buildEventsFilterCallback,
    buildEventsListCallback,
    showEventsListByCategoryToken,
    createMessageEditContext,
    createContext,
    safeLogWarn
  } = deps;

  // Show settings
  async function showSettings(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;

    const walletStatus = config.walletAddress ? config.walletAddress : t('not_configured');
    const languageDisplay = config.language === 'en' ? '🇬🇧 English' : '🇷🇺 Русский';
    const stopLoss = Number(config?.strategies?.stopLoss ?? -10);
    const takeProfit = Number(config?.strategies?.takeProfit ?? 30);
    const maxAskPrice = resolveStrategyMaxAskPrice(config);
    const priceChangePercent = Number(config?.notifications?.priceChangePercent ?? 10);
    const priceRepeatStepPercent = Number(config?.notifications?.priceRepeatStepPercent ?? 2);
    const alertCooldownSeconds = resolveNotificationAlertCooldownSeconds(config);
    const backupWarningLine = config.walletAddress ? `${t('settings_backup_warning')}\n` : '';

    const text =
      `${t('settings_title')}\n\n` +
      `${t('settings_wallet')}: ${walletStatus}\n` +
      backupWarningLine +
      `${t('settings_language')}: ${languageDisplay}\n` +
      `${t('settings_strategy_stop_loss')}: ${formatSignedPercentValue(stopLoss)}%\n` +
      `${t('settings_strategy_take_profit')}: ${formatSignedPercentValue(takeProfit)}%\n` +
      `${t('settings_strategy_max_ask')}: ${formatStrategyAskPrice(maxAskPrice)}\n` +
      `${t('settings_notifications_price_change')}: ${formatPlainNumber(priceChangePercent)}%\n` +
      `${t('settings_notifications_repeat_step')}: ${formatPlainNumber(priceRepeatStepPercent)}%\n` +
      `${t('settings_notifications_cooldown')}: ${formatPlainNumber(alertCooldownSeconds)}s`;

    const currentState = userStates.get(chatId);
    if (
      currentState?.state === 'AWAITING_STRATEGY_STOP_LOSS' ||
      currentState?.state === 'AWAITING_STRATEGY_TAKE_PROFIT' ||
      currentState?.state === 'AWAITING_STRATEGY_MAX_ASK_PRICE' ||
      currentState?.state === 'AWAITING_NOTIFICATION_PRICE_CHANGE' ||
      currentState?.state === 'AWAITING_NOTIFICATION_REPEAT_STEP' ||
      currentState?.state === 'AWAITING_NOTIFICATION_COOLDOWN'
    ) {
      userStates.delete(chatId);
    }

    const keyboard = new InlineKeyboard();
    keyboard.text(t('settings_language'), 'change_language').row();
    keyboard.text(t('settings_strategy'), 'settings_strategy').row();
    keyboard.text(t('settings_notifications'), 'settings_notifications').row();

    if (!config.walletAddress) {
      keyboard.text(t('settings_init_wallet'), 'init_wallet').row();
    } else {
      keyboard.text(t('settings_set_allowances'), 'set_allowances').row();
      keyboard.text(t('settings_collateral_status'), 'collateral_status').row();
      keyboard.text(t('settings_export_pk'), 'start_export_pk').row();
      keyboard.text(t('settings_withdraw'), 'start_withdraw').row();
    }

    keyboard.text(t('back'), 'back_menu');
    await ctx.editMessageText(text, { reply_markup: keyboard });
  }

  async function showStrategySettings(ctx, useEdit = true) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const stopLoss = Number(config?.strategies?.stopLoss ?? -10);
    const takeProfit = Number(config?.strategies?.takeProfit ?? 30);
    const maxAskPrice = resolveStrategyMaxAskPrice(config);

    const currentState = userStates.get(chatId);
    if (
      currentState?.state === 'AWAITING_STRATEGY_STOP_LOSS' ||
      currentState?.state === 'AWAITING_STRATEGY_TAKE_PROFIT' ||
      currentState?.state === 'AWAITING_STRATEGY_MAX_ASK_PRICE'
    ) {
      userStates.delete(chatId);
    }

    const text =
      `${t('settings_strategy_title')}\n\n` +
      `${t('settings_strategy_stop_loss')}: ${formatSignedPercentValue(stopLoss)}%\n` +
      `${t('settings_strategy_take_profit')}: ${formatSignedPercentValue(takeProfit)}%\n` +
      `${t('settings_strategy_max_ask')}: ${formatStrategyAskPrice(maxAskPrice)}`;

    const keyboard = new InlineKeyboard()
      .text(t('settings_strategy_edit_stop_loss'), 'settings_strategy_stop_loss')
      .row()
      .text(t('settings_strategy_edit_take_profit'), 'settings_strategy_take_profit')
      .row()
      .text(t('settings_strategy_edit_max_ask'), 'settings_strategy_max_ask')
      .row()
      .text(t('back'), 'settings');

    if (useEdit && ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } else {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  }

  async function showNotificationSettings(ctx, useEdit = true) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const priceChangePercent = Number(config?.notifications?.priceChangePercent ?? 10);
    const priceRepeatStepPercent = Number(config?.notifications?.priceRepeatStepPercent ?? 2);
    const alertCooldownSeconds = resolveNotificationAlertCooldownSeconds(config);

    const currentState = userStates.get(chatId);
    if (
      currentState?.state === 'AWAITING_NOTIFICATION_PRICE_CHANGE' ||
      currentState?.state === 'AWAITING_NOTIFICATION_REPEAT_STEP' ||
      currentState?.state === 'AWAITING_NOTIFICATION_COOLDOWN'
    ) {
      userStates.delete(chatId);
    }

    const text =
      `${t('settings_notifications_title')}\n\n` +
      `${t('settings_notifications_price_change')}: ${formatPlainNumber(priceChangePercent)}%\n` +
      `${t('settings_notifications_repeat_step')}: ${formatPlainNumber(priceRepeatStepPercent)}%\n` +
      `${t('settings_notifications_cooldown')}: ${formatPlainNumber(alertCooldownSeconds)}s`;

    const keyboard = new InlineKeyboard()
      .text(t('settings_notifications_edit_price_change'), 'settings_notifications_price_change')
      .row()
      .text(t('settings_notifications_edit_repeat_step'), 'settings_notifications_repeat_step')
      .row()
      .text(t('settings_notifications_edit_cooldown'), 'settings_notifications_cooldown')
      .row()
      .text(t('back'), 'settings');

    if (useEdit && ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } else {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  }

  async function startStrategySettingsEdit(ctx, field) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const isStopLoss = field === 'stopLoss';
    const isTakeProfit = field === 'takeProfit';
    const isMaxAskPrice = field === 'maxAskPrice';
    if (!isStopLoss && !isTakeProfit && !isMaxAskPrice) {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings_strategy')
      });
      return;
    }

    if (isStopLoss) {
      const current = Number(config?.strategies?.stopLoss ?? -10);
      userStates.set(chatId, { state: 'AWAITING_STRATEGY_STOP_LOSS' });
      await ctx.editMessageText(
        t('settings_strategy_prompt_stop_loss', { current: `${formatSignedPercentValue(current)}%` }),
        { reply_markup: new InlineKeyboard().text(t('back'), 'settings_strategy') }
      );
      return;
    }

    if (isTakeProfit) {
      const current = Number(config?.strategies?.takeProfit ?? 30);
      userStates.set(chatId, { state: 'AWAITING_STRATEGY_TAKE_PROFIT' });
      await ctx.editMessageText(
        t('settings_strategy_prompt_take_profit', { current: `${formatSignedPercentValue(current)}%` }),
        { reply_markup: new InlineKeyboard().text(t('back'), 'settings_strategy') }
      );
      return;
    }

    const current = resolveStrategyMaxAskPrice(config);
    userStates.set(chatId, { state: 'AWAITING_STRATEGY_MAX_ASK_PRICE' });
    await ctx.editMessageText(
      t('settings_strategy_prompt_max_ask', { current: formatStrategyAskPrice(current) }),
      {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings_strategy')
      }
    );
  }

  async function handleStrategySettingsInput(ctx, state, text) {
    const t = await getTranslator((await loadConfig()).language || 'ru');
    const chatId = ctx.chat.id;
    const mode = state.state;

    if (mode === 'AWAITING_STRATEGY_STOP_LOSS') {
      const value = parsePercentInput(text);
      if (value === null || value >= 0 || value < -99) {
        await ctx.reply(t('settings_strategy_invalid_stop_loss'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'settings_strategy')
        });
        return;
      }
      await updateConfig('strategies.stopLoss', value);
      userStates.delete(chatId);
      await ctx.reply(t('settings_strategy_saved', {
        field: t('settings_strategy_stop_loss'),
        value: `${formatSignedPercentValue(value)}%`
      }));
      await showStrategySettings(ctx, false);
      return;
    }

    if (mode === 'AWAITING_STRATEGY_TAKE_PROFIT') {
      const value = parsePercentInput(text);
      if (value === null || value <= 0 || value > 900) {
        await ctx.reply(t('settings_strategy_invalid_take_profit'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'settings_strategy')
        });
        return;
      }
      await updateConfig('strategies.takeProfit', value);
      userStates.delete(chatId);
      await ctx.reply(t('settings_strategy_saved', {
        field: t('settings_strategy_take_profit'),
        value: `${formatSignedPercentValue(value)}%`
      }));
      await showStrategySettings(ctx, false);
      return;
    }

    if (mode !== 'AWAITING_STRATEGY_MAX_ASK_PRICE') {
      await ctx.reply(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings_strategy')
      });
      return;
    }

    const value = parseUnitIntervalInput(text, 4);
    if (value === null || value < 0.01 || value > 0.99) {
      await ctx.reply(t('settings_strategy_invalid_max_ask'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings_strategy')
      });
      return;
    }

    await updateConfig('strategies.maxAskPrice', Number(value.toFixed(4)));
    userStates.delete(chatId);
    await ctx.reply(t('settings_strategy_saved', {
      field: t('settings_strategy_max_ask'),
      value: formatStrategyAskPrice(value)
    }));
    await showStrategySettings(ctx, false);
  }

  async function startNotificationSettingsEdit(ctx, field) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const isPriceChange = field === 'priceChangePercent';
    const isRepeatStep = field === 'priceRepeatStepPercent';
    const current = isPriceChange
      ? Number(config?.notifications?.priceChangePercent ?? 10)
      : isRepeatStep
        ? Number(config?.notifications?.priceRepeatStepPercent ?? 2)
        : resolveNotificationAlertCooldownSeconds(config);

    userStates.set(chatId, {
      state: isPriceChange
        ? 'AWAITING_NOTIFICATION_PRICE_CHANGE'
        : isRepeatStep
          ? 'AWAITING_NOTIFICATION_REPEAT_STEP'
          : 'AWAITING_NOTIFICATION_COOLDOWN'
    });

    const prompt = isPriceChange
      ? t('settings_notifications_prompt_price_change', { current: `${formatPlainNumber(current)}%` })
      : isRepeatStep
        ? t('settings_notifications_prompt_repeat_step', { current: `${formatPlainNumber(current)}%` })
        : t('settings_notifications_prompt_cooldown', { current: `${formatPlainNumber(current)}s` });

    await ctx.editMessageText(prompt, {
      reply_markup: new InlineKeyboard().text(t('back'), 'settings_notifications')
    });
  }

  async function handleNotificationSettingsInput(ctx, state, text) {
    const t = await getTranslator((await loadConfig()).language || 'ru');
    const chatId = ctx.chat.id;
    const isPriceChange = state.state === 'AWAITING_NOTIFICATION_PRICE_CHANGE';
    const isRepeatStep = state.state === 'AWAITING_NOTIFICATION_REPEAT_STEP';
    const isCooldown = state.state === 'AWAITING_NOTIFICATION_COOLDOWN';

    const parsed = (isPriceChange || isRepeatStep)
      ? parsePositiveNumberInput(text)
      : parseNonNegativeIntegerInput(text);
    if (parsed === null) {
      const invalidMessage = isPriceChange
        ? t('settings_notifications_invalid_price_change')
        : isRepeatStep
          ? t('settings_notifications_invalid_repeat_step')
          : t('settings_notifications_invalid_cooldown');
      await ctx.reply(
        invalidMessage,
        { reply_markup: new InlineKeyboard().text(t('back'), 'settings_notifications') }
      );
      return;
    }

    if ((isPriceChange || isRepeatStep) && (parsed < 0.01 || parsed > 500)) {
      const invalidMessage = isPriceChange
        ? t('settings_notifications_invalid_price_change')
        : t('settings_notifications_invalid_repeat_step');
      await ctx.reply(invalidMessage, {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings_notifications')
      });
      return;
    }

    if (isCooldown && (parsed < 0 || parsed > 86400)) {
      await ctx.reply(t('settings_notifications_invalid_cooldown'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings_notifications')
      });
      return;
    }

    const fieldPath = isPriceChange
      ? 'notifications.priceChangePercent'
      : isRepeatStep
        ? 'notifications.priceRepeatStepPercent'
        : 'notifications.alertCooldownSeconds';
    await updateConfig(fieldPath, parsed);
    userStates.delete(chatId);

    const fieldLabel = isPriceChange
      ? t('settings_notifications_price_change')
      : isRepeatStep
        ? t('settings_notifications_repeat_step')
        : t('settings_notifications_cooldown');
    const valueLabel = (isPriceChange || isRepeatStep)
      ? `${formatPlainNumber(parsed)}%`
      : `${formatPlainNumber(parsed)}s`;
    await ctx.reply(t('settings_notifications_saved', { field: fieldLabel, value: valueLabel }));
    await showNotificationSettings(ctx, false);
  }

  async function handleEventsFilterRangeInput(ctx, state, text) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const categoryToken = state?.categoryToken || CATEGORY_ALL_KEY;
    const eventsPage = Number.isFinite(state?.eventsPage) && state.eventsPage > 0
      ? Math.floor(state.eventsPage)
      : 1;

    const parsed = parseEventsFilterRangeInput(text);
    if (!parsed) {
      await ctx.reply(t('events_filter_invalid'), {
        reply_markup: new InlineKeyboard().text(t('back'), buildEventsFilterCallback(categoryToken, eventsPage))
      });
      return;
    }

    setEventsPriceFilter(chatId, {
      enabled: true,
      min: parsed.min,
      max: parsed.max
    });
    userStates.delete(chatId);

    const filterLabel = formatEventsPriceFilterLabel(getEventsPriceFilter(chatId), t);
    await ctx.reply(t('events_filter_applied', { value: filterLabel }));

    const originMessageId = Number.isFinite(state?.originMessageId)
      ? Number(state.originMessageId)
      : null;

    if (!originMessageId) {
      await ctx.reply(t('events_filter_return_hint'), {
        reply_markup: new InlineKeyboard().text(t('back'), buildEventsListCallback(categoryToken, eventsPage))
      });
      return;
    }

    try {
      const editCtx = createMessageEditContext(chatId, originMessageId);
      await showEventsListByCategoryToken(editCtx, categoryToken, eventsPage);
    } catch (error) {
      const ctxLog = createContext('bot', 'handleEventsFilterRangeInput');
      safeLogWarn(ctxLog, 'Failed to reopen events list after filter input', {
        message: error?.message
      });
      await ctx.reply(t('events_filter_return_hint'), {
        reply_markup: new InlineKeyboard().text(t('back'), buildEventsListCallback(categoryToken, eventsPage))
      });
    }
  }

  return {
    showSettings,
    showStrategySettings,
    showNotificationSettings,
    startStrategySettingsEdit,
    handleStrategySettingsInput,
    startNotificationSettingsEdit,
    handleNotificationSettingsInput,
    handleEventsFilterRangeInput
  };
}
