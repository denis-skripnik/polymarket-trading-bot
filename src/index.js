import 'dotenv/config';
import { loadConfig } from './modules/config.js';
import { initBot, startBot, stopBot } from './modules/bot/bot.js';
import { initDatabase } from './modules/database.js';
import {
  patchConsoleForRedaction,
  createContext,
  safeLogError,
  safeLogInfo,
  flushLogger
} from './modules/logger.js';
import { startWorkers, stopWorkers } from './modules/workers.js';
import { applyProxyRuntime } from './modules/proxy.js';

// Patch console first to catch any SDK secret leakage
patchConsoleForRedaction();

const proxyRuntime = applyProxyRuntime();

// Check for bootstrap mode
const isBootstrap = process.argv.includes('--bootstrap');
let isShuttingDown = false;

async function shutdown(signal = 'unknown', exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const ctx = createContext('index', 'shutdown');
  safeLogInfo(ctx, 'Shutting down application', { signal, exitCode });

  try {
    stopWorkers();
  } catch (error) {
    safeLogError(ctx, error, { stage: 'stopWorkers' });
  }

  try {
    stopBot();
  } catch (error) {
    safeLogError(ctx, error, { stage: 'stopBot' });
  }

  try {
    await flushLogger(1500);
  } catch {}

  process.exit(exitCode);
}

function setupProcessHandlers() {
  process.once('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  process.on('unhandledRejection', (reason) => {
    const ctx = createContext('index', 'unhandledRejection');
    safeLogError(ctx, reason, { signal: 'unhandledRejection' });
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    const ctx = createContext('index', 'uncaughtException');
    safeLogError(ctx, error, { signal: 'uncaughtException' });
    void shutdown('uncaughtException', 1);
  });
}

async function main() {
  try {
    setupProcessHandlers();
    const ctx = createContext('index', 'main');
    safeLogInfo(ctx, 'Proxy runtime configured', {
      enabled: proxyRuntime.enabled,
      proxy: proxyRuntime.enabled ? proxyRuntime.redacted : 'disabled',
      proxyTransportDowngraded: Boolean(proxyRuntime.downgradedToHttpConnect),
      outboundHttpTimeoutMs: proxyRuntime.httpTimeoutMs,
      clobAxiosTimeoutPatched: Boolean(proxyRuntime.clobAxiosPatched),
      clobHttpHelpersPatched: Boolean(proxyRuntime.clobHttpHelpersPatched),
      proxyAgentConfigured: Boolean(proxyRuntime.proxyAgentConfigured)
    });
    if (isBootstrap) {
      safeLogInfo(ctx, 'Running in bootstrap mode');
      await runBootstrap();
    } else {
      safeLogInfo(ctx, 'Starting Polymarket Trading Bot (production)');
      await runBot();
    }
  } catch (error) {
    const ctx = createContext('index', 'main');
    safeLogError(ctx, error, { stage: 'main' });
    await shutdown('main_error', 1);
  }
}

// Bootstrap mode - Phase 1 sanity check
async function runBootstrap() {
  const ctx = createContext('index', 'runBootstrap');
  safeLogInfo(ctx, 'Phase 1 bootstrap: loading config');
  
  // Test config loading to ensure paths work
  const config = await loadConfig();
  safeLogInfo(ctx, 'Config loaded successfully', {
    walletAddress: config.walletAddress || 'not configured'
  });

  // Phase 1 sanity check: verify auth.js imports without crashing
  const { getMachineKey, encrypt, decrypt } = await import('./modules/auth.js');
  const machineKey = await getMachineKey();
  const testEncrypted = await encrypt('test-value', machineKey);
  const testDecrypted = await decrypt(testEncrypted, machineKey);
  if (testDecrypted !== 'test-value') throw new Error('Encrypt/decrypt round-trip failed');
  safeLogInfo(ctx, 'auth.js import OK (getMachineKey, encrypt, decrypt work)');
  
  safeLogInfo(ctx, 'Phase 1 bootstrap OK');
  process.exit(0);
}

// Bot mode - Phase 4
async function runBot() {
  // Validate environment
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedUserId = process.env.TELEGRAM_ALLOWED_USER_ID;
  
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN not set in environment');
  }
  
  if (!allowedUserId) {
    throw new Error('TELEGRAM_ALLOWED_USER_ID not set in environment');
  }
  
  const ctx = createContext('index', 'runBot');
  safeLogInfo(ctx, 'Initializing database');
  initDatabase();
  safeLogInfo(ctx, 'Database initialized');
  
  safeLogInfo(ctx, 'Initializing bot');
  await initBot(botToken, allowedUserId);
  safeLogInfo(ctx, 'Bot initialized');
  
  safeLogInfo(ctx, 'Starting bot');
  startBot();

  safeLogInfo(ctx, 'Starting background workers');
  startWorkers();
  
  // Keep process alive
  safeLogInfo(ctx, 'Bot is running');
}

main();
