#!/usr/bin/env bash
# Pre-deploy checks. Must pass before a production deploy. Run on the box.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ typecheck"
npm run typecheck

echo "▶ tests"
npm test

echo "▶ lint"
npm run lint

echo "✓ preflight passed"
