import { ethers } from 'ethers';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { CLOB_API_URL, POLYGON_CHAIN_ID } from './constants.js';
import { createContext, safeLogInfo, safeLogWarn } from './logger.js';

// Lazy import for node-machine-id (CommonJS compatibility)
async function getMachineIdModule() {
  const module = await import('node-machine-id');
  return module.default || module;
}
// TODO: Circular import with config.js - config.js uses dynamic imports
// for decrypt/getMachineKey to break the cycle. auth.js imports saveConfig
// at top-level because initializeWallet needs it synchronously.
// Full refactor to remove cycle deferred to later phase.
import { saveConfig } from './config.js';

const ENCRYPTION_VERSION = 'v2';
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

// Generate new EVM private key
export async function generatePrivateKey() {
  const wallet = ethers.Wallet.createRandom();
  return {
    privateKey: wallet.privateKey,
    address: wallet.address
  };
}

// Create L2 API credentials using SDK
// SDK is loaded lazily via dynamic import to avoid runtime errors in Phase 1
export async function createL2Credentials(privateKey) {
  // Dynamic import to avoid top-level SDK dependency
  const { ClobClient } = await import('@polymarket/clob-client');
  
  // Create a temporary wallet for L2 credential creation
  const signer = new ethers.Wallet(privateKey);
  
  // Initialize ClobClient with minimal config to access createApiKey/deriveApiKey
  const client = new ClobClient(
    CLOB_API_URL,
    POLYGON_CHAIN_ID,
    signer,
    undefined, // No creds yet
    0, // signature_type: EOA
    signer.address // funder: same as signer
  );
  
  // Try to create or derive API key
  // SDK returns { key, secret, passphrase } (not apiKey)
  const apiCreds = await client.createOrDeriveApiKey();
  
  return {
    apiKey: apiCreds.key,
    secret: apiCreds.secret,
    passphrase: apiCreds.passphrase
  };
}

// Get machine-specific encryption key
export async function getMachineKey() {
  try {
    const mod = await getMachineIdModule();
    const id = await mod.machineId();
    return scryptSync(id, 'polymarket-bot-salt-v1', 32);
  } catch (error) {
    const ctx = createContext('auth', 'getMachineKey');
    safeLogWarn(ctx, 'Machine ID unavailable, refusing to start', { message: error?.message });
    const e = new Error('Machine ID is not available. Startup aborted for security reasons.');
    e.code = 'MACHINE_ID_UNAVAILABLE';
    throw e;
  }
}

function assertAes256Key(key) {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    throw new Error(`Encryption key must be ${AES_KEY_BYTES} bytes`);
  }
}

function decodeBase64Strict(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid encrypted data format: ${fieldName} is empty`);
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid encrypted data format: ${fieldName} is not valid base64`);
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) {
    throw new Error(`Invalid encrypted data format: ${fieldName} base64 is corrupted`);
  }
  return buffer;
}

