#!/usr/bin/env bash
# Production deploy — run on the box.
# Pulls latest code, runs preflight checks, builds images, applies database
# migrations, and (re)starts the stack defined in docker-compose.prod.yml.
#
# Secrets enter the deploy process env via scripts/with-prod-secrets.sh,
# which decrypts secrets/prod.env.enc in-memory and execs the given
# command. Plaintext `.env.prod` is never written to disk.
#
# Design: docs/encryption-and-backup-plan.md F3, docs/production-setup.md.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.prod.yml)
WITH_SECRETS=./scripts/with-prod-secrets.sh

echo "▶ pulling latest code"
git pull --ff-only

echo "▶ installing dependencies"
npm install

echo "▶ preflight checks"
./scripts/preflight.sh

# `compose build` doesn't need substituted secrets.
echo "▶ building images"
"${COMPOSE[@]}" build

echo "▶ running database migrations"
# `migrate.js` applies pending SQL migrations and then runs the
# application-level backfills (e.g. admin_inboxes.upgrade_code_lookup
# added by migration 019). All backfills are idempotent.
"${WITH_SECRETS}" "${COMPOSE[@]}" run --rm backend node dist/db/migrate.js

echo "▶ starting / updating the stack"
"${WITH_SECRETS}" "${COMPOSE[@]}" up -d

echo
echo "✓ deploy complete"
"${COMPOSE[@]}" ps
