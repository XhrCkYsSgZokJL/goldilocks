# Goldilocks dev shortcuts — `goldilocks-off`, `goldilocks-on`, `goldilocks-status`.
#
# Source from your ~/.zshrc:
#
#   source ~/Desktop/git/goldilocks-backend/scripts/goldilocks.zsh
#
# Override the env vars below if your repos live elsewhere.

export GOLDILOCKS_BACKEND="${GOLDILOCKS_BACKEND:-$HOME/Desktop/git/goldilocks-backend}"
export GOLDILOCKS_IOS="${GOLDILOCKS_IOS:-$HOME/Desktop/git/goldilocks-ios}"
# iOS bundle id — keychain entries are scoped to this. Adjust if you rebrand.
export CONVOS_BUNDLE_ID="${CONVOS_BUNDLE_ID:-org.convos.ios-local}"

# Optional: UDIDs of dedicated Goldilocks sims to fully erase on `goldilocks-off`.
# Find UDIDs with: xcrun simctl list devices | grep -i goldilocks
# Example:
#   export GOLDILOCKS_SIMS=(07E53492-CCB5-4732-80C0-D5DF3C762A88 D23B87D1-A42F-448A-B77F-D7944DE12AC3)
export GOLDILOCKS_SIMS=(F6DCC975-A4C8-46A9-81B2-66D0ECE11249)

goldilocks-off() {
  echo "🛑  Goldilocks: bringing everything down + wiping state"
  echo

  echo "→ goldilocks-backend stack down (-v wipes Postgres volume)"
  ( cd "$GOLDILOCKS_BACKEND" && docker compose down -v ) || echo "   (backend stack was not running)"

  echo "→ goldilocks-ios XMTP node down (-v wipes node data)"
  ( cd "$GOLDILOCKS_IOS" && docker compose -f dev/docker-compose.yml -p convos-ios down -v ) || echo "   (XMTP node was not running)"

  echo "→ removing .agent-data (admins/reports private keys)"
  rm -rf "$GOLDILOCKS_BACKEND/.agent-data"

  echo "→ uninstalling Convos from booted simulators"
  local booted
  booted=$(xcrun simctl list devices 2>/dev/null | grep "Booted" | grep -oE '[0-9A-Fa-f-]{36}')
  if [[ -n "$booted" ]]; then
    while IFS= read -r sim; do
      echo "   uninstalling from $sim (booted)"
      xcrun simctl uninstall "$sim" "$CONVOS_BUNDLE_ID" 2>/dev/null || true
    done <<< "$booted"
  else
    echo "   (no booted simulators)"
  fi

  # Walk every goldilocks-* sim. For each, skip if Convos isn't even
  # installed (no keychain to wipe → no work needed); for the rest,
  # process them in parallel so we pay one boot's wall-time instead of N.
  echo "→ uninstalling Convos from goldilocks-* simulators (skip clean sims; parallelize the rest)"
  local gold_sims
  gold_sims=$(xcrun simctl list devices 2>/dev/null | grep -i 'goldilocks-' | grep -oE '[0-9A-Fa-f-]{36}')
  if [[ -n "$gold_sims" ]]; then
    local pids=()
    while IFS= read -r sim; do
      # `simctl get_app_container` works regardless of boot state. Exit
      # code 0 means the bundle is installed; non-zero means it isn't,
      # which means there's no keychain entry to clear and we can skip
      # the boot/uninstall cycle entirely.
      if ! xcrun simctl get_app_container "$sim" "$CONVOS_BUNDLE_ID" app >/dev/null 2>&1; then
        echo "   $sim — Convos not installed, skipping"
        continue
      fi
      # Process in the background. Each pipeline boots, uninstalls,
      # shuts down its own sim independently. Parallel boots are
      # well-supported by simctl; the host CPU just does more work
      # during the same window.
      (
        echo "   $sim — booting + uninstalling"
        xcrun simctl boot "$sim" 2>/dev/null || true
        xcrun simctl uninstall "$sim" "$CONVOS_BUNDLE_ID" 2>/dev/null || true
        xcrun simctl shutdown "$sim" 2>/dev/null || true
        echo "   $sim — done"
      ) &
      pids+=($!)
    done <<< "$gold_sims"
    # Wait for every parallel uninstall to finish before declaring "off".
    for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  else
    echo "   (no goldilocks-* simulators found)"
  fi

  if (( ${#GOLDILOCKS_SIMS[@]} > 0 )); then
    echo "→ erasing explicitly-listed simulators in GOLDILOCKS_SIMS"
    for sim in "${GOLDILOCKS_SIMS[@]}"; do
      echo "   erasing $sim"
      xcrun simctl shutdown "$sim" 2>/dev/null || true
      xcrun simctl erase "$sim" 2>/dev/null || true
    done
  fi

  echo
  echo "✅  Goldilocks is off."
}

goldilocks-on() {
  echo "🟢  Goldilocks: bringing services up"
  echo

  echo "→ starting goldilocks-ios XMTP node"
  ( cd "$GOLDILOCKS_IOS" && ./dev/up ) || { echo "❌  XMTP node failed to start"; return 1; }

  echo "→ starting goldilocks Postgres (waiting for healthcheck)"
  # `--wait` blocks until the service's healthcheck passes. The compose
  # file uses `pg_isready -U goldilocks -d goldilocks` which only flips
  # green after initdb finishes — important because the TCP port opens
  # earlier and a `nc -z` ready check would race the migrations.
  ( cd "$GOLDILOCKS_BACKEND" && docker compose up -d --wait goldilocks-db ) || { echo "❌  Postgres failed to become healthy"; return 1; }

  echo "→ running migrations"
  # Belt and suspenders: the healthcheck guarantees pg is accepting
  # connections, but initdb can still slam the door for a beat right at
  # the boundary. Retry up to 3 times before giving up.
  local attempt
  for attempt in 1 2 3; do
    if ( cd "$GOLDILOCKS_BACKEND" && npm run migrate ); then
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
  echo "✅  Goldilocks is on. You still need to start:"
  echo "   • Backend:  cd $GOLDILOCKS_BACKEND && npm run server:dev"
  echo "   • Agent:    cd $GOLDILOCKS_BACKEND && npm run agents:dev"
}

goldilocks-status() {
  echo "📦  Containers:"
  ( cd "$GOLDILOCKS_BACKEND" && docker compose ps 2>/dev/null )
  ( cd "$GOLDILOCKS_IOS" && docker compose -f dev/docker-compose.yml -p convos-ios ps 2>/dev/null )
  echo
  echo "🐘  Postgres on :25433:"
  if nc -z localhost 25433 2>/dev/null; then
    echo "   ✅ ready"
  else
    echo "   ❌ down"
  fi
  echo
  echo "📱  Booted simulators:"
  xcrun simctl list devices 2>/dev/null | grep "Booted" || echo "   (none)"
}
