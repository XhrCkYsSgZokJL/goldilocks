#!/usr/bin/env bash
# Goldilocks restic-based restore.
#
# Counterpart to scripts/backup.sh. Materialises one snapshot from a
# restic repository back into a working stack. Runs ON THE HOST (not in
# a container) because it has to drive `docker compose` and lay down
# files on the host filesystem.
#
# Usage:
#   ./scripts/restore.sh [options] <repo-path> [<snapshot-id>]
#
#   <repo-path>      path to the restic repo (e.g. ./backups/restic-prod)
#   <snapshot-id>    optional restic snapshot ID. Defaults to "latest".
#                    Pass a specific ID to roll back to a past point.
#
# Options:
#   --env <dev|prod>          environment (default: prod)
#   --bootstrap               box-died mode: rehydrate the backend repo from
#                             the git bundle in the snapshot before doing
#                             anything else, so this script can run on a
#                             fresh machine with no existing checkout.
#   --ios-only <dest-dir>     extract only the iOS repo bundle into
#                             <dest-dir> and exit. Use this when you
#                             want the client source from a snapshot but
#                             don't want to touch the backend stack.
#   --force-sha-mismatch      proceed even if the current checkout's HEAD
#                             doesn't match the snapshot's repo-snapshot.txt.
#                             Without this, the script refuses — to prevent
#                             a silent code downgrade.
#   --yes                     skip the "this will overwrite..." confirmation.
#   -h, --help                show this help.
#
# Restore is driven by the same goldilocks CLI's Backups screen (see
# scripts/goldilocks.tsx). Running this script by hand is fine; it's
# the same thing the CLI does.
#
# Design notes in docs/encryption-and-backup-plan.md F2.

set -euo pipefail

# ----- args -----------------------------------------------------------------

ENV_NAME="prod"
BOOTSTRAP=0
FORCE_SHA_MISMATCH=0
ASSUME_YES=0
IOS_ONLY_DEST=""
SNAPSHOT_ID=""
REPO_PATH=""

print_help() {
  sed -n 's/^# \{0,1\}//p' "$0" | sed -n '/^Goldilocks restic-based restore/,/^Design notes/p'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_NAME="${2:?--env requires a value (dev|prod)}"
      shift 2
      ;;
    --bootstrap)
      BOOTSTRAP=1
      shift
      ;;
    --force-sha-mismatch)
      FORCE_SHA_MISMATCH=1
      shift
      ;;
    --ios-only)
      IOS_ONLY_DEST="${2:?--ios-only requires a destination directory}"
      shift 2
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'restore: unknown option %s\n' "$1" >&2
      exit 2
      ;;
    *)
      if [[ -z "${REPO_PATH}" ]]; then
        REPO_PATH="$1"
      elif [[ -z "${SNAPSHOT_ID}" ]]; then
        SNAPSHOT_ID="$1"
      else
        printf 'restore: unexpected argument %s\n' "$1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

[[ -n "${REPO_PATH}" ]] || { print_help; exit 2; }
SNAPSHOT_ID="${SNAPSHOT_ID:-latest}"

case "${ENV_NAME}" in
  dev|prod) ;;
  *) printf 'restore: --env must be dev or prod, got %s\n' "${ENV_NAME}" >&2; exit 2 ;;
esac

# ----- helpers --------------------------------------------------------------

log() { printf '[restore] %s\n' "$*"; }
die() { printf '[restore] error: %s\n' "$*" >&2; exit 1; }

# We never invoke restic natively; everything goes through the same image
# the backup runs in, so the operator doesn't need restic installed on
# the host. Pulls the image on first run.
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.18.0}"

# Run restic against the repo path. Restore is a read operation as far
# as the repo is concerned — we always pass --no-lock so restic doesn't
# block trying to acquire one. The repo mount is left writable in case
# restic ever needs to write its own internal cache.
restic_run() {
  local repo_abs pass_abs
  repo_abs="$(cd "${REPO_PATH}" && pwd)"
  pass_abs="$(cd "$(dirname "${RESTIC_PASSPHRASE_FILE}")" && pwd)/$(basename "${RESTIC_PASSPHRASE_FILE}")"
  docker run --rm \
    -v "${repo_abs}:/repo" \
    -v "${pass_abs}:/passphrase:ro" \
    -v "$1:/dest" \
    -e RESTIC_REPOSITORY=/repo \
    -e RESTIC_PASSWORD_FILE=/passphrase \
    "${RESTIC_IMAGE}" \
    --no-lock \
    "${@:2}"
}

