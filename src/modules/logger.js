/**
 * Safe logging utilities for Polymarket Trading Bot
 * 
 * Security rules:
 * - NEVER log: private keys, API credentials, encrypted blobs, Authorization headers, Cookies
 * - Redact sensitive fields from error objects before logging
 * - Only log safe context information
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

const LOG_TO_FILE = parseBooleanEnv(process.env.LOG_TO_FILE, true);
const DEFAULT_LOG_FILE_PATH = join(__dirname, '..', '..', 'data', 'logs', 'app.log');
const RAW_LOG_FILE_PATH = String(process.env.LOG_FILE_PATH || '').trim();
const RESOLVED_LOG_FILE_PATH = RAW_LOG_FILE_PATH
  ? (isAbsolute(RAW_LOG_FILE_PATH) ? RAW_LOG_FILE_PATH : join(process.cwd(), RAW_LOG_FILE_PATH))
  : DEFAULT_LOG_FILE_PATH;

let fileWriteQueue = Promise.resolve();
const loggerRuntime = {
  fileEnabled: LOG_TO_FILE,
  filePath: RESOLVED_LOG_FILE_PATH,
  writesQueued: 0,
  writesCompleted: 0,
  writeFailures: 0,
  lastWriteAt: null,
  lastWriteError: null
};

// Sensitive field patterns to redact
const SENSITIVE_PATTERNS = [
  /privateKey/i,
  /apiKey/i,
  /secret/i,
  /passphrase/i,
  /password/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /encrypted/i,
  /x-api-key/i,
  /x-secret/i,
  /x-passphrase/i,
  /l2Credentials/i,
  /credentials/i,
  /signature/i,
  /sig/i,
  /nonce/i,
];

// Fields that should never appear in logs
const FORBIDDEN_FIELDS = new Set([
  'privateKey',
  'apiKey',
  'secret',
  'passphrase',
  'password',
  'encrypted',
  'l2Credentials',
  'authorization',
  'cookie',
  'x-api-key',
  'x-secret',
  'x-passphrase',
  'credentials',
  'signature',
  'sig',
  'rawTransaction',
  'signedOrder',
]);

/**
 * Check if a field name is sensitive
 * @param {string} fieldName 
 * @returns {boolean}
 */
function isSensitiveField(fieldName) {
  if (typeof fieldName !== 'string') return false;
  const lower = fieldName.toLowerCase();
  return FORBIDDEN_FIELDS.has(lower) || 
         SENSITIVE_PATTERNS.some(pattern => pattern.test(fieldName));
}

/**
 * Deep redact sensitive fields from an object
 * @param {*} value - Any value to redact
 * @param {number} depth - Current recursion depth
 * @param {Set} seen - Set of already seen objects (circular reference protection)
 * @returns {*} Redacted value
 */
export function redactSensitive(value, depth = 0, seen = new Set()) {
  // Limit recursion depth
  if (depth > 5) return '[DEPTH_LIMIT]';
  
  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // JSON.stringify cannot serialize bigint values.
  // Convert to string early so safe log payloads never throw.
  if (typeof value === 'bigint') {
    return value.toString();
  }
  
  // Handle primitives
  if (typeof value !== 'object') {
    // Redact if it's a string that looks like a secret
    if (typeof value === 'string' && value.length > 20) {
      // Check if it looks like a hex private key or encrypted blob
      if (/^0x[0-9a-fA-F]{64}$/.test(value) || value.includes('encrypted')) {
        return '[REDACTED]';
      }
    }
    return value;
  }
  
  // Handle circular references
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);
  
  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(item => redactSensitive(item, depth + 1, seen));
  }
  
  // Handle objects
  const redacted = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveField(key)) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redactSensitive(val, depth + 1, seen);
    }
  }
  
  return redacted;
}

/**
 * Safely log an error without leaking secrets
 * @param {string} context - Safe context description (no secrets)
 * @param {Error|any} error - Error object or any value
 * @param {Object} extra - Extra safe context (will be redacted)
 */
export function safeLogError(context, error, extra = {}) {
  const safeError = {
    message: error?.message || String(error),
    name: error?.name || 'Error',
    code: error?.code,
    status: error?.status ?? error?.response?.status
  };

  emitLogEntry({
    level: 'ERROR',
    context,
    error: safeError,
    extra: redactSensitive(extra)
  });
}

/**
 * Safely log a warning
 * @param {string} context - Safe context description
 * @param {string} message - Warning message
 * @param {Object} extra - Extra safe context
 */
export function safeLogWarn(context, message, extra = {}) {
  emitLogEntry({
    level: 'WARN',
    context,
    message,
    extra: redactSensitive(extra)
  });
}

/**
 * Safely log info (use sparingly in production)
 * @param {string} context - Safe context description
 * @param {string} message - Info message
 * @param {Object} extra - Extra safe context
 */
