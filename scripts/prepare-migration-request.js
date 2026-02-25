import { mkdir, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { generateKeyPairSync, randomUUID } from 'crypto';

import {
  MIGRATION_DIR,
  formatFingerprint,
  getPublicKeyFingerprint,
  parseArgs,
  parsePositiveInt,
  resolvePathFromCwd
} from './migration-common.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ttlMinutes = parsePositiveInt(args['ttl-minutes'], 30);

  const requestId = randomUUID();
  const defaultRequestPath = join(MIGRATION_DIR, `request-${requestId}.json`);
  const requestPath = args.request ? resolvePathFromCwd(args.request) : defaultRequestPath;
  const defaultPrivateKeyPath = requestPath.endsWith('.json')
    ? requestPath.slice(0, -5) + '.private.pem'
    : `${requestPath}.private.pem`;
  const privateKeyPath = args['private-key'] ? resolvePathFromCwd(args['private-key']) : defaultPrivateKeyPath;

  await mkdir(MIGRATION_DIR, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60_000);
  const fingerprint = getPublicKeyFingerprint(publicKey);

  const request = {
    version: 'migration-request-v1',
    requestId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    algorithm: 'rsa-oaep-sha256+aes-256-gcm',
    publicKeyFingerprint: fingerprint,
    publicKeyPem: publicKey,
    privateKeyFile: basename(privateKeyPath)
  };

  await writeFile(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
  await writeFile(requestPath, JSON.stringify(request, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });

  console.log('Migration request created.');
  console.log(`Request file: ${requestPath}`);
  console.log(`Private key file: ${privateKeyPath}`);
  console.log(`Request ID: ${requestId}`);
  console.log(`Expires at: ${request.expiresAt}`);
  console.log(`Public key fingerprint (SHA-256): ${formatFingerprint(fingerprint)}`);
  console.log('Transfer only the request JSON to the source device.');
}

main().catch((error) => {
  console.error(`prepare-migration-request failed: ${error?.message || error}`);
  process.exit(1);
});
