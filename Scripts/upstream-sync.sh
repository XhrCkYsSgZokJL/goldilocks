#!/bin/bash
#
# Upstream sync — cherry-picks the agreed Convos upstream PRs onto an
# `upstream-sync` branch, in three waves. See docs/plans/upstream-sync.md
# for the rationale and what was deliberately skipped (Contacts MVP,
# upstream SIWE auth, assistants, backups, CI).
#
# Run from anywhere inside the repo, on your Mac (needs network for the
# fetch). Cherry-picks that conflict halt the script — resolve the files,
# run `git add -A && git cherry-pick --continue`, then re-run this script.
# Commits already applied are detected and skipped, so re-running is safe.
#
#   bash Scripts/upstream-sync.sh
#
set -u

cd "$(git rev-parse --show-toplevel)" || exit 1

# --- preflight -------------------------------------------------------
# Only block on uncommitted changes to *tracked* files — untracked files
# (this script, the plan doc) don't affect cherry-picks.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Working tree has uncommitted changes to tracked files — commit or"
  echo "stash them first, then re-run."
  exit 1
fi

echo "→ fetching upstream"
git fetch upstream || { echo "git fetch upstream failed"; exit 1; }

# Branch off goldilocks, or resume an existing sync branch.
if git show-ref --verify --quiet refs/heads/upstream-sync; then
  git checkout upstream-sync || exit 1
else
  git checkout goldilocks || exit 1
  git checkout -b upstream-sync || exit 1
fi

# Cherry-pick one commit. Skips it if already applied (detected via the
# `-x` "cherry picked from" marker), halts the script on conflict.
pick() {
  local hash="$1" desc="$2"
  if git log --grep="cherry picked from commit ${hash}" --format=%h | grep -q .; then
    echo "  [skip] ${desc} — already applied"
    return 0
  fi
  echo "  [pick] ${hash} — ${desc}"
  if ! git cherry-pick -x "$hash"; then
    echo ""
    echo "✋ Conflict on ${hash} (${desc})."
    echo "   1. Resolve the conflicted files (these touch Goldilocks code —"
    echo "      keep our customizations, fold in the upstream change)."
    echo "   2. git add -A && git cherry-pick --continue"
    echo "   3. Re-run: bash Scripts/upstream-sync.sh"
    exit 1
  fi
}

# ---------------------------------------------------------------------
echo ""
echo "=== Wave 1 — safe UI / correctness fixes (no Goldilocks overlap) ==="
pick def77019 "#763 invites: split conversationExpired"
pick e62840a1 "#762 connections: republish orphaned grant metadata"
pick 3565b95e "#766 quickname: flip per-conversation flag on apply"
pick 0422384b "#772 reactions drawer self-sizes to content"
pick 1fd7ca81 "#773 CLAUDE.md type-check timeout rules"
# #794 (MessagesBottomBar type-check timeout) intentionally skipped — it
# fixes bloat introduced by upstream-only work we aren't pulling; our copy
# of the file is untouched and compiles fine.
pick 39995d43 "#818 fix drawer title clipping"
pick 8ae258f9 "#822 re-anchor messages list when keyboard appears"

# ---------------------------------------------------------------------
echo ""
echo "=== Wave 2 — careful (these touch files Goldilocks changed) ==="
echo ""
echo "  >>> MANUAL STEP — libxmtp bump <<<"
echo "  Edit ConvosCore/Package.swift and set the libxmtp dependency"
echo "  revision to:  ios-4.10.0-nightly.20260516.42c6bd1"
echo "  Then rebuild so Package.resolved regenerates. Commit that on its"
echo "  own before continuing. (Not cherry-picked — upstream churned the"
echo "  pin several times; we want only the final value.)"
echo ""
pick 74e238cb "#768 pre-commit hook bash 3.2 compat (we fixed this too — reconcile)"
pick 5820a54c "#780 fix invite DM push subscriptions"
pick 3d72da3b "#815 don't drop libxmtp DB on .inactive launches"

# ---------------------------------------------------------------------
echo ""
echo "=== Wave 3 — attachments / HTML (larger; expect conflicts) ==="
pick 67a451f7 "#790 allow sending Files"
pick 3aa73037 "#791 multi-attachment composer"
pick 7c917c26 "#803 render HTML attachments in a WKWebView sheet"
pick a7f86ad3 "#806 inline HTML + Chat|Stuff paging"
pick feaa62fa "#816 route Stuff search through FocusCoordinator"
pick adaf4ea9 "#819 make Stuff list reactive"
pick d957e66c "#820 route Save to Files for non-photo attachments"
pick dcd14ab5 "#821 HTML attachment cell height"
pick 15f2af8c "#825 HTML thumbnails via PDFKit"
pick b58373c5 "#771 connections capability resolution v1"

# ---------------------------------------------------------------------
echo ""
echo "✅ All three waves cherry-picked onto 'upstream-sync'."
echo ""
echo "Now, before merging back into goldilocks:"
echo "  1. Do the libxmtp Package.swift bump (Wave 2 manual step) if not done."
echo "  2. Build the app in Xcode (Convos (Local) scheme)."
echo "  3. Full test suite:  ./dev/up && swift test --package-path ConvosCore && ./dev/down"
echo "  4. /lint"
echo "  5. Open a PR: upstream-sync -> goldilocks"
