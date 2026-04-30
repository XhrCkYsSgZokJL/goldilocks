-- Phase 1A: Goldilocks customer model.
--
-- Three tables + one column on `devices`:
--   - clients         (one row per XMTP inbox = one Goldilocks customer)
--   - admin_inboxes   (allowlist: which inbox IDs are Goldilocks team)
--   - client_channels (one row per (client, role) — Advisory / Reports)
--
-- The xmtp_group_id in client_channels is overwritten in place when a
-- channel is exploded + recreated, so each (client_id, role) row identifies
-- a stable channel slot across its lifecycle.

-- 1. Bind the device to its claimed XMTP inbox + the Ethereum address
--    used to sign the registration challenge. The (inbox_id, eth_address)
--    pairing is verified against the XMTP node's identity ledger before
--    being committed; once committed it's locked. Subsequent /v2/me calls
--    from this deviceId must re-sign with the same eth key.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS inbox_id    TEXT,
  ADD COLUMN IF NOT EXISTS eth_address TEXT;

CREATE INDEX IF NOT EXISTS devices_inbox_id_idx    ON devices(inbox_id);
CREATE INDEX IF NOT EXISTS devices_eth_address_idx ON devices(eth_address);

-- 2. SIWE auth challenges — one-time-use nonces issued by
--    /v2/auth/challenge and consumed by /v2/me. We bind each nonce to the
--    requesting device + claimed inbox_id so we can validate everything
--    matches when the signature lands.
CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce        TEXT        PRIMARY KEY,
  device_id    TEXT        NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  inbox_id     TEXT        NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_challenges_device_id_idx ON auth_challenges(device_id);
CREATE INDEX IF NOT EXISTS auth_challenges_expires_at_idx ON auth_challenges(expires_at);

-- 3. Customers ("clients") — one per XMTP inbox.
CREATE TABLE IF NOT EXISTS clients (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_number   BIGSERIAL   NOT NULL UNIQUE,
  inbox_id        TEXT        NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Admin allowlist. Empty on first migration. Admins are added at
--    runtime via /v2/admin/promote-self (dev) or by an existing admin's
--    /v2/admin/admins endpoint (prod). This used to seed Morgan + Tillie
--    as a convenience, but those inbox IDs were tied to a specific XMTP
--    network instance — when the local node was wiped, the seeded IDs
--    became stale and broke agent boot (the admins-agent tried to create
--    the Admins group with members the network couldn't resolve).
CREATE TABLE IF NOT EXISTS admin_inboxes (
  inbox_id    TEXT        PRIMARY KEY,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Channel role + status enums, then the channel table itself.
DO $$ BEGIN
  CREATE TYPE channel_role AS ENUM ('advisory', 'reports');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE channel_status AS ENUM ('active', 'exploded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS client_channels (
  client_id      UUID            NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role           channel_role    NOT NULL,
  xmtp_group_id  TEXT,
  status         channel_status  NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ     NOT NULL DEFAULT now(),
  exploded_at    TIMESTAMPTZ,
  recreated_at   TIMESTAMPTZ,
  PRIMARY KEY (client_id, role)
);

CREATE INDEX IF NOT EXISTS client_channels_xmtp_group_id_idx
  ON client_channels(xmtp_group_id);
CREATE INDEX IF NOT EXISTS client_channels_status_idx
  ON client_channels(status);
