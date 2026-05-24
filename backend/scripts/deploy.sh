#!/usr/bin/env bash
# Production deploy — run on the box.
# Pulls latest code, runs preflight checks, builds images, applies database
# migrations, and (re)starts the stack defined in docker-compose.prod.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose --env-file .env.prod -f docker-compose.prod.yml"

if [ ! -f .env.prod ]; then
  echo "✗ .env.prod not found. Set it up with:  npm run cli -- --prod"
  exit 1
fi

echo "▶ pulling latest code"
git pull --ff-only

echo "▶ installing dependencies"
npm install

echo "▶ preflight checks"
./scripts/preflight.sh

echo "▶ building images"
$COMPOSE build

echo "▶ running database migrations"
$COMPOSE run --rm backend node dist/db/migrate.js

echo "▶ starting / updating the stack"
$COMPOSE up -d

echo
echo "✓ deploy complete"
$COMPOSE ps
