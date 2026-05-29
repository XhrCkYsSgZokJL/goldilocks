-- Subscriptions simplified: no "request" flow, and no Custom plan.
-- A client's plan is now just 'light', 'active', or null (no plan).
ALTER TABLE clients DROP COLUMN IF EXISTS requested_tier;
ALTER TABLE clients DROP COLUMN IF EXISTS custom_tier_enabled;
