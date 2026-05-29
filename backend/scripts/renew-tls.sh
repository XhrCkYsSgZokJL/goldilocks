#!/usr/bin/env bash
# Renew leaf TLS certs against the existing per-env CA.
#
# The CA at secrets/tls/ca.{crt,key} is preserved, so clients that pin
# it (backend, agent, backup container) keep working without a config
# change. Only the postgres leaf is regenerated. After this script
# runs, restart postgres (and the consuming services) to pick up the
# new cert.
#
# Usage:
#   ./scripts/renew-tls.sh dev|prod

set -euo pipefail

ENV_NAME="${1:?usage: renew-tls.sh <dev|prod>}"
case "${ENV_NAME}" in
  dev|prod) ;;
  *) printf 'renew-tls: env must be dev or prod, got %s\n' "${ENV_NAME}" >&2; exit 2 ;;
esac

# Force-regenerate the leaves only, keeping the CA. init-tls.sh is the
# right tool — passing --force without removing the CA does exactly
# this. We just blow away the postgres leaf first so init-tls's
# "already exists" guard doesn't trip.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rm -f "${REPO_ROOT}/secrets/tls/postgres.crt" "${REPO_ROOT}/secrets/tls/postgres.key"
exec "${REPO_ROOT}/scripts/init-tls.sh" "${ENV_NAME}"
