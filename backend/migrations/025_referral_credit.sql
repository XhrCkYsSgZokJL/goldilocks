-- Track whether the referral credit has been applied.
-- referrerCreditAppliedAt: when the $50 credit was added to the referrer's balance.
-- referredDiscountAppliedAt: when the $50 discount was applied to the referred client's first checkout.
ALTER TABLE referrals ADD COLUMN referrer_credit_applied_at TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN referred_discount_applied_at TIMESTAMPTZ;
