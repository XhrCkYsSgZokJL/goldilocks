#!/usr/bin/env bash
# Pre-deploy checks. Must pass before a production deploy. Run on the box.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ F5 mTLS material present"
for name in ca.crt postgres.crt postgres.key client-backend.crt client-backend.key client-agent.crt client-agent.key client-backup.crt client-backup.key; do
  if [ ! -f "secrets/tls/${name}" ]; then
    echo "✗ secrets/tls/${name} missing — run ./scripts/init-tls.sh prod first"
    exit 1
  fi
done

echo "▶ typecheck"
npm run typecheck

echo "▶ tests"
npm test

echo "▶ lint"
npm run lint

echo "✓ preflight passed"
