-- Unique referral code per client. Generated on first request via
-- GET /v2/me/referral. The code is a short alphanumeric slug used in
-- the shareable URL: https://goldilocksdigital.xyz/r/<code>
ALTER TABLE clients ADD COLUMN referral_code TEXT UNIQUE;

-- Index for fast lookup when someone visits /r/<code>.
CREATE INDEX idx_clients_referral_code ON clients (referral_code) WHERE referral_code IS NOT NULL;

-- Referral tracking: who referred whom.
CREATE TABLE referrals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  referred_client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (referred_client_id)
);
