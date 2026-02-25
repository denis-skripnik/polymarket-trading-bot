import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getMarkets } from '../../polymarket.js';
import { userStates } from '../runtime.js';
import { STRATEGY_MARKETS_PAGE_SIZE } from '../constants.js';

export function createMarketsFeature(deps) {
  const {
    sortByLiquidityDesc,
    translateUiLabelsForLanguage,
    truncateButtonLabel,
    createContext,
    safeLogError,
    resolveStrategyMaxAskPrice,
    loadStrategyMarkets,
    formatStrategyAskPrice,
    loadCategoryCatalog,
    getEventsPriceFilter,
    formatEventsPriceFilterLabel,
    buildEventsFilterPresetCallback,
    buildEventsFilterCustomCallback,
    buildEventsListCallback,
    loadEventsPageWithPriceFilter,
    buildEventsFilterCallback,
    buildEventDetailsCallback,
    getCachedCategoryContext,
    createMessageEditContext,
    showMarketDetails,
    showEventDetails,
    CATEGORY_ALL_KEY
  } = deps;

  // Show markets list - does NOT require initialized clobClient
  async function showMarketsList(ctx, page = 1) {
    const config = await loadConfig();
    const language = config.language || 'ru';
    const t = await getTranslator(language);
    const chatId = ctx.chat.id;
    
    await ctx.editMessageText(t('loading'));
    
    try {
      // getMarkets now works without initialized clobClient (uses Gamma API)
      const marketsRaw = await getMarkets(null, page, 8);
      const markets = sortByLiquidityDesc(marketsRaw);
      if (!markets || markets.length === 0) {
        await ctx.editMessageText(t('no_markets'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
        });
        return;
      }
      
      // Cache markets for this chat+page to resolve short callback tokens later
      const cacheKey = `markets:${chatId}:${page}`;
      userStates.set(cacheKey, { markets, timestamp: Date.now() });

      const marketQuestions = markets.map((market) => market.question || market.title || t('unknown'));
      const translatedQuestions = await translateUiLabelsForLanguage(
        language,
        marketQuestions,
        'markets list'
      );
      
      let text = t('markets_title', { page }) + '\n\n';
      const keyboard = new InlineKeyboard();
      
      markets.forEach((market, index) => {
        const question = translatedQuestions[index] || t('unknown');
        const volume = market.volume ? `$${(market.volume / 1e6).toFixed(2)}M` : t('na');
        const shortQuestion = truncateButtonLabel(question) || t('unknown');
        text += `- ${shortQuestion}\n  ${t('volume_short')}: ${volume}\n\n`;
        // Use short callback token: msel:<page>:<idx> for market selection
        keyboard.text(shortQuestion, `msel:${page}:${index}`).row();
      });
      
      if (page > 1) {
        keyboard.text(t('prev'), `markets:${page - 1}`);
      }
      keyboard.text(t('next'), `markets:${page + 1}`);
      keyboard.row();
      keyboard.text(t('back'), 'back_menu');
      
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const ctxLog = createContext('bot', 'showMarketsList');
      safeLogError(ctxLog, error, { page });
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('try_again'), `markets:${page}`).text(t('back'), 'back_menu')
      });
    }
  }

  async function showStrategyMarketsList(ctx, page = 1, forceRefresh = false) {
    const config = await loadConfig();
    const language = config.language || 'ru';
    const t = await getTranslator(language);
    const chatId = ctx.chat.id;
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;

    if (!config.walletAddress) {
      await ctx.editMessageText(t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
      });
      return;
    }

    await ctx.editMessageText(t('loading'));

    try {
      const maxAskPrice = resolveStrategyMaxAskPrice(config);
      const data = await loadStrategyMarkets(chatId, t, maxAskPrice, forceRefresh);
      const items = Array.isArray(data?.items) ? data.items : [];
      const totalPages = Math.max(1, Math.ceil(items.length / STRATEGY_MARKETS_PAGE_SIZE));
      const normalizedPage = Math.min(safePage, totalPages);
      const startIndex = (normalizedPage - 1) * STRATEGY_MARKETS_PAGE_SIZE;
      const pageItems = items.slice(startIndex, startIndex + STRATEGY_MARKETS_PAGE_SIZE);

      const keyboard = new InlineKeyboard();

      if (items.length === 0) {
        const text =
          `${t('strategy_markets_title', { page: 1 })}\n\n` +
          t('strategy_markets_empty', { maxAsk: formatStrategyAskPrice(maxAskPrice) });

        keyboard
          .text(t('refresh'), 'smrefresh:1')
          .row()
          .text(t('back'), 'back_menu');

        await ctx.editMessageText(text, { reply_markup: keyboard });
        return;
      }

      let text =
        `${t('strategy_markets_title', { page: normalizedPage })}\n` +
        `${t('strategy_markets_filter', { maxAsk: formatStrategyAskPrice(maxAskPrice) })}\n\n`;

      for (let i = 0; i < pageItems.length; i += 1) {
        const item = pageItems[i];
        const market = item.market;
        const question = market?.question || market?.title || t('unknown');
        const buttonTitle = truncateButtonLabel(question) || t('unknown');
        const volumeValue = Number(market?.volume ?? 0);
        const volumeLabel = Number.isFinite(volumeValue) && volumeValue > 0
          ? `$${(volumeValue / 1e6).toFixed(2)}M`
          : t('na');
        const yesAsk = formatStrategyAskPrice(item.yesAsk);
        const noAsk = formatStrategyAskPrice(item.noAsk);

        text +=
          `${i + 1}. ${buttonTitle}\n` +
          `   ${t('yes')} ${t('ask')}: ${yesAsk} | ${t('no')} ${t('ask')}: ${noAsk}\n` +
          `   ${t('volume_short')}: ${volumeLabel}\n\n`;

        keyboard.text(buttonTitle, `smopen:${normalizedPage}:${i}`).row();
      }

      if (normalizedPage > 1) {
        keyboard.text(t('prev'), `strategy_markets:${normalizedPage - 1}`);
      }
      if (normalizedPage < totalPages) {
        keyboard.text(t('next'), `strategy_markets:${normalizedPage + 1}`);
      }
      if (normalizedPage > 1 || normalizedPage < totalPages) {
        keyboard.row();
      }

      keyboard
        .text(t('refresh'), `smrefresh:${normalizedPage}`)
        .row()
        .text(t('back'), 'back_menu');

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const ctxLog = createContext('bot', 'showStrategyMarketsList');
      safeLogError(ctxLog, error, { page: safePage, forceRefresh });
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard()
          .text(t('try_again'), `smrefresh:${safePage}`)
          .text(t('back'), 'back_menu')
      });
    }
  }

  async function showMarketCategoriesList(ctx, page = 1) {
    const config = await loadConfig();
    const language = config.language || 'ru';
    const t = await getTranslator(language);
    const chatId = ctx.chat.id;
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;

    await ctx.editMessageText(t('loading'));

    try {
      const limit = 12;
      const categories = await loadCategoryCatalog(t, language);
      const offset = (safePage - 1) * limit;
      const pageCategories = categories.slice(offset, offset + limit);

      if (!pageCategories.length) {
        await ctx.editMessageText(t('no_categories'), {
          reply_markup: new InlineKeyboard().text(t('back'), 'back_menu')
        });
        return;
      }

      const cacheKey = `categories:${chatId}:${safePage}`;
      userStates.set(cacheKey, { categories: pageCategories, timestamp: Date.now() });

      const translatedCategoryNames = await translateUiLabelsForLanguage(
        language,
        pageCategories.map((category) => category.displayName || t('unknown')),
        'market category labels'
      );

      let text = t('categories_title', { page: safePage }) + '\n\n';
      const keyboard = new InlineKeyboard();

      pageCategories.forEach((category, index) => {
        const displayName = translatedCategoryNames[index] || category.displayName || t('unknown');
        const shortCategory = truncateButtonLabel(displayName) || t('unknown');
        text += `- ${shortCategory}\n`;
        keyboard.text(shortCategory, `cat:${safePage}:${index}`).row();
      });

      if (safePage > 1) {
        keyboard.text(t('prev'), `markets:${safePage - 1}`);
      }
      if (offset + limit < categories.length) {
        keyboard.text(t('next'), `markets:${safePage + 1}`);
      }
      keyboard.row();
      keyboard.text(t('back'), 'back_menu');

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const ctxLog = createContext('bot', 'showMarketCategoriesList');
      safeLogError(ctxLog, error, { page: safePage });
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('try_again'), `markets:${safePage}`).text(t('back'), 'back_menu')
      });
    }
  }

  async function showEventsFilterMenu(ctx, nav = {}) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'ru');
    const chatId = ctx.chat.id;
    const categoryToken = nav.categoryToken || CATEGORY_ALL_KEY;
    const eventsPage = Number.isFinite(nav.eventsPage) && nav.eventsPage > 0 ? Math.floor(nav.eventsPage) : 1;
    const activeFilter = getEventsPriceFilter(chatId);

    const text =
      `${t('events_filter_title')}\n\n` +
      `${t('events_filter_current', { value: formatEventsPriceFilterLabel(activeFilter, t) })}\n` +
      `${t('events_filter_hint')}`;

    const keyboard = new InlineKeyboard()
      .text(t('events_filter_preset_off'), buildEventsFilterPresetCallback(categoryToken, eventsPage, 'off'))
      .row()
      .text(t('events_filter_preset_10_90'), buildEventsFilterPresetCallback(categoryToken, eventsPage, '10_90'))
      .text(t('events_filter_preset_15_85'), buildEventsFilterPresetCallback(categoryToken, eventsPage, '15_85'))
      .row()
      .text(t('events_filter_custom'), buildEventsFilterCustomCallback(categoryToken, eventsPage))
      .row()
      .text(t('back'), buildEventsListCallback(categoryToken, eventsPage));

    await ctx.editMessageText(text, { reply_markup: keyboard });
  }

  // Show events list - displays unique events filtered by selected category.
  async function showEventsList(ctx, options = {}) {
    const config = await loadConfig();
    const language = config.language || 'ru';
    const t = await getTranslator(language);
    const chatId = ctx.chat.id;

    const normalizedOptions = typeof options === 'number' ? { page: options } : options || {};
    const category = normalizedOptions.category || {
      key: CATEGORY_ALL_KEY,
      filterValue: null,
      displayName: t('category_all')
    };
    const categoryToken = normalizedOptions.categoryToken || CATEGORY_ALL_KEY;
    const categoriesPage = normalizedOptions.categoriesPage || 1;
    const page = normalizedOptions.page || 1;

    await ctx.editMessageText(t('loading'));

    try {
      const activeFilter = getEventsPriceFilter(chatId);
      const { events, hasMore } = await loadEventsPageWithPriceFilter({
        chatId,
        categoryToken,
        page,
        categoryFilter: category.filterValue,
        filter: activeFilter
      });
      const eventsList = Array.isArray(events) ? events : [];

      const cacheKey = `events:${chatId}:${categoryToken}:${page}`;
      userStates.set(cacheKey, { events: eventsList, category, categoriesPage, timestamp: Date.now() });
      userStates.set(`categoryCtx:${chatId}:${categoryToken}`, { category, categoriesPage, timestamp: Date.now() });

      const categoryLabelRaw = category.displayName || t('category_all');
      const eventTitlesRaw = eventsList.map((event) => event.title || t('unknown'));
      const translatedEventsList = await translateUiLabelsForLanguage(
        language,
        [categoryLabelRaw, ...eventTitlesRaw],
        'selected category and event titles list'
      );
      const selectedCategoryLabel = translatedEventsList[0] || categoryLabelRaw;
      const translatedEventTitles = eventTitlesRaw.map((title, index) => (
        translatedEventsList[index + 1] || title
      ));

      let text = t('events_title', { page }) + '\n';
      text += `${t('events_filter_status', { value: formatEventsPriceFilterLabel(activeFilter, t) })}\n`;
      text += `${t('selected_category')}: ${selectedCategoryLabel || category.displayName}\n\n`;
      const keyboard = new InlineKeyboard();

      eventsList.forEach((event, index) => {
        const title = translatedEventTitles[index] || event.title || t('unknown');
        const marketCount = event.markets?.length || 0;
        const shortTitle = truncateButtonLabel(title) || t('unknown');
        text += `- ${shortTitle}\n  ${t('markets_count')}: ${marketCount}\n\n`;
        keyboard.text(shortTitle, `evt:${categoryToken}:${page}:${index}`).row();
      });

      if (!eventsList.length) {
        text += `${t('no_events')}\n`;
      }

      if (page > 1) {
        keyboard.text(t('prev'), buildEventsListCallback(categoryToken, page - 1));
      }
      if (hasMore) {
        keyboard.text(t('next'), buildEventsListCallback(categoryToken, page + 1));
      }
      if (page > 1 || hasMore) {
        keyboard.row();
      }
      keyboard.text(t('events_filter_button'), buildEventsFilterCallback(categoryToken, page)).row();
      keyboard.text(t('back'), `markets:${categoriesPage}`);

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const ctxLog = createContext('bot', 'showEventsList');
      safeLogError(ctxLog, error, {
        page,
        categoryToken,
        categoryFilter: category?.filterValue
      });
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard()
          .text(t('try_again'), buildEventsListCallback(categoryToken, page))
          .text(t('back'), `markets:${categoriesPage}`)
      });
    }
  }

  async function showEventsListByCategoryToken(ctx, categoryToken, eventsPage) {
    const chatId = ctx.chat.id;
    const categoryContext = getCachedCategoryContext(chatId, categoryToken);
    if (!categoryContext) {
      await showMarketCategoriesList(ctx, 1);
      return false;
    }

    await showEventsList(ctx, {
      category: categoryContext.category,
      categoryToken,
      categoriesPage: categoryContext.categoriesPage,
      page: eventsPage
    });
    return true;
  }

  function parsePolymarketEventUrl(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;

    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }

    const host = String(parsed.hostname || '').trim().toLowerCase().replace(/^www\./, '');
    if (host !== 'polymarket.com') return null;

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    let eventIndex = 0;
    if (String(parts[0]).toLowerCase() === 'event') {
      eventIndex = 0;
    } else {
      const localePrefix = String(parts[0] || '').trim();
      const hasLocalePrefix = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(localePrefix);
      if (!hasLocalePrefix || parts.length < 3 || String(parts[1]).toLowerCase() !== 'event') {
        return null;
      }
      eventIndex = 1;
    }

    const decodeSafe = (value) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };

    const eventSlug = String(decodeSafe(parts[eventIndex + 1]) || '').trim();
    const marketSlug = parts.length >= eventIndex + 3
      ? String(decodeSafe(parts[eventIndex + 2]) || '').trim()
      : '';
    if (!eventSlug) return null;

    return {
      eventSlug,
      marketSlug: marketSlug || null
    };
  }

  async function handlePolymarketEventUrlInput(ctx, parsedUrl, t) {
    if (!parsedUrl || !parsedUrl.eventSlug) return false;

    const chatId = ctx.chat.id;
    // showEventDetails/showMarketDetails start by editing message to `loading`.
    // Seed with a different placeholder to avoid Telegram "message is not modified".
    const loadingMessage = await ctx.reply('...');
    const editCtx = createMessageEditContext(chatId, loadingMessage.message_id);

    if (parsedUrl.marketSlug) {
      await showMarketDetails(editCtx, parsedUrl.marketSlug, {
        backCallback: 'back_menu',
        retryCallback: 'markets:1'
      });
      return true;
    }

    await showEventDetails(editCtx, parsedUrl.eventSlug, {
      categoryToken: CATEGORY_ALL_KEY,
      eventsPage: 1,
      categoriesPage: 1,
      backCallback: 'back_menu'
    });
    return true;
  }

  return {
    showMarketsList,
    showStrategyMarketsList,
    showMarketCategoriesList,
    showEventsFilterMenu,
    showEventsList,
    showEventsListByCategoryToken,
    parsePolymarketEventUrl,
    handlePolymarketEventUrlInput
  };
}
