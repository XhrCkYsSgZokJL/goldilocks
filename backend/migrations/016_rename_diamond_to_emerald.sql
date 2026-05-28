-- Migration 016: rename Diamond tier to Emerald.
--
-- Product decision: the manual admin-controlled override tier is now
-- called "Emerald" rather than "Diamond". This migration renames the
-- column so the drizzle schema, API surface, and audit-log narrative
-- lines all stay aligned. Default + nullability are preserved.

ALTER TABLE clients
  RENAME COLUMN diamond_membership_enabled TO emerald_membership_enabled;
