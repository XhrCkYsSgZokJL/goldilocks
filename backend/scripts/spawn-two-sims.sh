#!/usr/bin/env bash
# Spawn two iOS Simulators side-by-side for the Goldilocks dev workflow.
#
#   - goldilocks-admin   Goldilocks team simulator. Auto-promoted to admin
#                        via direct SQL after its inbox lands in `clients`.
#   - goldilocks-client  Customer simulator. Discovers admin inbox(es) from
#                        /v2/admins on launch and uses them as recipients
#                        when creating Advisory + Reports.
#
# Why SQL instead of an iOS-side promote-self call:
# the database is already the source of truth for who's an admin, and an
# INSERT here doesn't expose any new endpoint or rely on iOS launch-arg
# plumbing. The admin sim then needs a relaunch to re-fetch /v2/me with
# isAdmin=true, which the script does for you.
#
# Usage:
#   ./scripts/spawn-two-sims.sh
#
# Tunables (env):
#   SIM_DEVICE          iPhone model to clone from (default: "iPhone 17 Pro")
#   CONVOS_DIR          path to monorepo root
#   APP_PATH            full path to Convos.app (skip auto-detect)
#   ADMIN_WAIT_SECS     how long to wait for admin to register (default: 60)

set -uo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
COMPOSE_FILE="$SCRIPT_DIR/../docker-compose.yml"

CONVOS_DIR="${CONVOS_DIR:-$(dirname "$(dirname "$SCRIPT_DIR")")}"
SIM_DEVICE="${SIM_DEVICE:-iPhone 17 Pro}"
ADMIN_WAIT_SECS="${ADMIN_WAIT_SECS:-60}"
BUNDLE_ID="org.convos.ios-local"

readonly RED=$'\e[31m'
readonly GREEN=$'\e[32m'
readonly YELLOW=$'\e[33m'
readonly BOLD=$'\e[1m'
readonly RESET=$'\e[0m'

err()  { echo "${RED}error:${RESET} $*" >&2; }
info() { echo "${GREEN}>${RESET} $*" >&2; }
warn() { echo "${YELLOW}!${RESET} $*" >&2; }

find_app_bundle() {
    if [ -n "${APP_PATH:-}" ] && [ -d "${APP_PATH}" ]; then
        echo "$APP_PATH"
        return 0
    fi
    local local_dd="$CONVOS_DIR/.derivedData/Build/Products/Local-iphonesimulator/Convos.app"
    if [ -d "$local_dd" ]; then echo "$local_dd"; return 0; fi
    local default_dd="$HOME/Library/Developer/Xcode/DerivedData"
    if [ -d "$default_dd" ]; then
        local found
        found=$(/usr/bin/find "$default_dd" -maxdepth 6 -type d \
            -path "*Convos-*/Build/Products/Local-iphonesimulator/Convos.app" \
            -print 2>/dev/null | head -1)
        if [ -n "$found" ]; then echo "$found"; return 0; fi
    fi
    return 1
}

prepare_sim() {
    local sim_name="$1"
    local sim_id
    sim_id=$(xcrun simctl list devices --json 2>/dev/null \
        | grep -B 1 "\"name\" : \"$sim_name\"" \
        | grep -oE '[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}' \
        | head -1 || true)
    if [ -n "$sim_id" ]; then
        info "  reusing $sim_name ($sim_id) — erasing"
        xcrun simctl shutdown "$sim_id" >/dev/null 2>&1 || true
        xcrun simctl erase "$sim_id" >/dev/null 2>&1 || true
    else
        info "  creating $sim_name"
        sim_id=$(xcrun simctl create "$sim_name" "$SIM_DEVICE")
    fi
    xcrun simctl boot "$sim_id" >/dev/null 2>&1 || true
    echo "$sim_id"
}

install_and_launch() {
    local sim_id="$1"
    local app="$2"

    if ! xcrun simctl install "$sim_id" "$app" >/dev/null 2>&1; then
        err "  install failed for $sim_id"
        return 1
    fi
    xcrun simctl launch "$sim_id" "$BUNDLE_ID" >/dev/null 2>&1 || true
}