# Variant that doesn't need a dest mount (e.g. for `snapshots`, `check`).
# Repo is mounted :ro so we MUST pass --no-lock, otherwise restic tries
# to write a lock file and retries forever on EROFS.
restic_query() {
  local repo_abs pass_abs
  repo_abs="$(cd "${REPO_PATH}" && pwd)"
  pass_abs="$(cd "$(dirname "${RESTIC_PASSPHRASE_FILE}")" && pwd)/$(basename "${RESTIC_PASSPHRASE_FILE}")"
  docker run --rm \
    -v "${repo_abs}:/repo:ro" \
    -v "${pass_abs}:/passphrase:ro" \
    -e RESTIC_REPOSITORY=/repo \
    -e RESTIC_PASSWORD_FILE=/passphrase \
    "${RESTIC_IMAGE}" \
    --no-lock \
    "$@"
}

confirm() {
  if [[ "${ASSUME_YES}" -eq 1 ]]; then
    return 0
  fi
  local prompt="$1"
  printf '%s [y/N] ' "${prompt}"
  read -r reply
  [[ "${reply}" =~ ^[Yy]$ ]]
}

# ----- 0. paths + passphrase ------------------------------------------------

# Repo must exist (--bootstrap doesn't help — the repo IS the input).
[[ -d "${REPO_PATH}" ]] || die "restic repo not found: ${REPO_PATH}"

# Passphrase file is paired with the repo by convention:
#   ./backups/restic-prod        → ./.restic-passphrase.prod
#   ./backups/restic-dev         → ./dev/restic-passphrase.dev
RESTIC_PASSPHRASE_FILE="${RESTIC_PASSPHRASE_FILE:-}"
if [[ -z "${RESTIC_PASSPHRASE_FILE}" ]]; then
  case "${ENV_NAME}" in
    prod) RESTIC_PASSPHRASE_FILE=".restic-passphrase.prod" ;;
    dev)  RESTIC_PASSPHRASE_FILE="dev/restic-passphrase.dev" ;;
  esac
fi
[[ -f "${RESTIC_PASSPHRASE_FILE}" ]] \
  || die "passphrase file not found: ${RESTIC_PASSPHRASE_FILE} (set RESTIC_PASSPHRASE_FILE)"

# ----- 1. open the repo ----------------------------------------------------

log "opening repo at ${REPO_PATH} (snapshot=${SNAPSHOT_ID})"
restic_query snapshots --quiet >/dev/null \
  || die "could not open restic repo. wrong passphrase? wrong path?"

