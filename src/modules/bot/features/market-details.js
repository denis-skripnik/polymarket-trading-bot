import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import {
  getEvent,
  filterTradeableSubmarkets,
  getMarketDetails,
  getBestBidAsk,
  parsePriceToMicro,
  formatPriceFromMicro
} from '../../polymarket.js';
import { cacheMarket } from '../../database.js';
import { userStates } from '../runtime.js';
import { CATEGORY_ALL_KEY, EVENT_DETAILS_SUBMARKETS_PAGE_SIZE } from '../constants.js';

export function createMarketDetailsFeature(deps) {
  const {
    sortByLiquidityDesc,
    filterMarketsByEventsPriceFilter,
    getEventsPriceFilter,
    formatEventsPriceFilterLabel,
    translateUiLabelsForLanguage,
    truncateButtonLabel,
    buildEventDetailsCallback,
    buildEventsListCallback,
    createContext,
    safeLogWarn,
    safeLogError,
    ensureClientInitialized,
    getMarketRefValue,
    escapeHtml,
    getActionLabel
  } = deps;

  // Show event details with submarkets
  async function showEventDetails(ctx, eventRef, nav = {}) {
    const config = await loadConfig();
    const language = config.language || 'ru';
    const t = await getTranslator(language);
    const chatId = ctx.chat.id;
    const categoryToken = nav.categoryToken || CATEGORY_ALL_KEY;
    const eventsPage = nav.eventsPage || 1;
    const eventIndex = nav.eventIndex || 0;
    const requestedSubmarketsPage = parseInt(nav.submarketsPage, 10) || 1;
    const categoriesPage = nav.categoriesPage || 1;
    const backCallback = nav.backCallback || buildEventsListCallback(categoryToken, eventsPage);

    await ctx.editMessageText(t('loading'));

    try {
      let event;
      try {
        event = await getEvent(eventRef);
      } catch (error) {
        const canUseCachedEvent =
          error?.status === 404 &&
          eventRef &&
          typeof eventRef === 'object' &&
          Array.isArray(eventRef.markets);

        if (!canUseCachedEvent) {
          throw error;
        }

        const ctxLog = createContext('bot', 'showEventDetails');
        safeLogWarn(ctxLog, 'Event lookup returned 404, using cached event payload', {
          slug: eventRef.slug,
          id: eventRef.id
        });
        event = eventRef;
      }

      if (!event) {
        await ctx.editMessageText(t('error_generic'), {
          reply_markup: new InlineKeyboard().text(t('back'), buildEventsListCallback(categoryToken, eventsPage))
        });
        return;
      }

      const activeFilter = getEventsPriceFilter(chatId);
      const submarkets = sortByLiquidityDesc(
        filterMarketsByEventsPriceFilter(filterTradeableSubmarkets(event), activeFilter)
      );

      const detailsKey = `eventDetails:${chatId}:${categoryToken}:${eventsPage}:${eventIndex}`;
      userStates.set(detailsKey, {
        event,
        submarkets,
        categoriesPage,
        timestamp: Date.now()
      });

      const title = event.title || t('unknown');
      const description = event.description || '';
      const descriptionSnippet = description
        ? `${description.substring(0, 200)}${description.length > 200 ? '...' : ''}`
        : '';
      const endDate = event.endDate ? new Date(event.endDate).toLocaleDateString() : t('na');

      const totalSubmarketPages = Math.max(1, Math.ceil(submarkets.length / EVENT_DETAILS_SUBMARKETS_PAGE_SIZE));
      const submarketsPage = Math.min(Math.max(requestedSubmarketsPage, 1), totalSubmarketPages);
      const startIndex = (submarketsPage - 1) * EVENT_DETAILS_SUBMARKETS_PAGE_SIZE;
      const submarketsPageItems = submarkets.slice(startIndex, startIndex + EVENT_DETAILS_SUBMARKETS_PAGE_SIZE);

      // Translate title + description + visible submarket labels in one batch to reduce API calls.
      const submarketQuestionsRaw = submarketsPageItems.map((market) => market.question || market.title || t('unknown'));
      const translationInputs = [title];
      if (descriptionSnippet) {
        translationInputs.push(descriptionSnippet);
      }
      translationInputs.push(...submarketQuestionsRaw);

      const translatedEventDetails = await translateUiLabelsForLanguage(
        language,
        translationInputs,
        'event details title, description, and submarket labels'
      );

      let cursor = 0;
      const translatedTitle = translatedEventDetails[cursor] || title;
      cursor += 1;
      const translatedDescription = descriptionSnippet
        ? (translatedEventDetails[cursor] || descriptionSnippet)
        : '';
      if (descriptionSnippet) {
        cursor += 1;
      }
      const translatedSubmarketQuestions = submarketQuestionsRaw.map((question, index) => (
        translatedEventDetails[cursor + index] || question
      ));

      let text = `${t('event_title')}: ${translatedTitle}\n\n`;
      if (translatedDescription) {
        text += `${translatedDescription}\n\n`;
      }
      text += `${t('event_end_date')}: ${endDate}\n`;
      text += `${t('events_filter_status', { value: formatEventsPriceFilterLabel(activeFilter, t) })}\n`;
      text += `${t('submarkets_title')} (${submarketsPage}/${totalSubmarketPages}):\n\n`;

      const keyboard = new InlineKeyboard();

      if (submarkets.length === 0) {
        text += t('no_tradeable_markets') + '\n';
      } else {
        submarketsPageItems.forEach((market, index) => {
          const absoluteIndex = startIndex + index;
          const question = translatedSubmarketQuestions[index] || market.question || market.title || t('unknown');
          const volume = market.volume ? `$${(market.volume / 1e6).toFixed(2)}M` : t('na');
          const shortQuestion = truncateButtonLabel(question) || t('unknown');
          text += `- ${shortQuestion}\n  ${t('volume_short')}: ${volume}\n`;
          keyboard.text(shortQuestion, `subm:${categoryToken}:${eventsPage}:${eventIndex}:${absoluteIndex}`).row();
        });
      }

      if (totalSubmarketPages > 1) {
        if (submarketsPage > 1) {
          keyboard.text(t('prev'), buildEventDetailsCallback(categoryToken, eventsPage, eventIndex, submarketsPage - 1));
        }
        if (submarketsPage < totalSubmarketPages) {
          keyboard.text(t('next'), buildEventDetailsCallback(categoryToken, eventsPage, eventIndex, submarketsPage + 1));
        }
        keyboard.row();
      }
      keyboard.text(t('back'), backCallback);

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const ctxLog = createContext('bot', 'showEventDetails');
      safeLogError(ctxLog, error, {
        eventRef,
        categoryToken,
        eventsPage,
        eventIndex,
        submarketsPage: requestedSubmarketsPage
      });
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard()
          .text(t('try_again'), buildEventDetailsCallback(categoryToken, eventsPage, eventIndex, requestedSubmarketsPage))
          .text(t('back'), `markets:${categoriesPage}`)
      });
    }
  }

  async function showMarketDetails(ctx, marketRef, nav = {}) {
    const config = await loadConfig();
    const language = config.language || 'ru';
    const t = await getTranslator(language);
    const chatId = ctx.chat.id;
    const backCallback = nav.backCallback || 'markets:1';
    const retryCallback = nav.retryCallback || 'markets:1';
    
    await ctx.editMessageText(t('loading'));
    
    try {
      let market;
      try {
        // getMarketDetails now works without initialized clobClient (uses Gamma API)
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

        const ctxLog = createContext('bot', 'showMarketDetails');
        safeLogWarn(ctxLog, 'Market lookup returned 404, using cached market payload', {
          slug: marketRef.slug,
          id: marketRef.id
        });
        market = marketRef;
      }

      const marketKey = getMarketRefValue(marketRef, market);
      
      // Cache market details for short callback tokens
      const detailsKey = `details:${chatId}`;
      userStates.set(detailsKey, {
        market,
        backCallback,
        retryCallback,
        timestamp: Date.now()
      });
      
      // Parse clobTokenIds and outcomes from market data
      let clobTokenIds = [];
      let outcomes = [];
      try {
        if (market.clobTokenIds) {
          clobTokenIds = JSON.parse(market.clobTokenIds);
        }
        if (market.outcomes) {
          outcomes = JSON.parse(market.outcomes);
        }
      } catch (e) {
        // Keep empty arrays if parsing fails
      }
      
      // Cache market data if we have tokens
      if (market.conditionId && clobTokenIds.length >= 2) {
        await cacheMarket(marketKey, market.conditionId, clobTokenIds[0], clobTokenIds[1]);
      }
      
      // Get orderbook for prices - requires clobClient
      let firstPrice = t('na');
      let secondPrice = t('na');
      
      try {
        await ensureClientInitialized();
        
        if (clobTokenIds[0]) {
          const { bestBidStr, bestAskStr } = await getBestBidAsk(clobTokenIds[0]);
          if (bestBidStr && bestAskStr) {
            const bestBidMicro = parsePriceToMicro(bestBidStr);
            const bestAskMicro = parsePriceToMicro(bestAskStr);
            firstPrice = `${t('bid')}: ${formatPriceFromMicro(bestBidMicro)} / ${t('ask')}: ${formatPriceFromMicro(bestAskMicro)}`;
          }
        }
        if (clobTokenIds[1]) {
          const { bestBidStr, bestAskStr } = await getBestBidAsk(clobTokenIds[1]);
          if (bestBidStr && bestAskStr) {
            const bestBidMicro = parsePriceToMicro(bestBidStr);
            const bestAskMicro = parsePriceToMicro(bestAskStr);
            secondPrice = `${t('bid')}: ${formatPriceFromMicro(bestBidMicro)} / ${t('ask')}: ${formatPriceFromMicro(bestAskMicro)}`;
          }
        }
      } catch (priceError) {
        // Prices unavailable without wallet - that's ok
        const ctxLog = createContext('bot', 'showMarketDetails');
        safeLogWarn(ctxLog, 'Price fetch failed for market details', {
          message: priceError?.message || String(priceError)
        });
        firstPrice = t('na');
        secondPrice = t('na');
      }
      const question = market.question || market.title || t('unknown');
      
      // Parse outcomePrices from JSON strings
      let outcomePrices = [];
      try {
        if (market.outcomePrices) {
          outcomePrices = JSON.parse(market.outcomePrices);
        }
      } catch (e) {
        // Keep empty array if parsing fails
      }
      
      // Handle volume - can be missing or in different formats
      let volume = t('na');
      if (market.volume) {
        const volNum = parseFloat(market.volume);
        if (volNum >= 1e6) {
          volume = `$${(volNum / 1e6).toFixed(2)}M`;
        } else if (volNum > 0) {
          volume = `$${volNum.toFixed(2)}`;
        }
      }
      
      // Handle liquidity - use liquidityNum if available (already a number), otherwise parse liquidity string
      let liquidity = t('na');
      const liqValue = market.liquidityNum || parseFloat(market.liquidity);
      if (liqValue && liqValue >= 1e6) {
        liquidity = `$${(liqValue / 1e6).toFixed(2)}M`;
      } else if (liqValue && liqValue > 0) {
        liquidity = `$${liqValue.toFixed(2)}`;
      }
      
      const endDate = market.endDate ? new Date(market.endDate).toLocaleDateString() : t('na');

      const [translatedQuestion, translatedFirstOutcome, translatedSecondOutcome, translatedResolvedOutcome] =
        await translateUiLabelsForLanguage(
          language,
          [
            question,
            outcomes[0] || t('yes'),
            outcomes[1] || t('no'),
            market.outcome || t('unknown')
          ],
          'market details labels'
        );

      // Get outcome names and prices (overwrite price variables if outcomePrices available)
      const firstOutcome = translatedFirstOutcome || outcomes[0] || t('yes');
      const secondOutcome = translatedSecondOutcome || outcomes[1] || t('no');
      const resolvedOutcome = translatedResolvedOutcome || market.outcome || t('unknown');
      const status = market.resolved
        ? t('market_resolved', { outcome: escapeHtml(resolvedOutcome) })
        : t('market_active');
      // Use orderbook prices if available, otherwise use outcomePrices from API
      const firstOutcomePrice = outcomePrices[0] ? `${(parseFloat(outcomePrices[0]) * 100).toFixed(1)}%` : t('na');
      const secondOutcomePrice = outcomePrices[1] ? `${(parseFloat(outcomePrices[1]) * 100).toFixed(1)}%` : t('na');
      // Use orderbook prices if available, otherwise fallback to outcomePrices
      const displayFirstPrice = firstPrice !== t('na') ? firstPrice : firstOutcomePrice;
      const displaySecondPrice = secondPrice !== t('na') ? secondPrice : secondOutcomePrice;
      
      // Construct Polymarket URL using market slug
      const marketUrl = `https://polymarket.com/event/${market.slug}/${market.slug}`;
      
      const text = `<b>${t('market_question')}:</b> ${escapeHtml(translatedQuestion || question)}\n\n` +
                   `<b>${t('market_volume')}:</b> ${volume}\n` +
                   `<b>${t('market_liquidity')}:</b> ${liquidity}\n` +
                   `<b>${t('market_end_date')}:</b> ${endDate}\n` +
                   `${status}\n\n` +
                   `<b>${escapeHtml(firstOutcome)}:</b> ${displayFirstPrice}\n` +
                   `<b>${escapeHtml(secondOutcome)}:</b> ${displaySecondPrice}\n\n` +
                   `Link: <a href="${marketUrl}">Polymarket</a>`;
      
      const keyboard = new InlineKeyboard();
      
      // First choose action type, then outcome on the next step.
      if (!market.resolved && clobTokenIds.length >= 2) {
        keyboard.text(getActionLabel('mb', t), 'ma:mb').text(getActionLabel('ms', t), 'ma:ms').row();
        keyboard.text(getActionLabel('lb', t), 'ma:lb').text(getActionLabel('ls', t), 'ma:ls').row();
        if (market.conditionId) {
          keyboard.text(t('strategy_start'), 'mkt_strategy').row();
          keyboard.text(t('split'), 'mkt_split').text(t('merge'), 'mkt_merge').row();
        }
      }
      keyboard.text(t('back'), backCallback);
      
      await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'HTML' });
    } catch (error) {
      const ctxLog = createContext('bot', 'showMarketDetails');
      safeLogError(ctxLog, error, { marketRef: getMarketRefValue(marketRef), nav });
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('try_again'), retryCallback).text(t('back'), backCallback)
      });
    }
  }

  return {
    showEventDetails,
    showMarketDetails
  };
}
