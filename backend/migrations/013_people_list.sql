-- Migration 013: encrypted people list.
--
-- The client's people list — each member's name, email, plan tier and
-- admin enable/disable flag — is held here as a single opaque
-- AES-256-GCM ciphertext blob.
--
-- The encryption key is the Advisory group's key. It lives only in the
-- MLS-encrypted group metadata on members' devices and is never sent to
-- this database, so a dump of this table yields nothing but ciphertext.
-- Only the Advisory group's members — the client, the current admins,
-- and the server agent — can decrypt it.
--
-- `version` gives optimistic concurrency: a write names the version it
-- edited and is rejected if the row has moved on since, so the client
-- and an admin can't silently clobber each other.

CREATE TABLE IF NOT EXISTS client_people_list (
  client_id  UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  salt       TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
