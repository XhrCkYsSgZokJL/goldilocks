-- Migration 011: Stripe billing.
--
-- Adds the columns that link a client to their Stripe records and tracks
-- every Checkout Session we create. Two billing shapes are supported:
--
--   recurring — an auto-renewing Stripe subscription. Stripe owns the
--               renewal cycle; `stripe_subscription_id` points at it and
--               `billing_status` mirrors the subscription's state.
--   monthly   — a one-time payment that prepays a fixed block of months
--               (1, 3, 6, 9, or 12). There is no Stripe subscription;
--               `billing_paid_through` records when the block runs out.
--
-- `billing_checkouts` is the audit trail: one row per Checkout Session,
-- created `pending` and flipped to `completed` by the Stripe webhook.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
-- 'active' | 'past_due' | 'canceled' — null until the first paid checkout.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_status         TEXT;
-- Coverage end for a prepaid 'monthly' block. Null for recurring plans.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_paid_through   TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS billing_checkouts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  stripe_session_id   TEXT NOT NULL UNIQUE,
  -- Stripe Checkout mode: 'subscription' (recurring) or 'payment' (one-time).
  mode                TEXT NOT NULL,
  -- App-level billing shape the client picked: 'recurring' | 'monthly'.
  cadence             TEXT NOT NULL,
  -- 'card' | 'crypto'. Only 'card' is wired up; 'crypto' is reserved.
  payment_method      TEXT NOT NULL DEFAULT 'card',
  -- Prepaid block length in months for 'monthly'; null for recurring.
  duration_months     INTEGER,
  light_seats         INTEGER NOT NULL DEFAULT 0,
  active_seats        INTEGER NOT NULL DEFAULT 0,
  -- Total the session charges, in cents. For recurring this is the
  -- monthly amount; for a prepaid block it is monthly x duration_months.
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'usd',
  -- 'pending' | 'completed' | 'expired'.
  status              TEXT NOT NULL DEFAULT 'pending',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS billing_checkouts_client_idx
  ON billing_checkouts (client_id);
