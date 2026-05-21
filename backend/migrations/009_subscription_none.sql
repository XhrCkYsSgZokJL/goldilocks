-- Migration 009: allow "no plan" as a requestable subscription state.
--
-- A client can now request to be moved off all plans from the iOS
-- Settings screen. That request lands in `requested_tier` as 'none',
-- awaiting team approval like any other tier change.
--
-- The active `subscription_tier` still uses NULL (never 'none') to mean
-- "no plan" — approving a 'none' request clears subscription_tier back to
-- NULL. So only `requested_tier`'s check constraint needs to widen.

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_requested_tier_check;
ALTER TABLE clients ADD CONSTRAINT clients_requested_tier_check
  CHECK (requested_tier IS NULL OR requested_tier IN ('none', 'light', 'active', 'custom'));
