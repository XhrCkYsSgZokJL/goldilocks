# Upstream Sync Plan — Convos → Goldilocks

_Generated 2026-05-20. Re-run the analysis after a fresh `git fetch upstream`._

## Snapshot

- **Fork point:** `4c47949b` — "Add Cloud Connections v0.1 (#719)", 2026-04-27.
- **Upstream tip:** `upstream/dev` @ `ba90faf4`, 2026-05-20.
- **Behind by:** 118 upstream commits.
- **File spread:** upstream changed 543 files; Goldilocks changed 74; **35 files overlap** (the conflict zone).

The local `upstream/*` tracking branches are current as of today, but my sandbox can't reach GitHub — run `git fetch upstream` on your Mac before executing this plan to confirm nothing newer landed.

## Approach

Do **not** merge `upstream/dev` wholesale. A merge drags in the Contacts MVP (~40 commits, the biggest conflict source) and forces all 35 overlapping files at once.

Instead: cherry-pick discrete PRs onto a dedicated branch, in waves, building and testing between waves.

```
git fetch upstream
git checkout goldilocks && git checkout -b upstream-sync
# cherry-pick PR squash-commits, e.g.:
git cherry-pick -x 8ae258f9
# build + swift test after each wave, then gt submit / PR
```

Most PRs are squash-merged, so each `(#NNN)` commit is the whole PR — one cherry-pick per PR.

## The conflict zone (35 overlapping files)

These hold Goldilocks customizations — any upstream change here needs a hand-merge, not a blind cherry-pick:

- **API layer** — `ConvosAPIClient.swift`, `ConvosAPIClient+Models.swift`, `MockAPIClient.swift` (all the Goldilocks endpoints + subscription plumbing).
- **Session** — `SessionManager.swift`, `SessionManagerProtocol.swift` (Goldilocks registration, channel lifecycle, subscription requests).
- **Conversations** — `ConversationsView.swift`, `ConversationsViewModel.swift`, `Conversation.swift` (role banner, plan chip, staleness filter, empty-placeholder filter).
- **Consent/sync** — `ConversationConsentWriter.swift`, `ConversationWriter.swift`, `StreamProcessor.swift`, `SessionStateMachine.swift` (agent-trust, no-op consent delete).
- **UI** — `AppSettingsView.swift`, `DebugView.swift`, `AvatarView.swift`.
- **Build** — `project.pbxproj`, `.gitignore`, `Local.xcconfig`, `config.local.json`, `Scripts/hooks/{pre-commit,pre-push}`.

71 of the 118 upstream commits touch **none** of these — those are the low-risk pulls.

## Wave 1 — Pull now (safe, isolated, clear value)

Clean cherry-picks; none touch the conflict zone. Build + test once at the end of the wave.

| PR | What | Why |
|----|------|-----|
| #822 | Re-anchor messages list when keyboard appears | Chat UX fix — applies to Advisory/Reports |
| #772 | Reactions drawer self-sizes to content | UI fix |
| #818 | Fix drawer title clipping | UI fix |
| #794 | Fix bodyContent type-check timeout in MessagesBottomBar | Build-health |
| #773 | CLAUDE.md type-check timeout rules | Docs only |
| #763 | Invites: split `conversationExpired` into not-found / consent-not-allowed | Correctness |
| #766 | Quickname: flip per-conversation flag on apply | Correctness |
| #762 | fix(connections): republish metadata for orphaned grants | Only relevant if Goldilocks uses Cloud Connections |

## Wave 2 — Pull with care (touches the conflict zone — hand-merge)

Do these one at a time, build + test after each.

- **libxmtp bump** to `ios-4.10.0-nightly.20260516.42c6bd1` (upstream/dev's settled pin). Keeping the XMTP protocol current matters for security and interop. Note upstream churned here (4.9 → 4.10 → revert → 4.10) — take only the final pin. Update the `revision:` in `ConvosCore/Package.swift`, rebuild, and run the **full** `swift test` suite against a local XMTP node.
- **#815** Don't drop libxmtp DB on `.inactive` launches — real stability fix; touches session/launch code Goldilocks also changed.
- **#780** Fix invite DM push subscriptions — touches push code.
- **`978f39a4`** "delete-all gets all tables, not just conversations" — completeness fix for Delete All Data.
- **#768** pre-commit hook bash 3.2 compatibility — Goldilocks already fixed this independently; reconcile the two (likely just take upstream's version of the hook).

## Wave 3 — Optional / larger (defer; decide later)

- **HTML & file attachments** — #803, #825, #821, #820, #819, #806 (HTML rendering + Chat|Stuff paging), #791 (multi-attachment composer), #790 (send Files). Genuinely useful for the concierge chats (clients sending documents to advisors), but medium effort and touches the message composer. Treat as its own mini-project.
- **#771** Connections capability resolution v1 — extends Cloud Connections. Pull only if Goldilocks actually uses Connections.

## Skip (conflicts with Goldilocks direction, or already reverted upstream)

- **Contacts MVP** — ~40 commits (#775 PRD, #782 part 1, part 2, #844, …). A full contact-list / contact-picker / blocking / DM-from-contacts system. Off-strategy for a security concierge where clients don't build address books, and it's the single largest conflict source. Skip entirely.
- **SIWE auth #827 / #846** — upstream built their own SIWE flow for their v2 backend. Goldilocks already has `GoldilocksAuth` + `/v2/auth/challenge` + `/v2/me`. **Keep ours.** But read #846 ("share SIWE signing context across ConvosAPIClient instances") — if it's fixing a real bug where multiple client instances each re-sign, check whether Goldilocks' code has the same flaw. See the decision note below.
- **Assistants on by default #817** (and #770, #769) — you just removed the Assistants row; don't re-enable.
- **Backups / iCloud backup #760 / #778 / #725** — upstream reverted all of this (`c74f475b`) to stabilize `dev`. It's not even in `upstream/dev` anymore. Skip.
- **Firebase / fastlane CI #785** and related — Goldilocks runs its own CI and archived the upstream workflows. Skip.

## Key decision — SIWE auth

This is the one to think hardest about. Upstream's #827 is a parallel SIWE implementation for *their* backend; Goldilocks shipped its own SIWE against the Goldilocks backend. They will collide in `ConvosAPIClient.swift`. Recommendation: keep the Goldilocks implementation, do **not** cherry-pick #827/#846, but review #846's diff once — it may expose a signing-context bug worth replicating in `GoldilocksAuth`.

## Housekeeping

While in here: `convos-ios-safety-20260430-151834.bundle` (a 43k-line migration backup) is committed in the repo. Remove it — `git rm convos-ios-safety-*.bundle` — and add `*.bundle` to `.gitignore`.

## Execution checklist

1. `git fetch upstream` (on the Mac) and re-confirm the commit list.
2. Branch: `git checkout goldilocks && git checkout -b upstream-sync`.
3. Wave 1 — cherry-pick the 8 PRs, build, `swift test`, lint.
4. Wave 2 — one PR at a time + the libxmtp bump; build + full test suite after each.
5. Wave 3 — only if/when you want the attachment features.
6. PR `upstream-sync` into `goldilocks` once green.
