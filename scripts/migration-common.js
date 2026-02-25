import { readFile } from 'fs/promises';
import { createHash, createPublicKey } from 'crypto';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ROOT = join(__dirname, '..');
export const MIGRATION_DIR = join(ROOT, 'data', 'migration');

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

export function parsePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

export function normalizeFingerprint(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '');
}

export function formatFingerprint(value) {
  const normalized = normalizeFingerprint(value);
  return normalized.replace(/(.{4})/g, '$1 ').trim();
}

export function getPublicKeyFingerprint(publicKeyPem) {
  const keyObject = createPublicKey(publicKeyPem);
  const der = keyObject.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').toUpperCase();
}

export async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

export function resolvePathFromCwd(pathValue) {
  return resolve(process.cwd(), String(pathValue || '').trim());
}

export function decodeBase64(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${fieldName}: empty`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(`Invalid ${fieldName}: corrupted base64`);
  }
  return decoded;
}
