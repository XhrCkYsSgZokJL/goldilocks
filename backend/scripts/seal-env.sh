#!/usr/bin/env bash
# Seal a plaintext .env.<env> into its SOPS-encrypted form
# secrets/<env>.env.enc, using the per-env age recipient at
# secrets/.age/<env>.key.pub.
#
# Usage:
#   ./scripts/seal-env.sh dev
#   ./scripts/seal-env.sh prod
#
# The goldilocks CLI calls this from the Keys screen. Standalone use is
# fine too — sops runs via the goldilocks-backup image so the host
# doesn't need sops installed natively.
#
# Design: docs/encryption-and-backup-plan.md F3.

set -euo pipefail

ENV_NAME="${1:?usage: seal-env.sh <dev|prod>}"
case "${ENV_NAME}" in
  dev|prod) ;;
  *) printf 'seal-env: env must be dev or prod, got %s\n' "${ENV_NAME}" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_ROOT}"

PLAIN=".env.${ENV_NAME}"
SEALED="secrets/${ENV_NAME}.env.enc"
KEY="secrets/.age/${ENV_NAME}.key"

[[ -f "${PLAIN}" ]] || { printf 'seal-env: %s missing\n' "${PLAIN}" >&2; exit 1; }
[[ -f "${KEY}"   ]] || { printf 'seal-env: %s missing (run Settings → Run setup)\n' "${KEY}" >&2; exit 1; }

mkdir -p secrets

# Derive the public-key (age recipient) line from the private key file.
RECIPIENT="$(grep -oE 'age1[a-z0-9]+' "${KEY}.pub" 2>/dev/null || true)"
if [[ -z "${RECIPIENT}" ]]; then
  printf 'seal-env: cannot read recipient from %s.pub\n' "${KEY}" >&2
  exit 1
fi

# Run sops via the backup image so we don't depend on a host install.
docker run --rm \
  -v "${REPO_ROOT}:/work" \
  -w /work \
  goldilocks-backup:latest \
  sops --encrypt --age "${RECIPIENT}" --input-type dotenv --output-type dotenv \
       "${PLAIN}" > "${SEALED}.tmp"

mv "${SEALED}.tmp" "${SEALED}"
chmod 0644 "${SEALED}"

printf '[seal-env] sealed %s → %s\n' "${PLAIN}" "${SEALED}"
