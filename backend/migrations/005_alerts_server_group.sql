-- Migration 005: widen server_groups.kind to allow 'alerts'.
--
-- The original check constraint only permitted ('admins'). Adding the
-- cross-admin Alerts feed (where ReportsAgent will cross-post every
-- client report) requires us to also allow 'alerts'. We drop the old
-- constraint by name and add a new one. Idempotent — both halves are
-- guarded so re-running the migration is a no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  table_name = 'server_groups'
      AND  constraint_name = 'server_groups_kind_check'
  ) THEN
    ALTER TABLE server_groups DROP CONSTRAINT server_groups_kind_check;
  END IF;
END$$;

ALTER TABLE server_groups
  ADD CONSTRAINT server_groups_kind_check
  CHECK (kind IN ('admins', 'alerts'));
