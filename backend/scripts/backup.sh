#!/usr/bin/env bash
# Goldilocks restic-based backup.
#
# Runs inside the `backup` compose service (see dev/Dockerfile.backup and
# docker-compose.{prod.,}yml). One snapshot per invocation; the operator
# runs it on demand from the goldilocks CLI (Backups → Run backup now)
# or directly with:
#
#   docker compose --profile backup run --rm backup
#
# What goes into each snapshot (one logical snapshot in the restic repo):
#   - db.dump                       streamed pg_dump --format=custom
#   - /agent-data                   the agent's SQLCipher *.db3 files
#   - /attachments                  user-uploaded files (when local storage)
#   - /secrets                      .env.<env>, secrets/, TLS bundles, etc.
#   - repo-snapshot.txt             current backend commit SHA
#   - /repos/<name>.bundle          git bundle of each source repo
#
# Restore: scripts/restore.sh — see docs/encryption-and-backup-plan.md F2.

set -euo pipefail

# ----- config (all from environment) ----------------------------------------

# Restic standard env vars. RESTIC_PASSWORD_FILE is mounted by compose
# from the host's ./.restic-passphrase.<env> (chmod 600, gitignored).
: "${RESTIC_REPOSITORY:?set in compose env}"
: "${RESTIC_PASSWORD_FILE:?set in compose env}"

# Postgres connection. PGHOST + PGPASSWORD set in compose; PGUSER/PGDATABASE
# default to the standard goldilocks user/db.
: "${PGHOST:?set in compose env}"
: "${PGPASSWORD:?set in compose env}"
PGUSER="${PGUSER:-goldilocks}"
PGDATABASE="${PGDATABASE:-goldilocks}"

# Which environment this backup is for. Stamped into the snapshot tag.
BACKUP_ENV="${BACKUP_ENV:-prod}"

# Comma-separated list of git repo paths (mounted read-only by compose) to
# bundle into the snapshot. Each path is checked; non-repos are skipped
# with a warning so the same script works in dev (both repos present) and
# prod (only the backend repo on the box).
BACKUP_SOURCE_REPOS="${BACKUP_SOURCE_REPOS:-}"

# Tiered retention. Override via env if needed.
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"

# Sample size for restic check on every run. Full check is a separate,
# operator-initiated action from the CLI (Backups → Verify integrity).
CHECK_SUBSET="${CHECK_SUBSET:-5%}"

# ----- helpers --------------------------------------------------------------

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] error: %s\n' "$*" >&2; exit 1; }

# ----- init repo on first run -----------------------------------------------

if ! restic snapshots --quiet --json >/dev/null 2>&1; then
  log "initialising restic repository at ${RESTIC_REPOSITORY}"
  restic init
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TAGS=(--tag "env=${BACKUP_ENV}" --tag "ts=${TS}")

# ----- 1. stream the database dump ------------------------------------------

log "snapshotting database (pg_dump → restic stdin)"
# Custom-format pg_dump is binary and self-contained — pg_restore on the
# other side reads it directly. --no-owner so a restore into a fresh
# database doesn't try to ALTER OWNER to a role that may not exist.
pg_dump \
    --format=custom \
    --no-owner \
    --host="${PGHOST}" \
    --username="${PGUSER}" \
    --dbname="${PGDATABASE}" \
  | restic backup \
      --stdin \
      --stdin-filename db.dump \
      "${TAGS[@]}" \
      --tag kind=db

# ----- 2. stage repo-snapshot.txt + git bundles -----------------------------

# Working dir holds the small artifacts that aren't already volumes
# AND the staged copies of the bind-mounted content (see the EIO
# workaround in step 3). Fixed path so restic stores the same absolute
# path across runs — restore.sh just looks for sub-dirs by name.
STAGE=/snapshot
mkdir -p "${STAGE}"
trap 'rm -rf "${STAGE}"' EXIT

