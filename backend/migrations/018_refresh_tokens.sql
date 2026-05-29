-- Migration 018: refresh_tokens table (security plan item 11).
--
-- Adds short-lived access tokens + long-lived refresh tokens with
-- rotation and family-based theft detection (RFC 6819 §5.2.2.3).
-- The session JWT keeps short TTL (≤1h); refresh tokens TTL is 30 days.
-- The application layer (src/auth/refresh-tokens.ts) handles issuance,
-- rotation, and reuse-triggered family revocation.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY,
  family_id   UUID NOT NULL,
  parent_id   UUID,
  device_id   TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  inbox_id    TEXT,
  -- SHA-256 hex of the random 256-bit token. The plain token is never
  -- stored; a DB dump can't be replayed.
  token_hash  TEXT NOT NULL UNIQUE,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_device_idx ON refresh_tokens(device_id);
