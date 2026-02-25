import { InlineKeyboard } from 'grammy';
import { getTranslator } from '../../i18n.js';

// Bilingual keyboard used before language is selected.
export function getLanguageSelectionKeyboard() {
  return new InlineKeyboard()
    .text('🇷🇺 Русский', 'select_lang:ru')
    .row()
    .text('🇬🇧 English', 'select_lang:en');
}

export async function getMainMenuKeyboard(lang) {
  const t = await getTranslator(lang);

  return new InlineKeyboard()
    .text(t('menu_markets'), 'markets:1')
    .text(t('menu_strategy_markets'), 'strategy_markets:1')
    .row()
    .text(t('menu_positions'), 'positions')
    .text(t('menu_orders'), 'orders')
    .row()
    .text(t('menu_strategies'), 'strategies')
    .row()
    .text(t('menu_settings'), 'settings');
}


export function buildMergeAmountKeyboard(t, hasMaxOption = false) {
  const keyboard = new InlineKeyboard();
  if (hasMaxOption) {
    keyboard.text('MAX', 'merge_max');
  }
  keyboard.text(t('cancel'), 'cancel');
  return keyboard;
}

