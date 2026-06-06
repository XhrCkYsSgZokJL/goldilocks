-- Migration 020: require upgrade_code_lookup on every admin slot.
--
-- We can't go straight to `SET NOT NULL` in one step: the backfill
-- script that populates the column lives at the application layer
-- (decryption needs APP_ENCRYPTION_KEY), and the migrate runner applies
-- SQL migrations *before* running app-level backfills. If we ship a
-- one-step `NOT NULL`, the migration would fail on every install whose
-- first deploy includes both 019 and 020 — because the backfill hasn't
-- had a chance to run yet.
--
-- Instead: add a CHECK constraint as `NOT VALID`. Postgres semantics —
--   • Existing rows are skipped (so pre-019 admin slots with NULL
--     lookups don't make the migration fail).
--   • Every NEW insert must satisfy the predicate or be rejected.
--   • The constraint can be VALIDATEd later once the operator confirms
--     the backfill has touched every row. Application code attempts
--     that validation at the end of every successful backfill pass
--     (src/db/backfill-admin-upgrade-lookups.ts) — first deploy after
--     a clean backfill flips the constraint to fully enforced.
--
-- Design: docs/security-architecture.md, docs/encryption-and-backup-plan.md F4.

ALTER TABLE admin_inboxes
  ADD CONSTRAINT admin_inboxes_lookup_required
  CHECK (upgrade_code_lookup IS NOT NULL)
  NOT VALID;
