-- Admin-controlled "client review" flag. Toggling it posts an audit line
-- to the Admins chat ("Admin #1 requested Client #4 review." / "… closed
-- … review."). State lives here so every admin sees the same toggle.
ALTER TABLE clients ADD COLUMN review_open BOOLEAN NOT NULL DEFAULT false;
