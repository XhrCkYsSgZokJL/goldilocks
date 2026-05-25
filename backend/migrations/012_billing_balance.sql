-- Migration 012: prepaid-balance billing.
--
-- Replaces the recurring/one-time split (migration 011) with a single
-- prepaid-balance model:
--
--   * The client tops up a balance by buying 1, 3, or 6 months of cover
--     at the current monthly rate.
--   * The people list sets the monthly rate. The balance drains at that
--     rate; `billing_balance_as_of` is the last time the balance was
--     settled, so "active until" = as_of + (balance / rate).
--   * Editing the people list re-settles the balance and changes the
--     rate — no charge, the coverage date just moves.
--   * Cancelling refunds the unused balance (Stripe partial refund).
--
-- There is no auto-renewing subscription any more, so the recurring-era
-- columns are dropped.

ALTER TABLE clients DROP COLUMN IF EXISTS stripe_subscription_id;
ALTER TABLE clients DROP COLUMN IF EXISTS billing_status;
ALTER TABLE clients DROP COLUMN IF EXISTS billing_paid_through;

-- Prepaid balance in cents, and the seat mix that sets the burn rate.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_balance_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_light_seats   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_active_seats  INTEGER NOT NULL DEFAULT 0;
-- When billing_balance_cents was last settled. Null until the first
-- top-up. "active until" is derived from this + balance + rate.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_balance_as_of TIMESTAMPTZ;

-- Refund support: the PaymentIntent to refund against, and how much of
-- this checkout's charge has already been refunded.
ALTER TABLE billing_checkouts ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE billing_checkouts ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0;

-- The recurring/one-time split is gone — every checkout is now a top-up.
-- Drop the columns that described it (both were NOT NULL, so leaving them
-- would break inserts that no longer supply them).
ALTER TABLE billing_checkouts DROP COLUMN IF EXISTS mode;
ALTER TABLE billing_checkouts DROP COLUMN IF EXISTS cadence;