# A single backup run produces TWO snapshots (kind=db with db.dump from
# stdin, kind=volumes with the staged tree); both share the same ts=
# tag. Resolving "latest" to one snapshot would restore only half the
# backup — find the ts of the latest run, then collect every snapshot
# id sharing that ts.
if [[ "${SNAPSHOT_ID}" == "latest" ]]; then
  LATEST_TAGS_JSON="$(restic_query snapshots --json --latest 1 --tag "env=${ENV_NAME}")"
  TS_TAG="$(printf '%s' "${LATEST_TAGS_JSON}" \
            | grep -oE '"ts=[^"]+"' \
            | head -n1 \
            | tr -d '"')"
  [[ -n "${TS_TAG}" ]] || die "no snapshots found for env=${ENV_NAME}"
  log "resolved latest run → ${TS_TAG}"

  SNAPSHOT_IDS="$(restic_query snapshots --json --tag "env=${ENV_NAME}" --tag "${TS_TAG}" \
                  | grep -oE '"short_id":"[a-f0-9]+"' \
                  | cut -d'"' -f4)"
  [[ -n "${SNAPSHOT_IDS}" ]] || die "no snapshots found for tag ${TS_TAG}"
  # Display value — used for log messages + the title bar text.
  SNAPSHOT_ID="$(printf '%s\n' "${SNAPSHOT_IDS}" | tr '\n' ',' | sed 's/,$//')"
else
  SNAPSHOT_IDS="${SNAPSHOT_ID}"
fi

# ----- 2. restore into a staging dir ---------------------------------------

# We restore into /tmp/goldilocks-restore-<env>-<ts> to avoid clobbering
# anything in the current checkout until we've verified the SHA.
STAGE="$(mktemp -d -t "goldilocks-restore-${ENV_NAME}.XXXXXX")"
log "restoring into ${STAGE}"

# Restore each snapshot of the same backup run into the same staging
# dir — restic merges trees naturally because each snapshot lives under
# a distinct path (the kind=db one stores /db.dump, the kind=volumes
# one stores /snapshot/...).
while IFS= read -r snap; do
  [[ -n "${snap}" ]] || continue
  log "restoring snapshot ${snap}"
  restic_run "${STAGE}" restore "${snap}" --target /dest
done <<< "${SNAPSHOT_IDS}"

# ----- 3. --ios-only short-circuit -----------------------------------------

if [[ -n "${IOS_ONLY_DEST}" ]]; then
  bundle="$(find "${STAGE}" -type f -name 'goldilocks-ios.bundle' | head -n1)"
  [[ -n "${bundle}" ]] || die "no goldilocks-ios.bundle in this snapshot"
  log "cloning iOS repo from bundle into ${IOS_ONLY_DEST}"
  if [[ -e "${IOS_ONLY_DEST}" ]]; then
    confirm "${IOS_ONLY_DEST} already exists. Continue (will clone into a subdir)?" || die "aborted"
  fi
  mkdir -p "${IOS_ONLY_DEST}"
  git clone "${bundle}" "${IOS_ONLY_DEST}"
  log "iOS repo restored to ${IOS_ONLY_DEST}"
  log "stage left at ${STAGE} — remove with: rm -rf ${STAGE}"
  exit 0
fi

# ----- 4. SHA check / bootstrap --------------------------------------------

snapshot_sha=""
if sha_file="$(find "${STAGE}" -type f -name 'repo-snapshot.txt' | head -n1)" && [[ -n "${sha_file}" ]]; then
  snapshot_sha="$(tr -d '[:space:]' < "${sha_file}")"
fi

if [[ "${BOOTSTRAP}" -eq 1 ]]; then
  # box-died mode: clone backend from the bundle before doing anything else.
  bundle="$(find "${STAGE}" -type f -name 'goldilocks-backend.bundle' | head -n1)"
  [[ -n "${bundle}" ]] || die "--bootstrap requires goldilocks-backend.bundle in the snapshot"
  log "bootstrap: cloning backend repo from bundle"
  dest="$(pwd)/goldilocks-backend-restored"
  [[ -e "${dest}" ]] && die "${dest} already exists; remove it first"
  git clone "${bundle}" "${dest}"
  if [[ -n "${snapshot_sha}" ]]; then
    log "checking out captured commit ${snapshot_sha}"
    git -C "${dest}" checkout "${snapshot_sha}"
  fi
  log "backend repo bootstrapped at ${dest}"
  log ""
  log "next step: cd ${dest} && ./scripts/restore.sh \\"
  log "    --env ${ENV_NAME} ${REPO_PATH} ${SNAPSHOT_ID}"
  log "(run from inside the restored checkout — no --bootstrap that time)"
  exit 0
fi

if [[ -n "${snapshot_sha}" ]]; then
  current_sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  if [[ "${snapshot_sha}" != "${current_sha}" ]]; then
    if [[ "${FORCE_SHA_MISMATCH}" -eq 0 ]]; then
      die "code mismatch: snapshot=${snapshot_sha} checkout=${current_sha}. pass --force-sha-mismatch to override, or check out the snapshot's commit first."
    fi
    log "warning: SHA mismatch (snapshot=${snapshot_sha} checkout=${current_sha}) — proceeding because --force-sha-mismatch was set"
  fi
fi

# ----- 5. idempotency guard ------------------------------------------------

COMPOSE_FILE="docker-compose.yml"
DEFAULT_PROJECT_NAME="goldilocks"
if [[ "${ENV_NAME}" == "prod" ]]; then
  COMPOSE_FILE="docker-compose.prod.yml"
  DEFAULT_PROJECT_NAME="goldilocks-prod"
fi
# Honor COMPOSE_PROJECT_NAME so callers like dev/restore-drill can spin
# up an isolated parallel project (goldilocks-restore-test) without
# colliding with the live dev stack.
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-${DEFAULT_PROJECT_NAME}}"
DC=(docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}")

# Optional compose override file layered on top (the drill uses
# dev/docker-compose.restore-overrides.yml to strip host port
# publishing so the parallel project can run alongside the live stack).
if [[ -n "${COMPOSE_OVERRIDE_FILE:-}" && -f "${COMPOSE_OVERRIDE_FILE}" ]]; then
  DC+=(-f "${COMPOSE_OVERRIDE_FILE}")
fi

# If the project is already running with non-empty volumes, refuse —
# the operator should have stopped + cleared the stack on purpose.
if "${DC[@]}" ps --status running --quiet | grep -q .; then
  die "the ${PROJECT_NAME} compose project is currently running. Stop it first: ${DC[*]} down (volumes preserved) — then re-run restore."
fi

# Helper — finds a directory by name anywhere under ${STAGE}, regardless
# of which absolute path restic stored it at (`/snapshot/...` in current
# backups, `/tmp/tmp.XXXX/...` in older runs, etc.).
find_staged_dir() {
  local name="$1"
  find "${STAGE}" -type d -name "${name}" -not -path '*/repos/*' 2>/dev/null | head -n1
}

