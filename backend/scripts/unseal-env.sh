#!/usr/bin/env bash
# Decrypt secrets/<env>.env.enc back to .env.<env> using the per-env
# age private key at secrets/.age/<env>.key.
#
# Usage:
#   ./scripts/unseal-env.sh dev
#   ./scripts/unseal-env.sh prod
#
# The goldilocks CLI runs this automatically at session start whenever
# the sealed file is newer than the plaintext (or the plaintext is
# missing) — so the operator usually never has to think about it.
# Manual invocation is useful on a fresh checkout / after a restore.
#
# Design: docs/encryption-and-backup-plan.md F3.

set -euo pipefail

ENV_NAME="${1:?usage: unseal-env.sh <dev|prod>}"
case "${ENV_NAME}" in
  dev|prod) ;;
  *) printf 'unseal-env: env must be dev or prod, got %s\n' "${ENV_NAME}" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_ROOT}"

PLAIN=".env.${ENV_NAME}"
SEALED="secrets/${ENV_NAME}.env.enc"
KEY="secrets/.age/${ENV_NAME}.key"

[[ -f "${SEALED}" ]] || { printf 'unseal-env: %s missing — nothing to unseal\n' "${SEALED}" >&2; exit 1; }
[[ -f "${KEY}"    ]] || { printf 'unseal-env: %s missing (age key absent — run Settings → Run setup)\n' "${KEY}" >&2; exit 1; }

# sops needs SOPS_AGE_KEY_FILE pointing at a file inside the container.
docker run --rm \
  -v "${REPO_ROOT}:/work" \
  -w /work \
  -e "SOPS_AGE_KEY_FILE=/work/secrets/.age/${ENV_NAME}.key" \
  goldilocks-backup:latest \
  sops --decrypt --input-type dotenv --output-type dotenv \
       "${SEALED}" > "${PLAIN}.tmp"

mv "${PLAIN}.tmp" "${PLAIN}"
chmod 0600 "${PLAIN}"

printf '[unseal-env] unsealed %s → %s\n' "${SEALED}" "${PLAIN}"
