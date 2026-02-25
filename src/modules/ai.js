import { createContext, safeLogWarn } from './logger.js';
import { getTranslationRuntimeConfig } from './config.js';

const OPENROUTER_CHAT_COMPLETIONS_PATH = '/chat/completions';
const TRANSLATION_TIMEOUT_MS = 9000;
const TRANSLATION_BATCH_SIZE = 20;
const TRANSLATION_CACHE_MAX = 2000;
const MODEL_UNAVAILABLE_TTL_MS = 10 * 60 * 1000;
const WARN_THROTTLE_MS = 60 * 1000;

const translationCache = new Map();
const unavailableModels = new Map();
let missingConfigWarned = false;
let preferredModel = null;
let lastWarnSignature = '';
let lastWarnAt = 0;

function ensureCacheSizeLimit() {
  while (translationCache.size > TRANSLATION_CACHE_MAX) {
    const firstKey = translationCache.keys().next().value;
    if (firstKey === undefined) break;
    translationCache.delete(firstKey);
  }
}

function isModelTemporarilyUnavailable(model) {
  const blockedAt = unavailableModels.get(model);
  if (!blockedAt) return false;
  if (Date.now() - blockedAt > MODEL_UNAVAILABLE_TTL_MS) {
    unavailableModels.delete(model);
    return false;
  }
  return true;
}

function markModelTemporarilyUnavailable(model) {
  unavailableModels.set(model, Date.now());
  if (preferredModel === model) {
    preferredModel = null;
  }
}

function warnThrottled(context, message, extra = {}) {
  const signature = `${message}:${extra?.signature || ''}`;
  const now = Date.now();
  if (signature === lastWarnSignature && now - lastWarnAt < WARN_THROTTLE_MS) {
    return;
  }
  lastWarnSignature = signature;
  lastWarnAt = now;
  safeLogWarn(context, message, extra);
}

function getResponseContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        return typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return '';
}

function parseJsonFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {}
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  return null;
}

function parseTranslationPayload(rawContent, expectedCount) {
  const parsed = parseJsonFromText(rawContent);
  if (!parsed || !Array.isArray(parsed.translations)) {
    return null;
  }

  const result = new Array(expectedCount).fill(null);
  for (let i = 0; i < parsed.translations.length; i += 1) {
    const entry = parsed.translations[i];
    if (typeof entry === 'string') {
      if (i < expectedCount) result[i] = entry;
      continue;
    }

    if (!entry || typeof entry !== 'object') continue;
    const index = Number(entry.index);
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) continue;
    if (typeof entry.text === 'string') {
      result[index] = entry.text;
    }
  }

  return result;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function toNonEmptyText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.trim();
}

function normalizeBaseUrl(rawUrl) {
  return String(rawUrl || '').replace(/\/+$/, '');
}

