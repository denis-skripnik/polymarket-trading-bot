import { formatPriceFromMicro, parsePriceToMicro } from '../../polymarket.js';

export function toUnitIntervalOrNull(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < 0 || number > 1) return null;
  return number;
}

export function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseBaseUnitsBigIntSafe(value) {
  if (value === null || value === undefined) return 0n;
  const raw = String(value).trim();
  if (!raw || !/^-?\d+$/.test(raw)) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

export function formatPlainNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2).replace(/\.?0+$/, '');
}
export function normalizeOutcomeSideHint(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!normalized) return null;

  if (normalized === 'YES' || normalized === 'Y' || normalized === 'UP' || normalized === '1' || normalized === 'ДА') {
    return 'YES';
  }

  if (normalized === 'NO' || normalized === 'N' || normalized === 'DOWN' || normalized === '0' || normalized === 'НЕТ') {
    return 'NO';
  }

  return null;
}

export function getRedeemActionLabel(language) {
  return String(language || 'ru').toLowerCase() === 'ru' ? 'Погасить' : 'Redeem';
}

export function formatOrderPriceDisplay(priceNumber, t) {
  if (!Number.isFinite(priceNumber)) {
    return t('na');
  }

  const clamped = Math.max(0, Math.min(1, priceNumber));
  const usd = formatPriceFromMicro(parsePriceToMicro(String(clamped)));
  const cents = Math.round(clamped * 100);
  return `${usd} (${cents}c)`;
}

function getTxUrl(txHash) {
  const normalized = String(txHash || '').trim();
  if (!normalized) return '';
  return `https://polygonscan.com/tx/${normalized}`;
}

export function formatTxHashLink(txHash, anchorText = null) {
  const normalized = String(txHash || '').trim();
  if (!normalized) return '';
  const label = anchorText || `${normalized.slice(0, 10)}...${normalized.slice(-8)}`;
  return `<a href="${escapeHtml(getTxUrl(normalized))}">${escapeHtml(label)}</a>`;
}

export function formatSignedPercentValue(percent) {
  const number = Number(percent);
  if (!Number.isFinite(number)) return '0';
  if (number === 0) return '0';
  return number > 0 ? `+${number}` : `${number}`;
}

export function parsePercentInput(raw) {
  const normalized = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.');

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(2));
}

export function parsePositiveNumberInput(raw) {
  const normalized = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.');

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Number(value.toFixed(2));
}

export function parseUnitIntervalInput(raw, digits = 4) {
  const normalized = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.');

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Number(value.toFixed(Math.max(1, Math.floor(digits))));
}

export function parseEventsFilterRangeInput(raw) {
  const text = String(raw ?? '').trim().replace(',', '.');
  const match = text.match(/^\s*([0-9]*\.?[0-9]+)\s*[-\s:;]+\s*([0-9]*\.?[0-9]+)\s*$/);
  if (!match) {
    return null;
  }

  const min = toUnitIntervalOrNull(match[1]);
  const max = toUnitIntervalOrNull(match[2]);
  if (min === null || max === null || min >= max) {
    return null;
  }

  return { min, max };
}

export function parseNonNegativeIntegerInput(raw) {
  const normalized = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}
