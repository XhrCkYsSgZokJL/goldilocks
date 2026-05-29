-- Migration 014: collapse to a single Goldilocks plan.
--
-- There is now exactly one plan, priced per person — the two-tier "light"
-- vs "active" split is gone. This migration:
--
--   * Replaces the (billing_light_seats, billing_active_seats) pair on
--     `clients` with a single `billing_seats` count, summing the old two
--     so existing balances keep burning at a sensible rate (the actual
--     dollar rate changes — see ../src/billing/pricing.ts — but the new
--     count preserves the headcount).
--   * Does the same on `billing_checkouts.{light,active}_seats` →
--     `billing_checkouts.seats`, so the historical audit rows still
--     report how many people the top-up covered.
--   * Drops `clients.subscription_tier`. With only one plan there is no
--     value left to write into it — the seat count is the plan.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_seats INTEGER NOT NULL DEFAULT 0;
UPDATE clients
   SET billing_seats = COALESCE(billing_light_seats, 0) + COALESCE(billing_active_seats, 0)
 WHERE billing_seats = 0;
ALTER TABLE clients DROP COLUMN IF EXISTS billing_light_seats;
ALTER TABLE clients DROP COLUMN IF EXISTS billing_active_seats;
ALTER TABLE clients DROP COLUMN IF EXISTS subscription_tier;

ALTER TABLE billing_checkouts ADD COLUMN IF NOT EXISTS seats INTEGER NOT NULL DEFAULT 0;
UPDATE billing_checkouts
   SET seats = COALESCE(light_seats, 0) + COALESCE(active_seats, 0)
 WHERE seats = 0;
ALTER TABLE billing_checkouts DROP COLUMN IF EXISTS light_seats;
ALTER TABLE billing_checkouts DROP COLUMN IF EXISTS active_seats;