// Encrypt data using AES-256-GCM.
export async function encrypt(data, key) {
  assertAes256Key(key);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  let encrypted = cipher.update(data, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');
  return `${ENCRYPTION_VERSION}:${iv.toString('base64')}:${encrypted}:${authTag}`;
}

// Decrypt data
export async function decrypt(encryptedData, key) {
  assertAes256Key(key);

  if (typeof encryptedData !== 'string') {
    throw new Error('Invalid encrypted data format: expected string');
  }

  const parts = encryptedData.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted data format: expected v2:iv:ciphertext:tag');
  }

  const [version, ivBase64, ciphertextBase64, authTagBase64] = parts;
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encrypted data version: ${version || 'unknown'}`);
  }

  const iv = decodeBase64Strict(ivBase64, 'iv');
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(`Invalid encrypted data format: iv must be ${GCM_IV_BYTES} bytes`);
  }

  const authTag = decodeBase64Strict(authTagBase64, 'authTag');
  if (authTag.length !== GCM_TAG_BYTES) {
    throw new Error(`Invalid encrypted data format: authTag must be ${GCM_TAG_BYTES} bytes`);
  }

  // ciphertext can be empty for empty plaintext, so keep base64 validation separate.
  if (typeof ciphertextBase64 !== 'string' || ciphertextBase64.length === 0) {
    throw new Error('Invalid encrypted data format: ciphertext is empty');
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(ciphertextBase64) || ciphertextBase64.length % 4 !== 0) {
    throw new Error('Invalid encrypted data format: ciphertext is not valid base64');
  }
  const ciphertextBuffer = Buffer.from(ciphertextBase64, 'base64');
  if (ciphertextBuffer.toString('base64') !== ciphertextBase64) {
    throw new Error('Invalid encrypted data format: ciphertext base64 is corrupted');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertextBase64, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    throw new Error(`Failed to decrypt data: ${error?.message || error}`);
  }
}

// Initialize wallet on first run
// Phase 1: Minimal skeleton only - no allowances/trading yet
export async function initializeWallet() {
  const ctx = createContext('auth', 'initializeWallet');
  safeLogInfo(ctx, 'Initializing new wallet');
  
  // 1. Generate private key
  const { privateKey, address } = await generatePrivateKey();
  
  // 2. Get encryption key
  const machineKey = await getMachineKey();
  
  // 3. Encrypt private key
  const encryptedPrivateKey = await encrypt(privateKey, machineKey);
  
  // 4. Create L2 credentials with retry logic
  let l2Creds;
  const delays = [1000, 2000, 4000]; // 1s, 2s, 4s
  
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      l2Creds = await createL2Credentials(privateKey);
      safeLogInfo(ctx, 'L2 credentials created successfully');
      break;
    } catch (error) {
      if (attempt < delays.length) {
        safeLogWarn(ctx, 'L2 credentials creation failed, retrying', {
          attempt: attempt + 1,
          delayMs: delays[attempt]
        });
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      } else {
        throw new Error(`Failed to create L2 credentials after ${delays.length + 1} attempts: ${error.message}`);
      }
    }
  }
  
  const encryptedL2Credentials = {
    apiKey: await encrypt(l2Creds.apiKey, machineKey),
    secret: await encrypt(l2Creds.secret, machineKey),
    passphrase: await encrypt(l2Creds.passphrase, machineKey)
  };
  
  // 5. Create config object
  const config = {
    encrypted: {
      privateKey: encryptedPrivateKey,
      l2Credentials: encryptedL2Credentials
    },
    walletAddress: address,
    language: 'ru',
    strategies: {
      stopLoss: -10,
      takeProfit: 30
    },
    notifications: {
      priceChangePercent: 10,
      priceRepeatStepPercent: 2,
      alertCooldownSeconds: 300
    }
  };
  
  // 6. Save encrypted config
  await saveConfig(config);
  
  // 7. Return wallet info for display
  return {
    address,
    warning: `⚠️ ВНИМАНИЕ!
Создан новый кошелёк для Polymarket.
Адрес: ${address}

ЭТО НОВЫЙ КОШЕЛЁК. Пополните его отдельно.
НЕ ИСПОЛЬЗУЙТЕ ваш основной кошелёк!

Экспортируйте и сохраните приватный ключ (Настройки → Экспорт ключа).
При переустановке ОС или переносе на новое устройство доступ к кошельку может быть потерян.`
  };
}

// Get decrypted private key (moved from config.js to keep config module clean)
export async function getDecryptedPrivateKey() {
  const { loadConfig } = await import('./config.js');
  const config = await loadConfig();
  
  if (!config.encrypted?.privateKey) {
    throw new Error('Private key not found in config');
  }
  
  const machineKey = await getMachineKey();
  return await decrypt(config.encrypted.privateKey, machineKey);
}

// Get decrypted L2 credentials (moved from config.js to keep config module clean)
export async function getDecryptedL2Credentials() {
  const { loadConfig } = await import('./config.js');
  const config = await loadConfig();
  
  const encryptedCreds = config.encrypted?.l2Credentials;
  const encryptedApiKey = encryptedCreds?.apiKey || encryptedCreds?.key;
  const encryptedSecret = encryptedCreds?.secret;
  const encryptedPassphrase = encryptedCreds?.passphrase;

  if (!encryptedApiKey || !encryptedSecret || !encryptedPassphrase) {
    throw new Error('L2 credentials not found in config');
  }
  
  const machineKey = await getMachineKey();
  const key = await decrypt(encryptedApiKey, machineKey);
  const secret = await decrypt(encryptedSecret, machineKey);
  const passphrase = await decrypt(encryptedPassphrase, machineKey);
  
  return {
    // Keep both names for backward compatibility in callers.
    key,
    apiKey: key,
    secret,
    passphrase
  };
}
