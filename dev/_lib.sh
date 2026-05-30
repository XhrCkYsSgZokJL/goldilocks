#!/bin/bash
# Shared helpers for dev/ scripts. Source this, don't execute it.

DEV_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_ROOT="$(dirname "$DEV_SCRIPT_DIR")"
DEV_BACKEND="$DEV_ROOT/backend"

# Docker compose wrapper — targets the unified goldilocks stack.
goldilocks_compose() {
  docker compose -f "$DEV_BACKEND/docker-compose.yml" "$@"
}

clean_old_logs() {
  local name="$1"
  local dir="$DEV_BACKEND/.dev-run"
  local -a old
  old=($(ls -t "$dir/${name}"-*.log 2>/dev/null | tail -n +2))
  if [ ${#old[@]} -gt 0 ]; then
    rm -f "${old[@]}"
  fi
}

stop_background_processes() {
  cd "$DEV_BACKEND"
  for proc in server agent simulator caddy stripe; do
    if [ -f ".dev-run/${proc}.pid" ]; then
      pid=$(cat ".dev-run/${proc}.pid" 2>/dev/null || true)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        echo "  ✓ $proc stopped"
      fi
      rm -f ".dev-run/${proc}.pid"
    fi
  done
  pkill -f "src/server.ts" 2>/dev/null || true
  pkill -f "src/agent/index.ts" 2>/dev/null || true
}
