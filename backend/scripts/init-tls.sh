#!/usr/bin/env bash
# Bootstrap the per-env TLS material used by the compose stack.
#
# Generates a self-signed CA + a postgres server leaf cert in
# secrets/tls/. The CA is reused across renewals so backend / agent /
# backup containers can pin its public key.
#
# Idempotent: re-running this without --force preserves the existing CA
# and skips leaves that already look fresh. To rotate the leaves
# without rotating the CA, use scripts/renew-tls.sh instead.
#
# Usage:
#   ./scripts/init-tls.sh dev|prod [--force]
#
# All work happens inside the goldilocks-backup image so the host
# doesn't need openssl installed natively (it does on macOS, but pinning
# to the in-image version keeps cert format stable across machines).

set -euo pipefail

ENV_NAME="${1:?usage: init-tls.sh <dev|prod> [--force]}"
FORCE="${2:-}"
case "${ENV_NAME}" in
  dev|prod) ;;
  *) printf 'init-tls: env must be dev or prod, got %s\n' "${ENV_NAME}" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_ROOT}"

TLS_DIR="secrets/tls"
CA_CRT="${TLS_DIR}/ca.crt"
CA_KEY="${TLS_DIR}/ca.key"
PG_CRT="${TLS_DIR}/postgres.crt"
PG_KEY="${TLS_DIR}/postgres.key"
EXT_FILE="${TLS_DIR}/.postgres.ext.cnf"

mkdir -p "${TLS_DIR}"

# Run openssl from inside the backup image. openssl is bundled in
# postgres:16 (the image's base) so we don't depend on any downloaded
# binaries. Mounts the repo at /work and runs as the host UID so
# cert files end up owned by the operator, not root.
openssl_run() {
  docker run --rm \
    -v "${REPO_ROOT}:/work" \
    -w /work \
    --user "$(id -u):$(id -g)" \
    --entrypoint openssl \
    goldilocks-backup:latest \
    "$@"
}

log() { printf '[init-tls] %s\n' "$*"; }

# ----- 1. CA --------------------------------------------------------------

if [[ -f "${CA_CRT}" && -f "${CA_KEY}" && "${FORCE}" != "--force" ]]; then
  log "CA already exists at ${CA_CRT} — keeping it (use --force to regenerate)"
else
  log "minting CA for env=${ENV_NAME}"
  # P-256 EC keypair for the CA — smaller than RSA-4096, faster, and
  # widely supported by every client we care about.
  openssl_run ecparam -name prime256v1 -genkey -noout -out "${CA_KEY}"
  # 10-year self-signed root. Clients pin its public key by file
  # content, so a long lifetime is fine.
  openssl_run req -x509 -new -nodes \
    -key "${CA_KEY}" \
    -sha256 \
    -days 3650 \
    -subj "/CN=Goldilocks ${ENV_NAME} CA/O=Goldilocks/OU=${ENV_NAME}" \
    -out "${CA_CRT}"
  chmod 0600 "${CA_KEY}"
  chmod 0644 "${CA_CRT}"
fi

# ----- 2. postgres server leaf -------------------------------------------

if [[ -f "${PG_CRT}" && -f "${PG_KEY}" && "${FORCE}" != "--force" ]]; then
  log "postgres leaf already exists at ${PG_CRT} — keeping it (use renew-tls.sh to rotate)"
else
  log "minting postgres server leaf"

  # The leaf cert needs every name the client might use to reach
  # postgres:
  #   - goldilocks-db  (containers inside the compose network)
  #   - localhost      (the native dev backend reaches db via localhost)
  #   - 127.0.0.1
  cat > "${EXT_FILE}" <<'EOF'
subjectAltName = @alt_names
extendedKeyUsage = serverAuth
basicConstraints = critical, CA:false
[alt_names]
DNS.1 = goldilocks-db
DNS.2 = localhost
IP.1 = 127.0.0.1
EOF

  openssl_run ecparam -name prime256v1 -genkey -noout -out "${PG_KEY}"
  openssl_run req -new \
    -key "${PG_KEY}" \
    -subj "/CN=goldilocks-db/O=Goldilocks/OU=${ENV_NAME}" \
    -out "${TLS_DIR}/.postgres.csr"
  openssl_run x509 -req \
    -in "${TLS_DIR}/.postgres.csr" \
    -CA "${CA_CRT}" \
    -CAkey "${CA_KEY}" \
    -CAcreateserial \
    -days 365 \
    -sha256 \
    -extfile "${EXT_FILE}" \
    -out "${PG_CRT}"
  rm -f "${TLS_DIR}/.postgres.csr" "${EXT_FILE}" "${TLS_DIR}/ca.srl"

  # Postgres requires the key be readable by the postgres uid (999 in
  # the official image) and unreadable by everyone else, or it refuses
  # to start. Match that.
  chmod 0640 "${PG_KEY}"
  chmod 0644 "${PG_CRT}"
fi

log "done."
log ""
log "Files in ${TLS_DIR}:"
ls -l "${TLS_DIR}" | sed 's/^/  /'
