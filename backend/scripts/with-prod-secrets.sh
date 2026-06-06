#!/usr/bin/env bash
# Decrypt secrets/prod.env.enc in-memory and exec the given command with
# those variables exported into its env. Plaintext is never written to
# disk; the decrypted text lives only inside this script's shell vars
# until `exec` replaces the process.
#
# Usage:
#   ./scripts/with-prod-secrets.sh docker compose -f docker-compose.prod.yml up -d
#   ./scripts/with-prod-secrets.sh bash -c 'docker compose ... ps'
#
# Design: docs/encryption-and-backup-plan.md F3.
set -euo pipefail
cd "$(dirname "$0")/.."

SEALED="secrets/prod.env.enc"
AGE_KEY="secrets/.age/prod.key"

if [ ! -f "${SEALED}" ]; then
  echo "✗ ${SEALED} not found" >&2
  exit 1
fi
if [ ! -f "${AGE_KEY}" ]; then
  echo "✗ ${AGE_KEY} not found (age private key required to decrypt)" >&2
  exit 1
fi

# Decrypt via the goldilocks-backup image's sops so the host doesn't need
# sops installed natively.
SECRETS_TEXT="$(docker run --rm \
  -v "$(pwd):/work" \
  -w /work \
  -e "SOPS_AGE_KEY_FILE=/work/${AGE_KEY}" \
  goldilocks-backup:latest \
  sops --decrypt --input-type dotenv --output-type dotenv "${SEALED}")"

set -a
# shellcheck disable=SC2086
eval "${SECRETS_TEXT}"
set +a
SECRETS_TEXT=""
unset SECRETS_TEXT

exec "$@"
