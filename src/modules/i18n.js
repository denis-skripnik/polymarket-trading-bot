import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createContext, safeLogWarn } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const locales = {};

// Load locale file
async function loadLocale(lang) {
  if (locales[lang]) return locales[lang];
  
  try {
    const filePath = join(__dirname, '..', 'locales', `${lang}.json`);
    const data = await readFile(filePath, 'utf8');
    const normalized = data.replace(/^\uFEFF/, '');
    locales[lang] = JSON.parse(normalized);
    return locales[lang];
  } catch (error) {
    const ctx = createContext('i18n', 'loadLocale');
    safeLogWarn(ctx, 'Failed to load locale, falling back', {
      lang,
      message: error?.message
    });
    // Fallback to English
    if (lang !== 'en') {
      return loadLocale('en');
    }
    return {};
  }
}

// Get translation function for a language
export async function getTranslator(lang) {
  const locale = await loadLocale(lang);
  
  return function t(key, replacements = {}) {
    let text = locale[key] || locales['en']?.[key] || key;
    
    // Replace placeholders like {{name}}
    for (const [placeholder, value] of Object.entries(replacements)) {
      text = text.replace(new RegExp(`{{${placeholder}}}`, 'g'), value);
    }
    
    return text;
  };
}

// Synchronous version for when locale is already loaded
// This is used by bot.js for keyboard labels after initial load
export function getTranslationSync(key, lang) {
  const locale = locales[lang] || locales['en'] || {};
  return locale[key] || key;
}

// Export loaded locales cache for reuse
export function getLocalesCache() {
  return { ...locales };
}

// Preload a locale into cache
export async function preloadLocale(lang) {
  return await loadLocale(lang);
}
