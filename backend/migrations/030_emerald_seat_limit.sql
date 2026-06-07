-- Per-client Emerald seat allowance. Emerald clients are billed externally
-- (no Stripe card or subscription); this caps how many people they can
-- enable. 0 means no Emerald allowance has been granted.
ALTER TABLE clients ADD COLUMN emerald_seat_limit INTEGER NOT NULL DEFAULT 0;