# Run a SQL command via the goldilocks-db Docker container. Returns stdout.
sql() {
    docker compose -f "$COMPOSE_FILE" exec -T goldilocks-db \
        psql -U goldilocks -d goldilocks -t -A -c "$1" 2>/dev/null \
        | tr -d ' \r\n'
}

# Wait for `clients` to gain a row that's NOT already in admin_inboxes.
# That'll be the freshly-launched admin sim's inbox.
wait_for_new_client_inbox() {
    local elapsed=0
    while [ "$elapsed" -lt "$ADMIN_WAIT_SECS" ]; do
        local inbox
        inbox=$(sql "
            SELECT c.inbox_id FROM clients c
            LEFT JOIN admin_inboxes a ON a.inbox_id = c.inbox_id
            WHERE a.inbox_id IS NULL
            ORDER BY c.created_at DESC
            LIMIT 1;
        " || true)
        if [ -n "$inbox" ] && [ ${#inbox} -eq 64 ]; then
            echo "$inbox"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
        printf "." >&2
    done
    echo "" >&2
    return 1
}

main() {
    info "Looking for Convos.app..."
    local app
    app=$(find_app_bundle) || true
    if [ -z "${app:-}" ] || [ ! -d "${app:-}" ]; then
        err "Couldn't find Convos.app — build the Local scheme on any iPhone simulator first."
        exit 1
    fi
    info "App bundle: $app"

    # 1. Boot the admin sim and let it register normally.
    info "Spinning up admin simulator..."
    local admin_id
    admin_id=$(prepare_sim "goldilocks-admin")
    install_and_launch "$admin_id" "$app"

    open -a Simulator || true

    # 2. Wait for admin sim's inbox to land in `clients`.
    info "Waiting up to ${ADMIN_WAIT_SECS}s for admin sim to register..."
    local admin_inbox
    admin_inbox=$(wait_for_new_client_inbox || true)
    if [ -z "$admin_inbox" ]; then
        err "Admin sim didn't register within ${ADMIN_WAIT_SECS}s. Is the backend up?"
        exit 1
    fi
    info "  admin sim's inbox: ${admin_inbox:0:16}…"

    # 3. Promote it via SQL.
    info "Promoting admin sim via SQL..."
    sql "INSERT INTO admin_inboxes (inbox_id, name) VALUES ('$admin_inbox', 'goldilocks-admin sim') ON CONFLICT DO NOTHING;" >/dev/null
    info "  done"

    # 4. Cold-relaunch admin app so it re-fetches /v2/me with isAdmin=true.
    info "Cold-relaunching admin app to pick up admin status..."
    xcrun simctl terminate "$admin_id" "$BUNDLE_ID" >/dev/null 2>&1 || true
    sleep 1
    xcrun simctl launch "$admin_id" "$BUNDLE_ID" >/dev/null 2>&1 || true

    # 5. Boot the client sim. By now /v2/admins includes the admin sim's inbox.
    info "Spinning up client simulator..."
    local client_id
    client_id=$(prepare_sim "goldilocks-client")
    install_and_launch "$client_id" "$app"

    cat <<EOF >&2

${BOLD}Both simulators are now running.${RESET}

  ${BOLD}goldilocks-admin${RESET}   $admin_id
  ${BOLD}goldilocks-client${RESET}  $client_id

What to expect:
  • goldilocks-admin   shows the red "Admin mode" banner. The admin home
                       screen lists every client's Advisory + Reports
                       channels. No "Open channels" CTA.
  • goldilocks-client  tap "Open channels" to create Advisory + Reports.
                       Recipient member is the admin sim's inbox (fetched
                       from /v2/admins).

Inspect state:
  docker compose -f goldilocks-backend/docker-compose.yml exec goldilocks-db \\
    psql -U goldilocks -d goldilocks -c \\
    "SELECT inbox_id, name FROM admin_inboxes; \\
     SELECT client_number, inbox_id FROM clients; \\
     SELECT c.client_number, cc.role, cc.status FROM client_channels cc \\
       JOIN clients c ON c.id = cc.client_id;"

EOF
}

main "$@"
