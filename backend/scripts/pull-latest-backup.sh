#!/usr/bin/env bash
# Pull the prod restic repo onto this machine (the operator's Mac).
#
# This is the operational mitigation for the local-only backup choice:
# without an off-box copy, the box dying takes the backup with it. Run
# this after each `Backups → Run backup now`, or attach a launchd plist
# so it runs nightly on the laptop.
#
# Restic copy is incremental — first run is the full repo, subsequent
# runs only transfer new chunks. The local repo is encrypted at rest,
# so the destination doesn't need to be a trusted location (iCloud
# Drive, Time Machine, a USB stick all fine).
#
# Usage:
#   ./scripts/pull-latest-backup.sh [--remote <ssh-host>:<remote-repo-path>]
#                                    [--local <local-repo-path>]
#
# Defaults:
#   --remote  goldilocks-prod:/srv/goldilocks/backups/restic-prod
#   --local   ~/Backups/goldilocks/restic-prod
#
# Requirements on this machine:
#   - docker (the script invokes the pinned restic image — no native install)
#   - ssh access to the prod box (key-based; password prompts won't work
#     because restic spawns sftp non-interactively)

set -euo pipefail

REMOTE="${REMOTE:-goldilocks-prod:/srv/goldilocks/backups/restic-prod}"
LOCAL="${LOCAL:-${HOME}/Backups/goldilocks/restic-prod}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.18.0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) REMOTE="${2:?--remote requires a value}"; shift 2 ;;
    --local)  LOCAL="${2:?--local requires a value}";   shift 2 ;;
    -h|--help)
      sed -n 's/^# \{0,1\}//p' "$0" | sed -n '/^Pull the prod/,/^Requirements/p'
      exit 0
      ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

log() { printf '[pull] %s\n' "$*"; }
die() { printf '[pull] error: %s\n' "$*" >&2; exit 1; }

# Passphrases. Both repos use the same prod passphrase by design — the
# laptop's copy is the same repo, not a re-encryption.
PROD_PASSPHRASE_FILE="${PROD_PASSPHRASE_FILE:-${HOME}/.config/goldilocks/restic-passphrase.prod}"
[[ -f "${PROD_PASSPHRASE_FILE}" ]] \
  || die "passphrase file not found: ${PROD_PASSPHRASE_FILE}"

mkdir -p "${LOCAL}"

log "syncing ${REMOTE} → ${LOCAL}"

# We need ssh keys + known_hosts available to restic. The simplest way
# is to mount $HOME/.ssh into the container. Read-only so we don't risk
# corrupting it.
docker run --rm \
  -v "${LOCAL}:/dst" \
  -v "${PROD_PASSPHRASE_FILE}:/passphrase:ro" \
  -v "${HOME}/.ssh:/root/.ssh:ro" \
  -e RESTIC_REPOSITORY=/dst \
  -e RESTIC_PASSWORD_FILE=/passphrase \
  -e RESTIC_FROM_REPOSITORY="sftp:${REMOTE}" \
  -e RESTIC_FROM_PASSWORD_FILE=/passphrase \
  "${RESTIC_IMAGE}" \
  copy

log "verifying local copy"
# --no-lock because the repo is mounted :ro; without it restic would
# spin retrying lock-file writes against the read-only filesystem.
docker run --rm \
  -v "${LOCAL}:/dst:ro" \
  -v "${PROD_PASSPHRASE_FILE}:/passphrase:ro" \
  -e RESTIC_REPOSITORY=/dst \
  -e RESTIC_PASSWORD_FILE=/passphrase \
  "${RESTIC_IMAGE}" \
  --no-lock check --read-data-subset=5%

log "done. local repo at ${LOCAL}"
