// At-rest column encryption primitive.
//
// AES-256-GCM with a per-column derived key. The master is the 32-byte
// `APP_ENCRYPTION_KEY` (hex in .env, mounted via SOPS); each call derives
// a column-specific 32-byte key from it via HKDF-SHA256 using the column
// label as the info parameter. That domain separation means a leaked
// ciphertext from one column can't be replayed against another.
//
// Wire format (one text column, no schema change required):
//
//   v1.<nonce-b64>.<ciphertext+tag-b64>
//
// `isEncryptedAtRest` lets readers tolerate mixed-format data during the
// rollout — see src/crypto/encrypted-text.ts for the drizzle codec
// that uses it.
//
// Design: docs/encryption-and-backup-plan.md F4.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const NONCE_LEN = 12; // AES-GCM standard 96-bit nonce
const TAG_LEN = 16; // AES-GCM 128-bit auth tag
const KEY_LEN = 32; // 256-bit derived key
const VERSION = 'v1';
const PREFIX = `${VERSION}.`;
const HKDF_SALT = Buffer.from('goldilocks/at-rest/v1');

let cachedMasterKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const hex = process.env.APP_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'APP_ENCRYPTION_KEY must be 64 hex chars (set via Settings → Run setup, or `openssl rand -hex 32`).',
    );
  }
  cachedMasterKey = Buffer.from(hex, 'hex');
  return cachedMasterKey;
}

function deriveKey(label: string): Buffer {
  const out = hkdfSync('sha256', masterKey(), HKDF_SALT, label, KEY_LEN);
  return Buffer.from(out);
}

/** True iff the value carries the v1 at-rest envelope prefix. */
export function isEncryptedAtRest(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypt a UTF-8 string. The label binds the ciphertext to a single column. */
export function encryptAtRest(plaintext: string, label: string): string {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(label), nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([ct, tag]).toString('base64');
  return `${PREFIX}${nonce.toString('base64')}.${body}`;
}

/**
 * Decrypt a value previously produced by `encryptAtRest`. Throws if
 * the value doesn't carry the v1 envelope or the auth tag fails to
 * verify (tampered ciphertext, wrong key, wrong label).
 */
export function decryptAtRest(ciphertext: string, label: string): string {
  if (!isEncryptedAtRest(ciphertext)) {
    throw new Error('value is not encrypted at rest (missing v1. prefix)');
  }
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error('invalid at-rest ciphertext format');
  }
  const nonceB64 = parts[1];
  const bodyB64 = parts[2];
  if (nonceB64 === undefined || bodyB64 === undefined) {
    throw new Error('invalid at-rest ciphertext format');
  }
  const nonce = Buffer.from(nonceB64, 'base64');
  const body = Buffer.from(bodyB64, 'base64');
  if (nonce.length !== NONCE_LEN || body.length < TAG_LEN) {
    throw new Error('invalid at-rest ciphertext length');
  }
  const ct = body.subarray(0, body.length - TAG_LEN);
  const tag = body.subarray(body.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(label), nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Clear the cached master key. Tests use this when they want to swap
 * APP_ENCRYPTION_KEY after the module has already been loaded. Not
 * intended for runtime use — the master key never rotates at runtime.
 */
export function _resetMasterKeyCacheForTests(): void {
  cachedMasterKey = null;
}