async function requestBatchTranslation(batch, settings, model, contextLabel = '') {
  const baseUrl = normalizeBaseUrl(settings.url);
  const endpoint = `${baseUrl}${OPENROUTER_CHAT_COMPLETIONS_PATH}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

  const systemPrompt =
    'You are a translator for a trading bot UI. Translate each input string from English to natural Russian.' +
    ' Keep meaning precise, keep names/tickers/URLs unchanged when appropriate, and do not add explanations.' +
    ' Return strict JSON only: {"translations":[{"index":0,"text":"..."}, ...]}.';

  const userPrompt = JSON.stringify({
    task: 'translate_ui_labels',
    target_language: 'ru',
    context: contextLabel || 'prediction market categories, events, and market labels',
    items: batch.map((text, index) => ({ index, text }))
  });

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      let errorMessage = '';
      try {
        const parsedError = JSON.parse(errorBody);
        errorMessage =
          parsedError?.error?.message ||
          parsedError?.message ||
          '';
      } catch {}

      const shortBody = errorMessage || errorBody.slice(0, 220);
      const error = new Error(`OpenRouter HTTP ${response.status}: ${shortBody}`);
      error.status = response.status;
      error.model = model;
      if (response.status === 404 && /no endpoints found/i.test(shortBody)) {
        error.code = 'MODEL_ENDPOINT_NOT_FOUND';
      }
      throw error;
    }

    const payload = await response.json();
    const content = getResponseContent(payload);
    const parsed = parseTranslationPayload(content, batch.length);
    if (!parsed) {
      throw new Error('OpenRouter returned non-JSON translation payload');
    }

    return parsed.map((translated, index) => {
      const normalized = toNonEmptyText(translated);
      return normalized || batch[index];
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function translateUiTexts(texts, language, contextLabel = '') {
  const source = Array.isArray(texts) ? texts : [];
  const normalizedSource = source.map((value) => toNonEmptyText(value));
  if (!normalizedSource.length) return normalizedSource;
  if (language !== 'ru') return normalizedSource;

  const settings = getTranslationRuntimeConfig();
  if (!settings.ready) {
    if (settings.enabled && !missingConfigWarned) {
      missingConfigWarned = true;
      const ctx = createContext('ai', 'translateUiTexts');
      warnThrottled(ctx, 'Translation enabled but OpenRouter config is incomplete', {
        service: settings.service,
        missing: settings.missing,
        signature: settings.missing.join(',')
      });
    }
    return normalizedSource;
  }

  const configuredModels = Array.isArray(settings.models) ? settings.models.filter(Boolean) : [];
  const activeModels = configuredModels.filter((model) => !isModelTemporarilyUnavailable(model));
  const models = [];
  if (preferredModel && activeModels.includes(preferredModel)) {
    models.push(preferredModel);
  }
  for (const model of activeModels) {
    if (!models.includes(model)) models.push(model);
  }

  if (!models.length) {
    const ctx = createContext('ai', 'translateUiTexts');
    warnThrottled(ctx, 'No available OpenRouter models for translation (temporarily blocked)', {
      signature: 'models_blocked'
    });
    return normalizedSource;
  }

  const result = [...normalizedSource];
  const unique = [];
  const textToIndexes = new Map();

  for (let i = 0; i < normalizedSource.length; i += 1) {
    const text = normalizedSource[i];
    if (!text) continue;

    const cacheKey = `ru:${text}`;
    if (translationCache.has(cacheKey)) {
      result[i] = translationCache.get(cacheKey);
      continue;
    }

    if (!textToIndexes.has(text)) {
      textToIndexes.set(text, []);
      unique.push(text);
    }
    textToIndexes.get(text).push(i);
  }

  if (!unique.length) return result;

  const batches = chunkArray(unique, TRANSLATION_BATCH_SIZE);
  for (const batch of batches) {
    let translatedBatch = null;
    let lastError = null;

    for (const model of models) {
      try {
        translatedBatch = await requestBatchTranslation(batch, settings, model, contextLabel);
        preferredModel = model;
        break;
      } catch (error) {
        lastError = error;
        if (error?.code === 'MODEL_ENDPOINT_NOT_FOUND') {
          markModelTemporarilyUnavailable(model);
          continue;
        }

        if (error?.status === 404) {
          markModelTemporarilyUnavailable(model);
          continue;
        }

        if (error?.name === 'AbortError') {
          continue;
        }

        break;
      }
    }

    if (!translatedBatch) {
      for (let i = 0; i < batch.length; i += 1) {
        const sourceText = batch[i];
        const indexes = textToIndexes.get(sourceText) || [];
        for (const index of indexes) {
          result[index] = sourceText;
        }
      }

      const ctx = createContext('ai', 'translateUiTexts');
      warnThrottled(ctx, 'OpenRouter translation failed, using original texts', {
        message: lastError?.message || 'No model responded',
        signature: lastError?.message || 'no_model_response'
      });
      break;
    }

    for (let i = 0; i < batch.length; i += 1) {
      const sourceText = batch[i];
      const translatedText = toNonEmptyText(translatedBatch[i]) || sourceText;
      const cacheKey = `ru:${sourceText}`;
      translationCache.set(cacheKey, translatedText);
      ensureCacheSizeLimit();

      const indexes = textToIndexes.get(sourceText) || [];
      for (const index of indexes) {
        result[index] = translatedText;
      }
    }
  }

  return result;
}

export async function translateUiText(text, language, contextLabel = '') {
  const [translated] = await translateUiTexts([text], language, contextLabel);
  return translated || toNonEmptyText(text);
}
