-- Regenerate any non-numeric referral codes to 6-digit zero-padded numbers.
UPDATE clients
SET referral_code = LPAD(FLOOR(RANDOM() * 1000000)::int::text, 6, '0')
WHERE referral_code IS NOT NULL
  AND referral_code !~ '^\d{6}$';