# ----- 6. lay down the secrets bundle --------------------------------------

log "restoring secrets bundle"
mkdir -p ./secrets
SECRETS_SRC="$(find_staged_dir secrets)"
if [[ -n "${SECRETS_SRC}" && -d "${SECRETS_SRC}" ]]; then
  cp -aR "${SECRETS_SRC}/." ./secrets/
  if [[ -f "${SECRETS_SRC}/.env.${ENV_NAME}" ]]; then
    cp -a "${SECRETS_SRC}/.env.${ENV_NAME}" "./.env.${ENV_NAME}"
  fi
else
  log "warning: no secrets directory in snapshot — restored stack will have no .env or TLS material"
fi

# ----- 7. bring up Postgres, restore the dump -------------------------------

log "starting database service"
"${DC[@]}" up -d goldilocks-db

# Wait for healthcheck. ~30s ceiling — Postgres usually green in 5–10.
for _ in {1..30}; do
  if "${DC[@]}" ps goldilocks-db --format '{{.Status}}' | grep -q healthy; then
    break
  fi
  sleep 1
done
"${DC[@]}" ps goldilocks-db --format '{{.Status}}' | grep -q healthy \
  || die "goldilocks-db did not become healthy in time"

log "restoring database from db.dump"
PG_USER="${POSTGRES_USER:-goldilocks}"
PG_DB="${POSTGRES_DB:-goldilocks}"
DUMP_PATH="$(find "${STAGE}" -type f -name 'db.dump' | head -n1)"
[[ -n "${DUMP_PATH}" ]] || die "db.dump missing from snapshot"

# --clean --if-exists wipes existing objects before recreating, so the
# operation is idempotent against a database that may have partial state.
"${DC[@]}" exec -T goldilocks-db \
  pg_restore \
    --clean --if-exists \
    --no-owner \
    -U "${PG_USER}" \
    -d "${PG_DB}" \
  < "${DUMP_PATH}"

# ----- 8. rehydrate volumes -------------------------------------------------

# /agent-data and /attachments were captured as live directory trees.
# Use a throwaway helper container to copy them into the named volumes
# so file ownership / permissions stay correct.
load_volume() {
  local stage_subdir="$1" vol_name="$2"
  local src
  src="$(find_staged_dir "${stage_subdir}")"
  if [[ -z "${src}" || ! -d "${src}" ]]; then
    log "skipping ${vol_name}: ${stage_subdir} not in snapshot"
    return 0
  fi
  log "loading volume ${vol_name} from ${src}"
  docker run --rm \
    -v "${src}:/src:ro" \
    -v "${PROJECT_NAME}_${vol_name}:/dst" \
    --entrypoint sh \
    "${RESTIC_IMAGE}" \
    -c 'rm -rf /dst/* /dst/..?* /dst/.[!.]* 2>/dev/null || true; cp -aR /src/. /dst/'
}

load_volume agent-data    goldilocks-agent-data
load_volume attachments   goldilocks-attachments

# ----- 9. bring up the rest of the stack ------------------------------------

# Start only the services we actually need to validate the restore.
# Bringing up the whole compose file would also start optional pieces
# (the XMTP notification-server image isn't on Docker Hub; the dev
# backend image doesn't build cleanly because the live dev path runs
# it natively via `npm run server:dev` and the Docker image hasn't
# been exercised) and break the drill on a pull/build failure that
# has nothing to do with the restored data.
#
# Dev — postgres is already up from step 7. Drill verification is
#       postgres-side (schema migrations + row counts), so no need
#       to start anything else.
# Prod — bring backend + agent + cloudflared up alongside postgres.
if [[ "${ENV_NAME}" == "prod" ]]; then
  SERVICES_TO_START=(backend agent cloudflared)
else
  SERVICES_TO_START=()
fi
if [[ ${#SERVICES_TO_START[@]} -gt 0 ]]; then
  log "bringing up: ${SERVICES_TO_START[*]}"
  "${DC[@]}" up -d "${SERVICES_TO_START[@]}"
else
  log "dev restore complete — postgres is up; no other services needed for verification"
fi

# ----- 10. summary ----------------------------------------------------------

log ""
log "restore complete. snapshot=${SNAPSHOT_ID} env=${ENV_NAME}"
log "stage dir preserved at ${STAGE} — remove with:  rm -rf ${STAGE}"
log ""
log "next steps:"
log "  - probe http://localhost:4000/healthz"
if [[ "${ENV_NAME}" == "prod" ]]; then
  log "  - ./scripts/tunnel-url.sh   # print the (new) cloudflared URL"
fi
