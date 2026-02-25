import { readFile, writeFile, mkdir, access, open, rename, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createContext, safeLogInfo } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Config file path
const CONFIG_PATH = join(__dirname, '..', '..', 'data', 'config.json');
const CONFIG_DIR = dirname(CONFIG_PATH);
let saveConfigQueue = Promise.resolve();

// Default config structure for first run - all fields empty
const DEFAULT_CONFIG = {
  encrypted: {
    privateKey: '',
    l2Credentials: {
      apiKey: '',
      secret: '',
      passphrase: ''
    }
  },
  walletAddress: '',
  language: '',
  strategies: {
    stopLoss: -10,
    takeProfit: 30,
    maxAskPrice: 0.49
  },
  notifications: {
    priceChangePercent: 10,
    priceRepeatStepPercent: 2,
    alertCooldownSeconds: 300
  }
};

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await access(CONFIG_DIR);
  } catch {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
}

// Check if config file exists
async function configFileExists() {
  try {
    await access(CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

// Ensure config file exists - creates it with empty fields if missing
export async function ensureConfigFileExists() {
  await ensureDataDir();
  
  const exists = await configFileExists();
  if (!exists) {
    // Create config file with default skeleton (empty fields)
    const config = { ...DEFAULT_CONFIG };
    await saveConfig(config);
    const ctx = createContext('config', 'ensureConfigFileExists');
    safeLogInfo(ctx, 'Config file created with default skeleton');
    return config;
  }
  
  // File exists, load and return it
  return await loadConfig();
}

// Load configuration from file
export async function loadConfig() {
  try {
    await ensureDataDir();
    const data = await readFile(CONFIG_PATH, 'utf8');
    const config = JSON.parse(data);
    
    // Return config even if wallet is not configured
    // Language selection should work before wallet initialization
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Config file doesn't exist, return default
      const ctx = createContext('config', 'loadConfig');
      safeLogInfo(ctx, 'Config file not found, using defaults');
      return { ...DEFAULT_CONFIG };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Config file is corrupted JSON: ${error.message}`);
    }
    throw error;
  }
}

async function fsyncFile(path) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } catch (error) {
    if (!isIgnorableFsyncError(error)) {
      throw error;
    }
  } finally {
    await file.close();
  }
}

function isIgnorableFsyncError(error) {
  const code = String(error?.code || '').toUpperCase();
  return code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP';
}

async function fsyncDirectory(path) {
  // Directory fsync is not available on every platform (notably some Windows setups).
  // Best-effort only.
  let dirHandle = null;
  try {
    dirHandle = await open(path, 'r');
    await dirHandle.sync();
  } catch (error) {
    if (!isIgnorableFsyncError(error)) {
      throw error;
    }
  }
  finally {
    if (dirHandle) {
      try { await dirHandle.close(); } catch {}
    }
  }
}

function withSaveConfigLock(task) {
  const run = saveConfigQueue.then(task, task);
  saveConfigQueue = run.catch(() => {});
  return run;
}

// Save configuration to file
export async function saveConfig(config) {
  return withSaveConfigLock(async () => {
    await ensureDataDir();

    const serialized = JSON.stringify(config, null, 2);
    const tempPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;

    try {
      await writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await fsyncFile(tempPath);
      await rename(tempPath, CONFIG_PATH);
      await fsyncDirectory(CONFIG_DIR);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {}
      throw error;
    }

    const ctx = createContext('config', 'saveConfig');
    safeLogInfo(ctx, 'Config saved successfully');
  });
}

// Update specific config field
export async function updateConfig(field, value) {
  const config = await loadConfig();
  
  // Handle nested fields (e.g., 'strategies.stopLoss')
  const keys = field.split('.');
  let target = config;
  
  for (let i = 0; i < keys.length - 1; i++) {
    if (!target[keys[i]]) {
      target[keys[i]] = {};
    }
    target = target[keys[i]];
  }
  
  target[keys[keys.length - 1]] = value;
  await saveConfig(config);
  return config;
}

// Check if language is configured
export async function isLanguageConfigured() {
  try {
    const config = await loadConfig();
    return config.language && config.language !== '';
  } catch {
    return false;
  }
}

// Check if wallet is configured
export async function isWalletConfigured() {
  try {
    const config = await loadConfig();
    return config.walletAddress && config.walletAddress !== '' && 
           config.encrypted && config.encrypted.privateKey && config.encrypted.privateKey !== '';
  } catch {
    return false;
  }
}

// Check if this is first run (no wallet configured) - legacy function
export async function isFirstRun() {
  return !(await isWalletConfigured());
}

export function getPolygonRpcUrl() {
  return toNonEmptyEnv(process.env.POLYGON_RPC_URL);
}

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

function toNonEmptyEnv(value) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : '';
}

function splitCsvEnv(value) {
  const raw = toNonEmptyEnv(value);
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// Runtime translation settings are sourced from environment variables only.
export function getTranslationRuntimeConfig() {
  const enabled = parseBooleanEnv(process.env.TRANSLATION_ENABLED, false);
  const service = toNonEmptyEnv(process.env.TRANSLATION_SERVICE || 'openrouter').toLowerCase();
  const apiKey = toNonEmptyEnv(process.env.OPENROUTER_API_KEY);
  const model = toNonEmptyEnv(process.env.OPENROUTER_MODEL);
  const url = toNonEmptyEnv(process.env.OPENROUTER_BASE_URL);
  const fallbackModels = splitCsvEnv(process.env.OPENROUTER_FALLBACK_MODELS);
  const models = Array.from(new Set([model, ...fallbackModels].filter(Boolean)));

  const missing = [];
  if (!apiKey) missing.push('OPENROUTER_API_KEY');
  if (models.length === 0) missing.push('OPENROUTER_MODEL');
  if (!url) missing.push('OPENROUTER_BASE_URL');

  const ready = enabled && service === 'openrouter' && missing.length === 0;

  return {
    enabled,
    service,
    apiKey,
    model,
    models,
    fallbackModels,
    url,
    missing,
    ready
  };
}
