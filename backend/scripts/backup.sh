#!/usr/bin/env bash
# Nightly backup: dump the Postgres database and archive the agent identity
# data. Runs inside the `backup` service container (see docker-compose.prod.yml),
# which sets PGHOST / PGPASSWORD and mounts ./backups and the agent volume.
#
# Backups land in ./backups on the box. They protect against bad migrations,
# corruption, and accidental deletes — but NOT against the box itself dying.
# Periodically copy ./backups to an external drive or off-site location.
set -euo pipefail

OUT=/backups
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$OUT"

echo "[backup] $TS — dumping database…"
pg_dump -U "${POSTGRES_USER:-goldilocks}" -d "${POSTGRES_DB:-goldilocks}" \
  --no-owner --format=custom -f "$OUT/db-$TS.dump"

echo "[backup] $TS — archiving agent identity data…"
tar -czf "$OUT/agent-data-$TS.tar.gz" -C /agent-data .

echo "[backup] $TS — pruning backups older than ${RETENTION_DAYS} days…"
find "$OUT" -name 'db-*.dump' -mtime "+${RETENTION_DAYS}" -delete
find "$OUT" -name 'agent-data-*.tar.gz' -mtime "+${RETENTION_DAYS}" -delete

echo "[backup] $TS — done."
