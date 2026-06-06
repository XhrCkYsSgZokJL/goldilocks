#!/usr/bin/env bash
# Goldilocks local dev environment — up / down / status.
#
# Normally driven by `./dev/start` / `./dev/stop` / `./dev/reset`; also
# runnable directly:
#
#   bash scripts/dev-env.sh up|down|reset|status
#
# Override these by exporting them before running:
#   CONVOS_BUNDLE_ID  iOS bundle id (keychain entries are scoped to it)
#   GOLDILOCKS_SIMS   space-separated UDIDs of dedicated sims to erase on `down`

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(dirname "$SCRIPT_DIR")"
CONVOS_BUNDLE_ID="${CONVOS_BUNDLE_ID:-org.convos.ios-local}"
GOLDILOCKS_SIMS="${GOLDILOCKS_SIMS:-F6DCC975-A4C8-46A9-81B2-66D0ECE11249}"

# Run a command with a hard timeout. simctl can hang forever when the
# CoreSimulator service is wedged; this guarantees the call returns. The
# command runs in the background and a watchdog SIGKILLs it (and any child)
# if it overruns. SIGKILL is uncatchable, so this does not depend on the
# target respecting signals — unlike `timeout`, which macOS does not ship,
# and the `perl alarm` trick, which a forking wrapper can defeat.
# Returns the command's exit status, or a non-zero code if it was killed.
run_timeout() {
  local secs="$1"; shift
  "$@" &
  local cmd_pid=$!
  ( sleep "$secs"; pkill -KILL -P "$cmd_pid" 2>/dev/null; kill -KILL "$cmd_pid" 2>/dev/null ) &
  local watch_pid=$!
  wait "$cmd_pid" 2>/dev/null
  local rc=$?
  # Command finished on its own — cancel the watchdog (and its sleep).
  pkill -KILL -P "$watch_pid" 2>/dev/null
  kill -KILL "$watch_pid" 2>/dev/null
  wait "$watch_pid" 2>/dev/null
  return "$rc"
}

dev_up() {
  echo "🟢  Goldilocks dev: bringing services up"
  echo

  echo "→ installing backend dependencies (npm install)"
  ( cd "$BACKEND" && npm install ) || { echo "❌  npm install failed"; return 1; }

  # F5 TLS material — idempotent. The script mints the CA + Postgres
  # server leaf (existing installs) and the client-{backend,agent,backup}
  # leaves (introduced by the mTLS change in security plan item 33).
  # Without these the backend's DATABASE_URL refers to certs that
  # don't exist yet, and migrations crash with ENOENT before Postgres
  # is ever asked to accept a connection.
  echo "→ ensuring F5 TLS material exists (init-tls.sh, idempotent)"
  ( cd "$BACKEND" && bash scripts/init-tls.sh dev ) \
    || { echo "❌  init-tls.sh failed"; return 1; }

  # Start core services: XMTP node stack + goldilocks Postgres.
  # The notification-server and backend are excluded — the backend
  # runs natively (faster iteration) and the notification server
  # image isn't publicly available yet.
  local CORE_SERVICES="xmtp-node xmtp-validation xmtp-anvil xmtp-history xmtp-db xmtp-mlsdb goldilocks-db"

  echo "→ pulling Docker images"
  ( cd "$BACKEND" && docker compose pull -q $CORE_SERVICES ) \
    || { echo "❌  docker compose pull failed"; return 1; }

  echo "→ starting Docker services (XMTP node + Postgres)"
  ( cd "$BACKEND" && docker compose up -d --wait $CORE_SERVICES ) \
    || { echo "❌  Docker services failed to start"; return 1; }

  echo "→ running migrations"
  # The healthcheck guarantees pg is accepting connections, but initdb can
  # still slam the door for a beat right at the boundary. Retry up to 3 times.
  local attempt
  for attempt in 1 2 3; do
    if ( cd "$BACKEND" && npm run migrate ); then
      break
    fi
    if [[ $attempt -eq 3 ]]; then
      echo "❌  migrations failed after 3 attempts"
      return 1
    fi
    echo "   migrate attempt $attempt failed, retrying in 2s…"
    sleep 2
  done

  echo
  echo "✅  Goldilocks dev infrastructure is up (database + XMTP node)."
}

dev_down() {
  echo "🛑  Goldilocks dev: stopping services (data kept)"
  echo

  echo "→ docker compose down"
  ( cd "$BACKEND" && docker compose down ) || echo "   (stack was not running)"

  echo
  echo "✅  Goldilocks dev stopped. Data and identities are kept — 'Start' brings it back."
}

# True if $1 is one of the explicitly-listed sims that dev_reset erases
# wholesale — no point uninstalling the app from it first, the erase wipes it.
sim_will_be_erased() {
  local target="$1" s
  for s in $GOLDILOCKS_SIMS; do
    [[ "$s" == "$target" ]] && return 0
  done
  return 1
}

