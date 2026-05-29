// Idempotent backfill for admin_inboxes.upgrade_code_lookup. Lives in
// `src/` (not `scripts/`) so it's part of the production build and can
// be invoked from `src/db/migrate.ts` after SQL migrations apply.
//
// The lookup column was added by migration 019. Every row needs a
// deterministic keyed hash of its plaintext upgrade code so the
// /v2/admin/upgrade endpoint can do O(1) lookups against an at-rest
// encrypted column. Application code populates the column on new
// inserts; this backfill catches rows that predate migration 019.
//
// Design: docs/encryption-and-backup-plan.md F4,
//         migrations/019_admin_upgrade_code_lookup.sql.

import { eq, isNull } from 'drizzle-orm';
import { db, pool } from './client.js';
import { adminInboxes } from './schema.js';
import { lookupHash } from '../crypto/lookup-hash.js';

const LABEL = 'admin_inboxes.upgrade_code.lookup';

export interface BackfillResult {
  scanned: number;
  updated: number;
}

export async function backfillAdminUpgradeLookups(
  log: (msg: string) => void = console.log,
): Promise<BackfillResult> {
  // Drizzle's encryptedText codec decrypts upgrade_code transparently
  // on read, so `row.upgradeCode` is plaintext here regardless of
  // whether the underlying column holds v1-enveloped ciphertext or
  // legacy plaintext.
  const rows = await db
    .select()
    .from(adminInboxes)
    .where(isNull(adminInboxes.upgradeCodeLookup));

  let updated = 0;
  for (const row of rows) {
    const hash = lookupHash(row.upgradeCode, LABEL);
    await db
      .update(adminInboxes)
      .set({ upgradeCodeLookup: hash })
      .where(eq(adminInboxes.id, row.id));
    updated++;
  }
  if (updated > 0) {
    log(`[backfill-admin-upgrade-lookups] wrote ${updated}/${rows.length} row(s)`);
  }

  // Migration 020 added the lookup-required CHECK as NOT VALID. Once
  // every row carries a hash, we VALIDATE the constraint so Postgres
  // retroactively enforces it on the table — turning silent data drift
  // into a loud INSERT error. Idempotent: VALIDATE on an
  // already-validated constraint is a no-op.
  try {
    await pool.query('ALTER TABLE admin_inboxes VALIDATE CONSTRAINT admin_inboxes_lookup_required');
  } catch (err) {
    // The constraint doesn't exist yet on databases that haven't taken
    // migration 020 (or have moved past it on a future migration that
    // replaces it). Swallow that case; surface anything else.
    const message = (err as { code?: string; message?: string }).message ?? '';
    if (!/does not exist/i.test(message)) {
      log(`[backfill-admin-upgrade-lookups] could not validate constraint: ${message}`);
    }
  }

  return { scanned: rows.length, updated };
}
