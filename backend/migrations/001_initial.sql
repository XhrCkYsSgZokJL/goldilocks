-- Initial schema for the Goldilocks backend.

CREATE TABLE IF NOT EXISTS devices (
  device_id        TEXT PRIMARY KEY,
  push_token       TEXT,
  push_token_type  TEXT,
  apns_env         TEXT,
  push_failures    INTEGER     NOT NULL DEFAULT 0,
  disabled         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  jti         TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN     NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS sessions_device_id_idx ON sessions(device_id);

CREATE TABLE IF NOT EXISTS installations (
  client_id   TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS installations_device_id_idx ON installations(device_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  client_id   TEXT NOT NULL REFERENCES installations(client_id) ON DELETE CASCADE,
  topic       TEXT NOT NULL,
  hmac_keys   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, topic)
);
CREATE INDEX IF NOT EXISTS subscriptions_topic_idx ON subscriptions(topic);

CREATE TABLE IF NOT EXISTS attachments (
  object_key    TEXT PRIMARY KEY,
  uploaded_by   TEXT,
  content_type  TEXT NOT NULL,
  filename      TEXT,
  asset_url     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_uploaded_by_idx ON attachments(uploaded_by);
