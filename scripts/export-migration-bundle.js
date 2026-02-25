import { randomBytes, createCipheriv, publicEncrypt, constants } from 'crypto';
import { writeFile } from 'fs/promises';
import { join } from 'path';

import { loadConfig } from '../src/modules/config.js';
import { getDecryptedL2Credentials, getDecryptedPrivateKey } from '../src/modules/auth.js';
import {
  formatFingerprint,
  getPublicKeyFingerprint,
  parseArgs,
  readJson,
  resolvePathFromCwd,
  normalizeFingerprint
} from './migration-common.js';

function ensureRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new Error('Invalid migration request payload');
  }
  if (request.version !== 'migration-request-v1') {
    throw new Error(`Unsupported request version: ${request.version || 'unknown'}`);
  }
  if (!request.requestId || !request.publicKeyPem || !request.publicKeyFingerprint) {
    throw new Error('Migration request is missing required fields');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestArg = args.request;
  if (!requestArg) {
    throw new Error('Usage: node scripts/export-migration-bundle.js --request <request.json> --fingerprint <sha256>');
  }

  const requestPath = resolvePathFromCwd(requestArg);
  const request = await readJson(requestPath);
  ensureRequest(request);

  const expectedFingerprint = normalizeFingerprint(request.publicKeyFingerprint);
  const actualFingerprint = getPublicKeyFingerprint(request.publicKeyPem);
  if (normalizeFingerprint(actualFingerprint) !== expectedFingerprint) {
    throw new Error('Migration request fingerprint mismatch');
  }

  const providedFingerprint = normalizeFingerprint(args.fingerprint);
  if (!providedFingerprint) {
    throw new Error(
      `Fingerprint confirmation is required. Use --fingerprint ${formatFingerprint(actualFingerprint)}`
    );
  }
  if (providedFingerprint !== expectedFingerprint) {
    throw new Error('Provided --fingerprint does not match migration request fingerprint');
  }

  const expiresAtMs = Date.parse(String(request.expiresAt || ''));
  if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs && !args['allow-expired']) {
    throw new Error('Migration request is expired. Re-run with --allow-expired only if you trust this request.');
  }

  const config = await loadConfig();
  const privateKey = await getDecryptedPrivateKey();
  const l2 = await getDecryptedL2Credentials();

  const { encrypted: _ignoreEncrypted, ...configWithoutSecrets } = config;
  void _ignoreEncrypted;

  const payload = {
    version: 'migration-payload-v1',
    requestId: request.requestId,
    createdAt: new Date().toISOString(),
    walletAddress: config.walletAddress || '',
    privateKey,
    l2Credentials: {
      apiKey: l2.apiKey || l2.key || '',
      secret: l2.secret || '',
      passphrase: l2.passphrase || ''
    },
    config: configWithoutSecrets
  };

  if (!payload.privateKey || !payload.l2Credentials.apiKey || !payload.l2Credentials.secret || !payload.l2Credentials.passphrase) {
    throw new Error('Cannot export migration bundle: wallet credentials are incomplete');
  }

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const encryptedKey = publicEncrypt(
    {
      key: request.publicKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    aesKey
  );

  const bundle = {
    version: 'migration-bundle-v1',
    requestId: request.requestId,
    createdAt: new Date().toISOString(),
    publicKeyFingerprint: actualFingerprint,
    algorithm: 'rsa-oaep-sha256+aes-256-gcm',
    encryptedKey: encryptedKey.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };

  const outputPath = args.output
    ? resolvePathFromCwd(args.output)
    : resolvePathFromCwd(join('.', `migration-bundle-${request.requestId}.json`));

  await writeFile(outputPath, JSON.stringify(bundle, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });

  console.log('Migration bundle created.');
  console.log(`Bundle file: ${outputPath}`);
  console.log(`Request ID: ${request.requestId}`);
  console.log(`Fingerprint: ${formatFingerprint(actualFingerprint)}`);
  console.log('Copy this bundle file to the target server and run apply-migration-bundle there.');
}

main().catch((error) => {
  console.error(`export-migration-bundle failed: ${error?.message || error}`);
  process.exit(1);
});
