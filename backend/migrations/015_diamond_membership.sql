-- Migration 015: admin-toggled Diamond membership.
--
-- Diamond is a fourth membership tier above Gold, but unlike the
-- automatic Bronze/Silver/Gold rules (driven by seat count + active
-- coverage) Diamond is an explicit per-client flag a Goldilocks
-- admin can flip on or off from the Advisory chat. When `true`,
-- the client's tier is Diamond regardless of their seat count or
-- coverage state.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS diamond_membership_enabled BOOLEAN NOT NULL DEFAULT FALSE;