export function safeLogInfo(context, message, extra = {}) {
  emitLogEntry({
    level: 'INFO',
    context,
    message,
    extra: redactSensitive(extra)
  });
}

const LIFECYCLE_INFO_CONTEXTS = new Set([
  'index:main',
  'index:runbot',
  'index:shutdown',
  'bot:startbot',
  'bot:stopbot',
  'workers:startworkers',
  'workers:stopworkers'
]);

const LIFECYCLE_INFO_MESSAGE_HINTS = [
  'starting',
  'started',
  'stopping',
  'stopped',
  'shutting down',
  'bot is running',
  'bootstrap mode'
];

function shouldEmitLogEntry(entry) {
  const level = String(entry?.level || '').toUpperCase();
  if (level === 'ERROR') return true;

  // In production-oriented mode, drop WARN/regular INFO noise and keep only lifecycle INFO.
  if (level !== 'INFO') return false;

  const context = String(entry?.context || '').trim().toLowerCase();
  if (LIFECYCLE_INFO_CONTEXTS.has(context)) return true;

  const message = String(entry?.message || '').trim().toLowerCase();
  return LIFECYCLE_INFO_MESSAGE_HINTS.some((hint) => message.includes(hint));
}

function emitLogEntry(entry) {
  if (!shouldEmitLogEntry(entry)) {
    return;
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    ...entry
  };

  // Preserve current behavior: structured logs go to stderr.
  console.error(JSON.stringify(logEntry));
  void writeLogEntryToFile(logEntry);
}

async function writeLogEntryToFile(logEntry) {
  if (!LOG_TO_FILE) return;

  loggerRuntime.writesQueued += 1;
  const line = `${JSON.stringify(logEntry)}\n`;
  const targetPath = RESOLVED_LOG_FILE_PATH;

  fileWriteQueue = fileWriteQueue
    .then(async () => {
      await mkdir(dirname(targetPath), { recursive: true });
      await appendFile(targetPath, line, 'utf8');
      loggerRuntime.writesCompleted += 1;
      loggerRuntime.lastWriteAt = new Date().toISOString();
      loggerRuntime.lastWriteError = null;
    })
    .catch((error) => {
      loggerRuntime.writeFailures += 1;
      loggerRuntime.lastWriteError = String(error?.message || error);
    });

  await fileWriteQueue;
}

export function getLoggerRuntimeStatus() {
  return {
    ...loggerRuntime,
    writesPending: Math.max(0, loggerRuntime.writesQueued - loggerRuntime.writesCompleted)
  };
}

export async function flushLogger(timeoutMs = 3000) {
  const pending = fileWriteQueue;
  if (!pending) return;

  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    await pending;
    return;
  }

  await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(resolve, timeout))
  ]);
}

/**
 * Normalize user numeric input (handles comma and dot decimals)
 * Rules:
 * - Trim whitespace
 * - Remove spaces
 * - Replace comma with dot
 * - Validate strict numeric format
 * @param {string} input - Raw user input
 * @returns {string} Normalized numeric string with dot decimal
 * @throws {Error} If input format is invalid
 */
export function normalizeNumericInput(input) {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }
  
  // Trim and remove all whitespace
  let normalized = input.trim().replace(/\s+/g, '');
  
  // Replace comma with dot for decimal separator
  normalized = normalized.replace(/,/g, '.');
  
  // Validate: only digits and at most one dot
  if (!/^\d+\.?\d*$/.test(normalized)) {
    throw new Error('Invalid numeric format');
  }
  
  // Check decimal places (max 6)
  const parts = normalized.split('.');
  if (parts[1] && parts[1].length > 6) {
    throw new Error('Too many decimal places (max 6)');
  }
  
  return normalized;
}

/**
 * Create a safe context string for logging
 * @param {string} module - Module name
 * @param {string} action - Action being performed
 * @param {string} marketSlug - Optional market slug
 * @returns {string} Safe context string
 */
