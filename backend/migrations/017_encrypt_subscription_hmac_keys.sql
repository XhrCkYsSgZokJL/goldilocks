-- Migration 017: encrypt subscriptions.hmac_keys at rest (F4).
--
-- Wraps the per-subscription HMAC key array in the v1 at-rest envelope
-- so a database dump can't be replayed against push payloads. The
-- application-side codec lives in src/crypto/encrypted-json.ts and
-- transparently encrypts/decrypts; new rows pick up encryption as soon
-- as ENCRYPT_AT_REST_V1=true. Existing rows are backfilled by
-- scripts/migrate-encrypt-columns.ts.
--
-- This migration changes the physical column type from jsonb to text:
-- v1-enveloped ciphertext is opaque text, so the column can no longer
-- be queried as jsonb. The application has never queried into hmac_keys
-- (insert / upsert / read-whole-array only), so this is safe.
--
-- Notification-server compatibility note: the upstream XMTP example
-- notification server (xmtp/example-notification-server-go) reads this
-- column directly as jsonb. After this migration, that service needs
-- either (a) a forked version that JSON.parses text and tolerates the
-- v1 envelope, or (b) ENCRYPT_AT_REST_V1=false for envelopes to stay
-- plaintext until the integration is updated. Push delivery is deferred
-- in production today (the service is commented out in
-- docker-compose.prod.yml), so this does not affect any live consumer.
--
-- Design: docs/encryption-and-backup-plan.md F4, docs/plans/2026-05-29-security-hardening.md item 6.

ALTER TABLE subscriptions
  ALTER COLUMN hmac_keys DROP DEFAULT,
  ALTER COLUMN hmac_keys TYPE text USING hmac_keys::text,
  ALTER COLUMN hmac_keys SET DEFAULT '[]'::text;
