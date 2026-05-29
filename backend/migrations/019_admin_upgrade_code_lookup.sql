-- Migration 019: deterministic lookup column for admin_inboxes.upgrade_code.
--
-- The `upgrade_code` column has been F4-encrypted since migration 008.
-- Equality filters (`WHERE upgrade_code = $1`) silently never match
-- once ENCRYPT_AT_REST_V1 is on because every encrypt call uses a fresh
-- AES-GCM nonce. The UNIQUE constraint added in migration 007 stopped
-- enforcing anything for the same reason.
--
-- This migration adds a deterministic keyed-HMAC sidecar column that
-- the application uses for O(1) equality lookups, and replaces the
-- broken UNIQUE on `upgrade_code` with a real UNIQUE on the new column.
--
-- The new column is initially nullable so existing rows aren't
-- rejected; scripts/backfill-admin-upgrade-lookups.ts walks every row,
-- decrypts the upgrade code via the drizzle codec, computes the
-- lookup hash with src/crypto/lookup-hash.ts, and writes it back.
-- After the backfill runs, application code only inserts rows with the
-- lookup column populated, so a follow-up migration can make it
-- NOT NULL once you've confirmed every row carries a value.
--
-- Design: docs/encryption-and-backup-plan.md F4,
--         docs/plans/2026-05-29-security-hardening.md item 6 follow-up.

ALTER TABLE admin_inboxes
  ADD COLUMN IF NOT EXISTS upgrade_code_lookup TEXT;

-- Drop the constraint that hasn't enforced uniqueness since encryption
-- was enabled. The new UNIQUE INDEX on `upgrade_code_lookup` is the
-- real one.
ALTER TABLE admin_inboxes
  DROP CONSTRAINT IF EXISTS admin_inboxes_upgrade_code_key;

-- Partial unique index: enforce uniqueness on the lookup column where
-- it's populated. The predicate keeps the index from rejecting the
-- pre-backfill rows whose `upgrade_code_lookup` is still NULL.
CREATE UNIQUE INDEX IF NOT EXISTS admin_inboxes_upgrade_code_lookup_uniq
  ON admin_inboxes (upgrade_code_lookup)
  WHERE upgrade_code_lookup IS NOT NULL;