if [[ -n "${BACKUP_SOURCE_REPOS}" ]]; then
  IFS=',' read -r -a _REPOS <<< "${BACKUP_SOURCE_REPOS}"

  # repo-snapshot.txt is the backend's HEAD. restore.sh reads this and
  # refuses to bring up code at a different commit (unless overridden).
  for repo in "${_REPOS[@]}"; do
    [[ -d "${repo}/.git" ]] || continue
    if [[ "$(basename "${repo}")" == "goldilocks-backend" ]]; then
      if sha="$(git -C "${repo}" rev-parse HEAD 2>/dev/null)"; then
        printf '%s\n' "${sha}" > "${STAGE}/repo-snapshot.txt"
      fi
    fi
  done

  # One bundle per repo. --all captures every ref so branches and tags
  # survive. Restic dedups the resulting blobs across nightly snapshots
  # — re-bundling the same repo every day is nearly free in storage.
  mkdir -p "${STAGE}/repos"
  for repo in "${_REPOS[@]}"; do
    name="$(basename "${repo}")"
    if [[ ! -d "${repo}/.git" ]]; then
      log "skipping ${name}: not a git repository (${repo})"
      continue
    fi
    log "bundling source repo: ${name}"
    # `git bundle` complains about an empty repo; suppress and move on.
    if ! git -C "${repo}" bundle create "${STAGE}/repos/${name}.bundle" --all 2>/dev/null; then
      log "warning: git bundle failed for ${name} (empty repo or no refs?)"
      rm -f "${STAGE}/repos/${name}.bundle"
    fi
  done
fi

# ----- 3. stage volumes + secrets onto a writable filesystem ---------------

# macOS Docker Desktop's virtiofs / gRPC-fs layer intermittently fails
# bind-mount reads with "input/output error" for small files that were
# recently written on the host. Restic silently records the failure as
# a warning and saves an EMPTY snapshot. To avoid silently-broken
# backups, copy bind-mounted content into the container's own writable
# filesystem first, then snapshot from there. The copy is retried on
# EIO so we don't lose a backup to a single bad read.
#
# Path layout under STAGE that restore.sh expects:
#   ${STAGE}/agent-data
#   ${STAGE}/attachments
#   ${STAGE}/secrets
#   ${STAGE}/repo-snapshot.txt
#   ${STAGE}/repos/*.bundle
#   (db.dump is streamed directly into restic via stdin, no copy)

copy_with_retry() {
  local src="$1" dst="$2"
  local tries=3 i
  for ((i = 1; i <= tries; i++)); do
    if cp -aR "${src}" "${dst}"; then
      return 0
    fi
    log "warning: copy ${src} → ${dst} failed (attempt ${i}/${tries}); retrying after 1s"
    sleep 1
  done
  return 1
}

stage_dir() {
  local src="$1" target_name="$2"
  if [[ ! -d "${src}" ]]; then
    log "skipping ${target_name}: ${src} not mounted"
    return 0
  fi
  log "staging ${src} → ${STAGE}/${target_name}"
  if ! copy_with_retry "${src}" "${STAGE}/${target_name}"; then
    die "failed to stage ${src} — bind-mount read error after retries"
  fi
}

stage_dir /agent-data  agent-data
stage_dir /attachments attachments
stage_dir /secrets     secrets

# ----- 4. snapshot the staged tree ------------------------------------------

log "snapshotting staged tree (${STAGE})"
restic backup \
  "${TAGS[@]}" \
  --tag kind=volumes \
  "${STAGE}"

# ----- 4. retention prune ---------------------------------------------------

log "pruning (keep daily=${KEEP_DAILY} weekly=${KEEP_WEEKLY} monthly=${KEEP_MONTHLY})"
restic forget \
  --keep-daily "${KEEP_DAILY}" \
  --keep-weekly "${KEEP_WEEKLY}" \
  --keep-monthly "${KEEP_MONTHLY}" \
  --prune \
  --tag "env=${BACKUP_ENV}"

# ----- 5. integrity check ---------------------------------------------------

log "verifying repository integrity (--read-data-subset=${CHECK_SUBSET})"
restic check --read-data-subset="${CHECK_SUBSET}"

log "done. snapshot tagged env=${BACKUP_ENV} ts=${TS}"
