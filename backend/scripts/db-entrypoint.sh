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

# F5 mTLS — generate a pg_hba.conf that requires SSL + a valid client
# certificate (auth method `cert`, implies clientcert=verify-full) on
# every TCP connection. Unix-socket connections (used by pg_dump from
# inside this container during backups) stay password-less via `trust`
# because the only thing that can reach them is already running inside
# this container's filesystem.
#
# `cert` maps the client cert's CN onto the requested DB role: the
# backend, agent, and backup leaves all share CN=goldilocks so they
# connect as that role. To add another role, mint a leaf with the new
# CN and add an `hostssl` line for it here.
HBA_FILE="${DST_DIR}/pg_hba.conf"
cat > "${HBA_FILE}" <<'EOF'
# Goldilocks F5 mTLS pg_hba — clients MUST present a CA-signed leaf.
local   all all                  trust
hostssl all all 0.0.0.0/0         cert
hostssl all all ::/0              cert
EOF
chown postgres:postgres "${HBA_FILE}"
chmod 0600 "${HBA_FILE}"

# Tell the standard entrypoint to point Postgres at our generated hba
# rather than the image default. The official postgres image honours
# `POSTGRES_HOST_AUTH_METHOD` and `PGDATA`, but the cleanest knob for a
# fully-managed hba file is the `-c hba_file=…` command-line flag, which
# we append to whatever compose passed in.
exec docker-entrypoint.sh "$@" -c "hba_file=${HBA_FILE}"
