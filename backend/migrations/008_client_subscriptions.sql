-- Migration 008: per-client subscription tiers.
--
-- A client's plan is managed with the `clients` CLI (npm run clients).
-- In the iOS Settings screen a client can *request* a tier; the request
-- lands in `requested_tier` for the team to approve or deny from the CLI.
-- Approving copies it into `subscription_tier`. The Custom tier ($199/hr)
-- is gated by `custom_tier_enabled` — a client can only request or be
-- placed on Custom once the team has unlocked it for them.
--
--   subscription_tier    the client's active plan (null = no plan)
--   requested_tier       a pending request awaiting approval (null = none)
--   custom_tier_enabled  unlocks the Custom tier for this client

ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscription_tier   TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS requested_tier      TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS custom_tier_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE clients ADD CONSTRAINT clients_subscription_tier_check
  CHECK (subscription_tier IS NULL OR subscription_tier IN ('light', 'active', 'custom'));
ALTER TABLE clients ADD CONSTRAINT clients_requested_tier_check
  CHECK (requested_tier IS NULL OR requested_tier IN ('light', 'active', 'custom'));
