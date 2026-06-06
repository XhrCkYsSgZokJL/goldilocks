// Deterministic, keyed lookup hashes — for columns that need O(1)
// equality lookups but whose plaintext is also F4-encrypted at rest.
//
// Why this exists
// ----------------
// AES-256-GCM ciphertexts use a fresh random nonce on every encrypt call,
// so `WHERE encrypted_column = ?` can never match (the encoded query
// param gets a different nonce than the stored row). To preserve the
// at-rest property AND support equality lookups, we maintain a parallel
// hash column whose value is derived deterministically from the
// plaintext. The route looks up by the hash; the original encrypted
// column is still what gets read when the application needs the actual
// secret back.
//
// Construction
// ------------
//   key_lookup = HKDF-SHA256( APP_ENCRYPTION_KEY,
//                              salt  = "goldilocks/lookup/v1",
//                              info  = "<table>.<column>.lookup",
//                              size  = 32 )
//   hash       = HMAC-SHA256( key_lookup, plaintext )    // hex-encoded
//
// HKDF gives per-column domain separation in the same way the encryption
// codec does, with a separate salt so the lookup key can never collide
// with an encryption key even if the labels matched. The output is 64
// hex chars — easy to index, search, and print.
//
// Threat model
// ------------
// - Database dump alone: still secure. The hashes are keyed; without
//   `APP_ENCRYPTION_KEY` an attacker cannot pre-compute candidate
//   hashes for the 16-digit code space (10^16). They also cannot
//   decrypt the ciphertext column.
// - Master key alone: gives nothing — there's no DB to look up against.
// - Both: full disclosure, same as the encryption story. Acceptable.
// - Deterministic equality on the *lookup* column means an attacker
//   with `APP_ENCRYPTION_KEY` plus a guess can confirm whether that
//   guess appears in the table. The encryption story already grants
//   that capability, so no new leak.
//
// Design: docs/encryption-and-backup-plan.md F4.

import { createHmac, hkdfSync } from 'node:crypto';

const KEY_LEN = 32;
const HKDF_SALT = Buffer.from('goldilocks/lookup/v1');

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

function deriveLookupKey(label: string): Buffer {
  const out = hkdfSync('sha256', masterKey(), HKDF_SALT, label, KEY_LEN);
  return Buffer.from(out);
}

/**
 * Deterministic, keyed lookup hash for an encrypted column. Same input
 * always produces the same output; without the master key the output
 * cannot be pre-computed.
 *
 * @param plaintext  The cleartext value to hash. Trim / normalise the
 *                   input the same way at insert time and at lookup
 *                   time, or matches will silently fail.
 * @param label      `'<table>.<column>'`. Don't change once data exists
 *                   — the lookup column becomes unreadable.
 * @returns          Lowercase hex string, 64 chars.
 */
export function lookupHash(plaintext: string, label: string): string {
  const key = deriveLookupKey(label);
  return createHmac('sha256', key).update(plaintext, 'utf8').digest('hex');
}

/** Test-only: drop the cached master key so a test can swap APP_ENCRYPTION_KEY. */
export function _resetLookupKeyCacheForTests(): void {
  cachedMasterKey = null;
}