export function createContext(module, action, marketSlug = null) {
  return marketSlug ? `${module}:${action}:${marketSlug}` : `${module}:${action}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableError(error) {
  const status = Number(error?.status ?? error?.response?.status);
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;

  const msg = String(error?.message || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('rate limit') ||
    msg.includes('too many') ||
    msg.includes('underpriced') ||
    msg.includes('replacement fee too low') ||
    msg.includes('nonce too low')
  );
}

export async function retry(fn, maxAttempts = 3, baseDelay = 1000) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        throw error;
      }
      const delay = baseDelay * (2 ** (attempt - 1));
      await wait(delay);
    }
  }

  throw lastError;
}

export function formatError(error, language = 'en') {
  const msg = String(error?.message || '');
  const lower = msg.toLowerCase();
  const ru = language === 'ru';

  if (lower.includes('insufficient')) {
    return {
      title: ru ? 'Недостаточно средств' : 'Insufficient funds',
      message: ru ? 'Недостаточно баланса для выполнения операции.' : 'Not enough balance to complete the operation.',
      action: ru ? 'Пополните баланс и повторите.' : 'Top up balance and try again.'
    };
  }

  if (lower.includes('allowance') || lower.includes('approval')) {
    return {
      title: ru ? 'Недостаточно разрешений' : 'Insufficient allowance',
      message: ru ? 'Нужно обновить allowances для торговли.' : 'Trading allowances must be refreshed.',
      action: ru ? 'Откройте Settings -> Set Allowances.' : 'Open Settings -> Set Allowances.'
    };
  }

  if (lower.includes('rate limit') || lower.includes('429')) {
    return {
      title: ru ? 'Слишком много запросов' : 'Rate limited',
      message: ru ? 'API временно ограничил запросы.' : 'API temporarily rate-limited requests.',
      action: ru ? 'Подождите и повторите.' : 'Wait and retry.'
    };
  }

  return {
    title: ru ? 'Ошибка' : 'Error',
    message: msg || (ru ? 'Произошла непредвиденная ошибка.' : 'Unexpected error occurred.'),
    action: ru ? 'Повторите действие позже.' : 'Retry later.'
  };
}

function bumpBigNumberish(value, ratio) {
  const current = BigInt(value?.toString?.() ?? value);
  const scale = 10_000n;
  const factor = BigInt(Math.round((1 + ratio) * Number(scale)));
  return (current * factor) / scale;
}

export async function retryWithHigherGas(tx, signer, maxGasIncrease = 0.1) {
  if (!signer || typeof signer.sendTransaction !== 'function') {
    throw new Error('retryWithHigherGas requires a signer with sendTransaction()');
  }

  const request = { ...(tx || {}) };
  let lastError = null;
  const attempts = 3;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await signer.sendTransaction(request);
      await response.wait(1);
      return response.hash;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= attempts - 1) {
        throw error;
      }

      const stepRatio = maxGasIncrease / attempts;
      if (request.gasPrice) {
        request.gasPrice = bumpBigNumberish(request.gasPrice, stepRatio);
      }
      if (request.maxPriorityFeePerGas) {
        request.maxPriorityFeePerGas = bumpBigNumberish(request.maxPriorityFeePerGas, stepRatio);
      }
      if (request.maxFeePerGas) {
        request.maxFeePerGas = bumpBigNumberish(request.maxFeePerGas, stepRatio);
      }
      await wait(500 * (attempt + 1));
    }
  }

  throw lastError;
}

function redactSensitiveText(text) {
  if (typeof text !== 'string' || !text.length) {
    return text;
  }

  return text
    // JSON-like key-value pairs: "KEY":"value"
    .replace(
      /"([^"]*(?:api[_-]?key|apikey|secret|passphrase|private[_-]?key|privatekey|authorization|cookie|x-api-key|x-secret|x-passphrase|poly_signature|poly_api_key|poly_passphrase)[^"]*)"\s*:\s*"[^"]*"/gi,
      '"$1":"[REDACTED]"'
    )
    // Plain key=value / key: value
    .replace(
      /([A-Za-z0-9_-]*(?:api[_-]?key|apikey|secret|passphrase|private[_-]?key|privatekey|authorization|cookie|x-api-key|x-secret|x-passphrase|poly_signature|poly_api_key|poly_passphrase)[A-Za-z0-9_-]*)\s*[=:]\s*['"]?[^\s'",}]+/gi,
      '$1=[REDACTED]'
    )
    .replace(/0x[a-fA-F0-9]{64}/g, '[REDACTED_HEX]');
}

function redactConsoleArg(arg) {
  if (typeof arg === 'string') {
    return redactSensitiveText(arg);
  }
  if (arg !== null && typeof arg === 'object') {
    return redactSensitive(arg);
  }
  return arg;
}

// Track if console has been patched to prevent double-patching
let consolePatched = false;

/**
 * Patch console methods to redact sensitive data before printing.
 * This catches SDK direct console calls that bypass our safe logging.
 * Must be called at startup before any CLOB client usage.
 */
export function patchConsoleForRedaction() {
  if (consolePatched) {
    return;
  }
  consolePatched = true;

  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalInfo = console.info;

  console.error = function(...args) {
    const redactedArgs = args.map(redactConsoleArg);
    return originalError.apply(this, redactedArgs);
  };

  console.warn = function(...args) {
    const redactedArgs = args.map(redactConsoleArg);
    return originalWarn.apply(this, redactedArgs);
  };

  console.log = function(...args) {
    const redactedArgs = args.map(redactConsoleArg);
    return originalLog.apply(this, redactedArgs);
  };

  console.info = function(...args) {
    const redactedArgs = args.map(redactConsoleArg);
    return originalInfo.apply(this, redactedArgs);
  };
}
