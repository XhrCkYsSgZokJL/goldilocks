// Drizzle column codec for at-rest encryption.
//
// Use `encryptedText('column_name', 'table.column')` in src/db/schema.ts
// instead of `text('column_name')`. The codec transparently encrypts on
// write and decrypts on read, so call sites elsewhere in the app keep
// dealing in plaintext.
//
// Read tolerance: if the value coming back from Postgres does NOT carry
// the v1 envelope, the codec returns it as-is. This lets us roll out
// the feature gradually: existing rows stay plaintext until they're
// touched, the migration script (scripts/migrate-encrypt-columns.ts)
// backfills the rest.
//
// Write behavior:
//   - If ENCRYPT_AT_REST_V1 !== 'true' → write the plaintext through
//     (lets us turn the feature off if something goes wrong, without
//     a code revert).
//   - If the value is already encrypted (re-saving from a migration) →
//     write it back unchanged.
//   - Otherwise → encrypt.
//
// Design: docs/encryption-and-backup-plan.md F4.

import { customType } from 'drizzle-orm/pg-core';
import { decryptAtRest, encryptAtRest, isEncryptedAtRest } from './at-rest.js';

/**
 * Declare a drizzle text column that is transparently encrypted at rest.
 *
 * @param columnName  Physical column name in Postgres (same as you'd
 *                    pass to `text(name)`).
 * @param label       Domain-separation label HKDF'd into the per-column
 *                    derived key. Convention: `'<table>.<column>'`. This
 *                    string is part of the cryptographic boundary — do
 *                    NOT change it once data has been encrypted, or
 *                    every existing row becomes unreadable.
 */
export function encryptedText(columnName: string, label: string) {
  return customType<{ data: string; driverData: string }>({
    dataType() {
      return 'text';
    },
    toDriver(value: string) {
      if (process.env.ENCRYPT_AT_REST_V1 !== 'true') return value;
      if (isEncryptedAtRest(value)) return value;
      return encryptAtRest(value, label);
    },
    fromDriver(value: string) {
      if (isEncryptedAtRest(value)) return decryptAtRest(value, label);
      return value;
    },
  })(columnName);
}
