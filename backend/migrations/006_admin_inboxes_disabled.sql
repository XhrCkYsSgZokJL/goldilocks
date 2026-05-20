-- Migration 006: soft enable/disable for admins.
--
-- Adds `disabled` to admin_inboxes. A disabled row is treated as a
-- non-admin by loadAdminInboxIds / /v2/me / /v2/admins — the agent
-- removes the inbox from the Admins + Audit Log groups and every
-- Advisory on the next reconcile. The row is kept (not deleted) so
-- re-enabling preserves the name.
--
-- The existing admin_changed trigger fires on UPDATE, so toggling
-- `disabled` automatically notifies the agent. Idempotent.

ALTER TABLE admin_inboxes
  ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false;
