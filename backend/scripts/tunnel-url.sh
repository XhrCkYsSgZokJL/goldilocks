#!/usr/bin/env bash
# Prints the current public URL of the Cloudflare quick tunnel.
#
# The quick tunnel (TryCloudflare) hostname is ephemeral: it stays alive
# while the cloudflared container keeps running, but a new one is issued
# whenever cloudflared restarts (box reboot, crash, explicit restart).
# Run this after a deploy or reboot to get the URL the iOS app must use.
set -euo pipefail
cd "$(dirname "$0")/.."

# `compose logs` reads existing container output and doesn't actually need
# substituted YAML values, but compose still warns about unset variables.
# Wrap in with-prod-secrets.sh so the YAML resolves cleanly.
WITH_SECRETS=./scripts/with-prod-secrets.sh
COMPOSE=(docker compose -f docker-compose.prod.yml)

url=$("${WITH_SECRETS}" "${COMPOSE[@]}" logs cloudflared 2>&1 \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
  | tail -n 1 || true)

if [ -z "$url" ]; then
  echo "✗ No trycloudflare.com URL found in the cloudflared logs."
  echo "  Is the tunnel running?    ${WITH_SECRETS} ${COMPOSE[*]} ps cloudflared"
  echo "  If the logs have rotated past the startup banner, restart it to"
  echo "  print a fresh URL (note: a restart issues a NEW url):"
  echo "    ${WITH_SECRETS} ${COMPOSE[*]} restart cloudflared"
  exit 1
fi

echo "$url"
