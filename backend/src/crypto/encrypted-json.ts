// Drizzle column codec for at-rest encrypted JSON values.
//
// Stores a JSON value (object, array, scalar) as encrypted text using the
// same v1 envelope as `encryptedText`. The codec serialises with
// `JSON.stringify` before encrypting, and parses on read after decrypting.
//
// Use this in src/db/schema.ts where you would have used `jsonb(...)` for
// a sensitive value the database does not need to query into. Example —
// the array of HMAC keys per push subscription:
//
//   hmacKeys: encryptedJson<HmacKey[]>('hmac_keys', 'subscriptions.hmac_keys')
//     .notNull().default([])
//
// Read tolerance: if the stored text is plain JSON without the v1
// envelope, it's parsed as-is. This lets us roll out encryption gradually
// — existing rows stay plaintext until they're touched or
// scripts/migrate-encrypt-columns.ts backfills.
//
// Write behaviour:
//   - If ENCRYPT_AT_REST_V1 !== 'true' → JSON-stringify and write through
//     as plaintext.
//   - Otherwise → JSON-stringify, encrypt with the per-column derived key.
//
// The physical column type must be `text` (not `jsonb`). Schema migration
// pattern:
//
//   ALTER TABLE <t>
//     ALTER COLUMN <c> TYPE text USING <c>::text,
//     ALTER COLUMN <c> SET DEFAULT '[]'::text;
//
// Design: docs/encryption-and-backup-plan.md F4.

import { customType } from 'drizzle-orm/pg-core';
import { decryptAtRest, encryptAtRest, isEncryptedAtRest } from './at-rest.js';

/**
 * Declare a drizzle column that stores a JSON-serialisable value as
 * at-rest-encrypted text.
 *
 * @typeParam T          The shape of the in-memory value the application
 *                       reads and writes (object, array, scalar, etc.).
 * @param columnName     Physical column name in Postgres. Must be declared
 *                       as `text` (or `text NOT NULL DEFAULT '[]'` etc.).
 * @param label          Domain-separation label HKDF'd into the per-column
 *                       derived key. Convention: `'<table>.<column>'`. Do
 *                       not change once data exists.
 */
export function encryptedJson<T>(columnName: string, label: string) {
  return customType<{ data: T; driverData: string }>({
    dataType() {
      return 'text';
    },
    toDriver(value: T): string {
      const serialised = JSON.stringify(value);
      if (process.env.ENCRYPT_AT_REST_V1 !== 'true') return serialised;
      return encryptAtRest(serialised, label);
    },
    fromDriver(value: string): T {
      const text = isEncryptedAtRest(value) ? decryptAtRest(value, label) : value;
      return JSON.parse(text) as T;
    },
  })(columnName);
}
