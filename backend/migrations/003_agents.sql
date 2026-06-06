-- Server-managed XMTP agent identities and groups.
--
-- We run two long-lived XMTP agents in the goldilocks-agent process:
--   - admins-agent     creates + manages the cross-admin "Admins" group and
--                      the per-client "Advisory" groups. Reconciles their
--                      member set against admin_inboxes whenever it changes.
--   - reports-agent    creates + owns each client's "Reports" group. Will
--                      eventually post pre-baked reports on a cron pulled
--                      from report_jobs.
--
-- Each agent has its own XMTP inbox, persisted here so the same identity
-- comes back across process restarts. Keys live on disk inside the agent
-- container (see xmtp_db_path); we only persist the identifiers + the
-- secp256k1 private key seed needed to log back in.

CREATE TABLE server_agents (
  -- 'admins' or 'reports'. The kind is also the primary key — we run
  -- exactly one of each.
  kind                 TEXT PRIMARY KEY CHECK (kind IN ('admins', 'reports')),
  inbox_id             TEXT NOT NULL UNIQUE,
  eth_address          TEXT NOT NULL,
  -- 32-byte private key seed, hex-encoded. Stored in plaintext for now;
  -- in production these should live in a KMS/secret manager.
  private_key_hex      TEXT NOT NULL,
  -- Where the agent's local SQLCipher DB lives. Filled by the agent on
  -- first boot so it can find its own DB next time.
  xmtp_db_path         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-owned groups that don't belong to a single client. Today we only
-- have one: the cross-admin "Admins" group managed by the admins-agent.
-- Modeled as a table (rather than a single row) so we can add more system
-- groups later (e.g. an "Audit" group, an "Alerts" group, etc.) without
-- another migration.
CREATE TABLE server_groups (
  kind                 TEXT PRIMARY KEY CHECK (kind IN ('admins')),
  xmtp_group_id        TEXT NOT NULL UNIQUE,
  managed_by           TEXT NOT NULL REFERENCES server_agents(kind),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Skeleton queue for the future Reports cron pipeline. The reports-agent
-- will eventually scan this table on a tick and post any (status='pending'
-- AND scheduled_at <= now()) rows to the corresponding client's Reports
-- group. We define the table now so the wire format is locked in; no
-- worker is wired up yet.
CREATE TYPE report_job_status AS ENUM ('pending', 'posted', 'failed', 'cancelled');

CREATE TABLE report_jobs (
  id                   BIGSERIAL PRIMARY KEY,
  client_id            UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- Free-form payload — exact shape will firm up once the report source
  -- is decided. Likely { kind, title, body_md, attachments[], ... }.
  payload              JSONB NOT NULL,
  scheduled_at         TIMESTAMPTZ NOT NULL,
  status               report_job_status NOT NULL DEFAULT 'pending',
  posted_at            TIMESTAMPTZ,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX report_jobs_pending_due
  ON report_jobs (scheduled_at)
  WHERE status = 'pending';

-- =============================================================================
-- LISTEN/NOTIFY plumbing
-- =============================================================================
--
-- The agent process holds a dedicated pg connection that LISTENs to two
-- channels. Triggers below fire pg_notify whenever the relevant tables
-- change so the agent can react in real time without polling.

-- Fired on insert/delete/update of admin_inboxes.
-- Payload: { op: 'INSERT' | 'DELETE' | 'UPDATE', inbox_id, name }
CREATE OR REPLACE FUNCTION goldilocks_notify_admin_changed() RETURNS TRIGGER AS $$
DECLARE
  payload JSONB;
BEGIN
  payload := jsonb_build_object(
    'op', TG_OP,
    'inbox_id', COALESCE(NEW.inbox_id, OLD.inbox_id),
    'name', COALESCE(NEW.name, OLD.name)
  );
  PERFORM pg_notify('admin_changed', payload::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_inboxes_notify ON admin_inboxes;
CREATE TRIGGER admin_inboxes_notify
  AFTER INSERT OR UPDATE OR DELETE ON admin_inboxes
  FOR EACH ROW EXECUTE FUNCTION goldilocks_notify_admin_changed();

-- Fired when a brand-new client row lands in `clients`. The agents use
-- this to know they should provision the new customer's Advisory + Reports
-- groups.
-- Payload: { client_id (uuid), client_number (bigint), inbox_id }
CREATE OR REPLACE FUNCTION goldilocks_notify_client_registered() RETURNS TRIGGER AS $$
DECLARE
  payload JSONB;
BEGIN
  payload := jsonb_build_object(
    'client_id', NEW.id,
    'client_number', NEW.client_number,
    'inbox_id', NEW.inbox_id
  );
  PERFORM pg_notify('client_registered', payload::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clients_notify ON clients;
CREATE TRIGGER clients_notify
  AFTER INSERT ON clients
  FOR EACH ROW EXECUTE FUNCTION goldilocks_notify_client_registered();
