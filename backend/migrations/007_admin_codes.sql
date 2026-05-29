-- Migration 007: admin_inboxes becomes a CLI-managed admin registry.
--
-- Before this, an admin row was keyed by inbox_id and only existed once
-- a device had upgraded. The new model: the `admins` CLI creates a row
-- up front with a human name and a uniquely-generated upgrade code. The
-- person installs the app, registers as a client, and enters that code
-- in the debug area to claim the slot — at which point inbox_id + claimed_at
-- are filled in.
--
--   id            surrogate key — a row exists before inbox_id is known
--   name          who this admin is (e.g. "morgan"), set by the CLI
--   upgrade_code  the secret the person types to claim the slot, unique
--   inbox_id      null until claimed; unique once set
--   disabled      hard revoke — the CLI's enable/disable toggle
--   claimed_at    when the slot was bound to an inbox
--
-- The admin_inboxes_notify trigger (migration 003) stays attached across
-- these ALTERs, so add/remove/enable/disable from the CLI keep firing
-- `admin_changed`.

-- Surrogate key, so a row can be created before the admin claims an inbox.
ALTER TABLE admin_inboxes ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE admin_inboxes ADD COLUMN IF NOT EXISTS upgrade_code TEXT;
ALTER TABLE admin_inboxes ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- inbox_id is no longer the identity — it's null until the admin upgrades.
ALTER TABLE admin_inboxes DROP CONSTRAINT IF EXISTS admin_inboxes_pkey;
ALTER TABLE admin_inboxes ALTER COLUMN inbox_id DROP NOT NULL;
ALTER TABLE admin_inboxes ADD PRIMARY KEY (id);

-- Backfill any pre-existing rows so the NOT NULL / UNIQUE constraints hold.
UPDATE admin_inboxes
  SET upgrade_code = substr(md5(random()::text || id::text), 1, 10)
  WHERE upgrade_code IS NULL;
UPDATE admin_inboxes SET name = 'unnamed' WHERE name IS NULL;

ALTER TABLE admin_inboxes ALTER COLUMN name SET NOT NULL;
ALTER TABLE admin_inboxes ALTER COLUMN upgrade_code SET NOT NULL;

ALTER TABLE admin_inboxes ADD CONSTRAINT admin_inboxes_upgrade_code_key UNIQUE (upgrade_code);
ALTER TABLE admin_inboxes ADD CONSTRAINT admin_inboxes_inbox_id_key UNIQUE (inbox_id);
