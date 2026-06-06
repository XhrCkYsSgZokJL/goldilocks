-- Stripe subscription billing. Replaces the prepaid-balance model with a
-- single per-seat subscription per client ($100/mo × enabled seats) plus a
-- flat one-time $100 initial-report fee when a new person is enabled.
--
-- The prepaid-balance columns (billing_balance_cents, billing_balance_as_of,
-- billing_seats, last_balance_tick_at) are now deprecated but left in place;
-- they are dropped in a later migration once all read paths are migrated.

-- Per-client subscription handles.
ALTER TABLE clients ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE clients ADD COLUMN stripe_subscription_item_id TEXT;
-- Whether the client has a saved card (set once they complete the Stripe
-- setup checkout). Gates enabling people, since the $100 fee and recurring
-- charges are taken off-session.
ALTER TABLE clients ADD COLUMN has_payment_method BOOLEAN NOT NULL DEFAULT false;

-- Per-person initial-fee + recurring-window tracking.
ALTER TABLE covered_persons ADD COLUMN initial_fee_paid_at TIMESTAMPTZ;
ALTER TABLE covered_persons ADD COLUMN recurring_starts_at TIMESTAMPTZ;