dev_reset() {
  echo "🛑  Goldilocks dev: bringing everything down + wiping state"
  echo
  echo "   dedicated sims to erase (GOLDILOCKS_SIMS): ${GOLDILOCKS_SIMS:-none}"
  echo "   Convos bundle id: $CONVOS_BUNDLE_ID"
  echo

  echo "→ docker compose down -v (wipes Postgres + XMTP data)"
  ( cd "$BACKEND" && docker compose down -v ) || echo "   (stack was not running)"

  echo "→ removing .agent-data (admins/reports private keys)"
  rm -rf "$BACKEND/.agent-data"

  # Erase the ./dev/sim simulator if it exists — not just uninstall the
  # app, but wipe the entire device including keychain. The XMTP identity
  # key lives in the keychain and survives app uninstall. If the key
  # persists, the next app install reuses the same inbox but creates a
  # new XMTP installation, leading to stale-installation MLS failures
  # ("Setting up your channels..." forever).
  local dev_sim_file
  dev_sim_file="$(dirname "$BACKEND")/.dev-sim-id"
  if [[ -f "$dev_sim_file" ]]; then
    local dev_sim
    dev_sim=$(cat "$dev_sim_file")
    echo "→ erasing dev simulator $dev_sim (clears keychain + app data)"
    run_timeout 20 xcrun simctl shutdown "$dev_sim" >/dev/null 2>&1 || true
    if run_timeout 45 xcrun simctl erase "$dev_sim" >/dev/null 2>&1; then
      echo "   erased"
    else
      echo "   erase failed (continuing)"
    fi
  fi

  echo "→ uninstalling Convos from booted simulators"
  local booted
  booted=$(run_timeout 20 xcrun simctl list devices 2>/dev/null | grep "Booted" | grep -oE '[0-9A-Fa-f-]{36}')
  if [[ -n "$booted" ]]; then
    echo "   booted: $(echo "$booted" | tr '\n' ' ')"
    while IFS= read -r sim; do
      if sim_will_be_erased "$sim"; then
        echo "   $sim (booted) — in GOLDILOCKS_SIMS, will be erased below; skipping uninstall"
        continue
      fi
      echo "   $sim (booted) — uninstalling Convos (up to 20s)…"
      SECONDS=0
      if run_timeout 20 xcrun simctl uninstall "$sim" "$CONVOS_BUNDLE_ID" >/dev/null 2>&1; then
        echo "   $sim — uninstalled (${SECONDS}s)"
      else
        echo "   $sim — uninstall timed out/failed after ${SECONDS}s (continuing)"
      fi
    done <<< "$booted"
  else
    echo "   (no booted simulators)"
  fi

  # Walk every goldilocks-* sim. Skip sims that will be erased anyway, and
  # sims that don't even have Convos installed; process the rest in parallel
  # so we pay one boot's wall-time instead of N.
  echo "→ uninstalling Convos from goldilocks-* simulators (skip clean/erased sims; parallelize the rest)"
  local gold_sims
  gold_sims=$(run_timeout 20 xcrun simctl list devices 2>/dev/null | grep -i 'goldilocks-' | grep -oE '[0-9A-Fa-f-]{36}')
  if [[ -n "$gold_sims" ]]; then
    echo "   goldilocks-* sims: $(echo "$gold_sims" | tr '\n' ' ')"
    local pids=()
    while IFS= read -r sim; do
      if sim_will_be_erased "$sim"; then
        echo "   $sim — in GOLDILOCKS_SIMS, will be erased below; skipping"
        continue
      fi
      if ! run_timeout 20 xcrun simctl get_app_container "$sim" "$CONVOS_BUNDLE_ID" app >/dev/null 2>&1; then
        echo "   $sim — Convos not installed, skipping"
        continue
      fi
      (
        echo "   $sim — booting + uninstalling…"
        run_timeout 90 xcrun simctl boot "$sim" >/dev/null 2>&1 || true
        run_timeout 20 xcrun simctl uninstall "$sim" "$CONVOS_BUNDLE_ID" >/dev/null 2>&1 || true
        run_timeout 20 xcrun simctl shutdown "$sim" >/dev/null 2>&1 || true
        echo "   $sim — done"
      ) &
      pids+=($!)
    done <<< "$gold_sims"
    # Guard the expansion: under `set -u`, bash 3.2 (macOS default)
    # errors on "${pids[@]}" when the array is empty — which happens
    # whenever every goldilocks-* sim was skipped above.
    if (( ${#pids[@]} > 0 )); then
      for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
    fi
  else
    echo "   (no goldilocks-* simulators found)"
  fi

  # shellcheck disable=SC2206
  local sims=($GOLDILOCKS_SIMS)
  if (( ${#sims[@]} > 0 )); then
    echo "→ erasing explicitly-listed simulators (GOLDILOCKS_SIMS)"
    for sim in "${sims[@]}"; do
      echo "   $sim — shutting down + erasing (up to 65s)…"
      SECONDS=0
      run_timeout 20 xcrun simctl shutdown "$sim" >/dev/null 2>&1 || true
      if run_timeout 45 xcrun simctl erase "$sim" >/dev/null 2>&1; then
        echo "   $sim — erased (${SECONDS}s)"
      else
        echo "   $sim — erase timed out/failed after ${SECONDS}s (continuing)"
      fi
    done
  fi

  echo
  echo "✅  Goldilocks dev is off."
}

dev_status() {
  echo "📦  Containers:"
  ( cd "$BACKEND" && docker compose ps 2>/dev/null ) || echo "   (not running)"
  echo
  echo "📱  Booted simulators:"
  run_timeout 30 xcrun simctl list devices 2>/dev/null | grep "Booted" || echo "   (none)"
}

case "${1:-}" in
  up) dev_up ;;
  down) dev_down ;;
  reset) dev_reset ;;
  status) dev_status ;;
  *) echo "usage: dev-env.sh up|down|reset|status" >&2; exit 1 ;;
esac
