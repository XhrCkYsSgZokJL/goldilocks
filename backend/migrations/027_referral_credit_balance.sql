-- Separate referral credit balance. Drawn before the prepaid balance
-- on person activation and monthly ticks.
ALTER TABLE clients ADD COLUMN referral_credit_cents INTEGER NOT NULL DEFAULT 0;
