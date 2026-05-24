# Goldilocks CLI launcher.
#
# Source this from your ~/.zshrc:
#   source ~/Desktop/git/goldilocks-backend/scripts/goldilocks.zsh
#
# Then run `goldilocks` from anywhere:
#   goldilocks                 open the interactive control panel
#   goldilocks admins list     run a non-interactive subcommand
#   goldilocks help            list every subcommand
#
# This replaces the old goldilocks-on / goldilocks-off / goldilocks-status
# shell functions — everything they did now lives inside the CLI, under
# "Local dev environment".

export GOLDILOCKS_BACKEND="${GOLDILOCKS_BACKEND:-$HOME/Desktop/git/goldilocks-backend}"

goldilocks() {
  ( cd "$GOLDILOCKS_BACKEND" && npm run --silent cli -- "$@" )
}
