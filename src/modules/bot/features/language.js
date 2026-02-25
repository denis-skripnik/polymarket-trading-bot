import { InlineKeyboard } from 'grammy';
import { loadConfig, updateConfig, isWalletConfigured } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getLanguageSelectionKeyboard } from '../ui/keyboards.js';

// Show language selection screen
export async function showLanguageSelectionScreen(ctx) {
  // Use hardcoded bilingual prompt since language is not selected yet
  const message = 'Пожалуйста, выберите язык / Please select your language:';
  await ctx.reply(message, {
    reply_markup: getLanguageSelectionKeyboard()
  });
}

// Handle language selection
export async function handleLanguageSelectionAction(ctx, lang, getMainMenuKeyboard) {
  // Save language to config
  await updateConfig('language', lang);
  
  // Get translator with selected language
  const t = await getTranslator(lang);
  
  // Show confirmation and proceed
  await ctx.editMessageText(t('language_selected'));
  
  // Check if wallet is configured
  const walletConfigured = await isWalletConfigured();
  
  if (!walletConfigured) {
    // Show wallet not configured message
    await ctx.reply(
      `<b>${t('welcome')}</b>\n\n` +
      `<b>${t('wallet_status')}:</b> ${t('not_configured')}\n\n` +
      t('wallet_not_configured_help'),
      {
        reply_markup: await getMainMenuKeyboard(lang),
        parse_mode: 'HTML'
      }
    );
  } else {
    // Show normal welcome with main menu
    const config = await loadConfig();
    await ctx.reply(
      `<b>${t('welcome')}</b>\n\n` +
      `<b>${t('wallet_status')}:</b> <code>${config.walletAddress}</code>`,
      {
        reply_markup: await getMainMenuKeyboard(lang),
        parse_mode: 'HTML'
      }
    );
  }
}

// Show language settings in Settings menu
export async function showLanguageSettingsMenu(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'ru');
  
  const keyboard = new InlineKeyboard()
    .text('🇷🇺 Русский', 'set_lang:ru')
    .row()
    .text('🇬🇧 English', 'set_lang:en')
    .row()
    .text(t('back'), 'settings');
  
  await ctx.editMessageText(t('select_language'), { reply_markup: keyboard });
}

// Handle language change from Settings
export async function handleSettingsLanguageChangeAction(ctx, lang, getMainMenuKeyboard) {
  await updateConfig('language', lang);
  
  const t = await getTranslator(lang);
  
  await ctx.editMessageText(t('language_changed'), {
    reply_markup: await getMainMenuKeyboard(lang)
  });
}
