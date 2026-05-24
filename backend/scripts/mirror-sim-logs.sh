#!/usr/bin/env bash
# Mirror the booted iOS simulator's Convos logs to stdout, so the dev
# tooling can capture them into .dev-run alongside the server + agent
# logs (the TUI runs this as the "simulator" managed process).
#
# Two log sources live in the app's shared app-group container:
#   • Logs/convos.log   — the Swift-side app log (the `convos:` lines)
#   • xmtp-logs/*.log   — libxmtp's rotating debug logs
#
# Every streamed line is prefixed with its source filename. The booted
# simulator + app container are re-resolved on a loop, so a reinstall
# (which changes the container UUID) and libxmtp's hourly log rotation
# are both picked up without restarting.
set -uo pipefail

BUNDLE_ID="${CONVOS_BUNDLE_ID:-org.convos.ios-local}"
GROUP_ID="${CONVOS_APP_GROUP:-group.org.convos.ios-local}"

echo "[sim-logs] watching the booted simulator for Convos logs…"

container=""
seen=()

while true; do
  # A booted simulator is required; otherwise wait and retry.
  sim=$(xcrun simctl list devices 2>/dev/null | grep "Booted" | grep -oE '[0-9A-Fa-f-]{36}' | head -1)
  if [[ -z "$sim" ]]; then
    sleep 3
    continue
  fi

  # Resolve the Convos shared app-group container on that simulator.
  resolved=$(xcrun simctl get_app_container "$sim" "$BUNDLE_ID" "$GROUP_ID" 2>/dev/null || true)
  if [[ -z "$resolved" || ! -d "$resolved" ]]; then
    sleep 3
    continue
  fi

  # New container (reinstall / different simulator) — start fresh. Old
  # `tail` followers are left on the now-dead path; they idle harmlessly
  # and are reaped when this process group is stopped.
  if [[ "$resolved" != "$container" ]]; then
    container="$resolved"
    seen=()
    echo "[sim-logs] mirroring Convos logs from $container"
  fi

  # Attach a follower to any *.log we are not already streaming.
  for dir in "$container/Logs" "$container/xmtp-logs"; do
    [[ -d "$dir" ]] || continue
    for f in "$dir"/*.log; do
      [[ -f "$f" ]] || continue
      already=""
      if (( ${#seen[@]} > 0 )); then
        for s in "${seen[@]}"; do
          [[ "$s" == "$f" ]] && already=1 && break
        done
      fi
      [[ -n "$already" ]] && continue
      seen+=("$f")
      name=$(basename "$f")
      echo "[sim-logs] + following $name"
      ( tail -n +1 -F "$f" 2>/dev/null | sed "s|^|[$name] |" ) &
    done
  done

  sleep 5
done
