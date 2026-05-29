#!/usr/bin/env bash
# Custom entrypoint for the goldilocks-db postgres service.
#
# Why this exists: postgres refuses to start if the SSL private key
# isn't owned by the same uid the server runs as (postgres, uid 999 in
# the official image) and isn't restricted to mode 0600. A direct bind
# mount of secrets/tls/postgres.key inherits the host operator's
# ownership, which is never going to match. This script copies the
# bind-mounted material from /etc/postgresql-tls-src/ into a writable
# directory, sets the correct ownership + permissions, and then exec's
# the standard postgres docker-entrypoint with all of the original
# `command:` arguments preserved.
#
# Compose sets `entrypoint: /usr/local/bin/db-entrypoint.sh` on this
# service. Mounted at /usr/local/bin/db-entrypoint.sh as a read-only
# bind mount from this file in the repo.
#
# F5 design lives in docs/encryption-and-backup-plan.md.

set -euo pipefail

DST_DIR=/etc/postgresql-tls
SRC_DIR=/etc/postgresql-tls-src

if [[ ! -d "${SRC_DIR}" ]]; then
  printf '[db-entrypoint] %s not mounted — refusing to start without TLS material.\n' "${SRC_DIR}" >&2
  exit 1
fi

mkdir -p "${DST_DIR}"
cp "${SRC_DIR}/postgres.crt" "${DST_DIR}/server.crt"
cp "${SRC_DIR}/postgres.key" "${DST_DIR}/server.key"
cp "${SRC_DIR}/ca.crt"       "${DST_DIR}/ca.crt"

chown postgres:postgres "${DST_DIR}/server.crt" "${DST_DIR}/server.key" "${DST_DIR}/ca.crt"
chmod 0600 "${DST_DIR}/server.key"
chmod 0644 "${DST_DIR}/server.crt" "${DST_DIR}/ca.crt"

# Hand off to the postgres image's stock entrypoint with all of the
# command-line flags compose passed in.
exec docker-entrypoint.sh "$@"
