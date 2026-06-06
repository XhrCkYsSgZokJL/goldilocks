# Upstream Strategy — Rebase the Fork (supersedes per-PR cherry-picking)

_Authored 2026-06-06. This replaces the cherry-pick approach in `upstream-sync.md` for the bulk catch-up. That doc's per-PR analysis stays useful as a feature-by-feature reference, but the "pull discrete PRs onto our fork" mechanism is a dead end at our current distance — see below._

## Why the strategy changes

We tried to execute the cherry-pick plan and hit a wall: **every single "clean" Wave-1 pick conflicts.** Not because of our edits — because the fork is **~160 PRs / 2.5 months behind `upstream/dev`**, and each upstream fix sits on top of intermediate refactors we deliberately skipped:

- #1001 (the OOM crash fix) is built on #857's "cache-first loadImage" rewrite we don't have.
- #896 sits on the batch-catch-up refactor.
- #933/#957 land in a `MainTabView` that diverged across 6 skipped commits.
- #1008 needs the evolved `FocusCoordinator`.

Cherry-picking pulls a fix *backward* onto an old base whose surrounding code no longer matches. At 160 PRs of drift, that fails for essentially everything. **Pulling upstream toward us is the wrong direction. We should move our base up to upstream and replay our delta on top.**

## The inversion

Stop maintaining Goldilocks as `old-upstream + 160-PRs-of-manual-backports`. Instead:

> **Goldilocks = `upstream/dev` (latest) + a well-defined, isolated Goldilocks delta, replayed on top.**

This is the standard "rebase the fork" model. It's a one-time reconciliation to get current, after which we stay close to upstream with a cheap periodic cadence.

## Refined model (2026-06-06): base → disable → apply-ours

Sharper framing, in three ordered layers:

1. **Base = `upstream/dev`, whole.** Branching from dev means we already *have* every upstream feature — agents, contacts, IAP, observability, all 160 PRs — for free. "Bring everything up to speed" costs nothing; it's the starting point, not a task.

2. **Disable layer (hybrid policy).** Rather than excise unwanted features, neutralize them — but the policy differs by risk:
   - **Pure-UI / behavioral features → gate cheaply.** Agents UI, agent-contacts, the StoreKit purchase UI: hide entry points + a `FeatureFlags` switch. Keep upstream's files intact so future merges don't fight us on them.
   - **Third-party SDKs / data-transmitting code → strip.** Composio (connections), PostHog + Sentry (telemetry), and the StoreKit/IAP server wiring get **removed**, including their package dependencies. A security concierge must not ship dormant phone-home code or carry supply-chain surface for features it doesn't use.
   This is the key insight for shrinking the work: **most of our 154-file reconciliation exists only because the old fork removed or diverged from upstream features. If we instead accept upstream's version of those files and gate the feature off, those files leave the reconcile set.**

3. **Apply-ours layer.** Replay the genuine Goldilocks delta: the 275 additive files (backend, brand, our agents, the report-agent) **plus** the true replacements/extensions where our app must call our backend or show our role-UI.

### What this does to the inventory

- **Additive (275):** unchanged — replay clean.
- **Reconcile (154):** splits two ways —
  - **Take-upstream + disable** — files that diverged *only* because we turned an upstream feature off. Accept upstream's file; add gating elsewhere. Carried diff → ~0.
  - **Genuine replace/extend** — files where Goldilocks must call our backend (`ConvosAPIClient`, `SessionManager`) or render our role-UI (conversations role-banner / plan-chip). These still reconcile — a smaller, well-defined set.
- **Contacts comes free.** The painful "Wave C Contacts mini-project" evaporates — contacts arrive with `upstream/dev`; we only gate the agent-contact parts.

### The caveats (where "disable" isn't enough)

- **Replacements still reconcile.** Auth (→ our backend), billing (→ our upgrade codes), conversations role-UI — we can't just disable upstream's; our app must talk to our backend.
- **"Disabled" must be truly inert.** Upstream features assume their backend endpoints exist (agent pool, Composio grants, StoreKit, telemetry ingest). Gated code must not call absent Goldilocks endpoints or crash at launch — verify each gated feature is a genuine no-op.
- **Stripping has a merge cost.** The SDKs we remove (Composio/PostHog/Sentry/StoreKit) are files we *will* re-encounter at each upstream merge. That's an accepted, deliberate cost for a smaller attack surface — re-strip on each cycle (cheap, since the removal pattern is known) rather than carry them.

## Inventory — what our delta actually is

Measured against the last shared ancestor (`4c47949b`, 2026-04-27). Full lists in `docs/plans/rebase-inventory/`.

| Category | Count | Cost to replay | Notes |
|----------|-------|----------------|-------|
| **Additive files** (don't exist upstream) | **275** | **Clean** — just bring them over | `backend/` (136), new iOS views (68), `docs/` (19), `ConvosCore/` additions (14), `dev/` (13), `.github/` (13), `shared/` (8) |
| **Modified shared files** (exist both sides, genuinely diverge) | **154** | **Mixed** — see manifest | Now classified per-file in `rebase-inventory/reconcile-manifest.md`: only **~69 are genuine hand-reconciliation**; ~53 just take upstream, ~10 take-upstream-then-gate, ~25 mechanical, 2 strip |
| **Redundant cherry-picks** (already in upstream/dev) | **13 commits** | **Drop** — don't replay | #762–#822 + the libxmtp bump; upstream/dev already has them |
| **Messy-history commits** ("asd", "wow", "latest"×10) | many | **Squash away** | No commit granularity worth preserving |

The headline: **~64% of our delta is additive and replays clean.** The reconciliation is concentrated in **~136 code files** of genuine Goldilocks customization, all in known subsystems (below).

### The reconciliation surface, by subsystem (`reconcile-files.txt`)

These are the Goldilocks customizations that overlap upstream code that has since evolved — each needs our intent re-applied onto upstream's current version:

- **API / auth** — `ConvosAPIClient(+Models)`, `MockAPIClient`, `Config/` (7 files) — Goldilocks endpoints, SIWE-against-our-backend, subscription plumbing.
- **Session / registration** — `SessionManager(Protocol)`, `Sessions/` (3) — Goldilocks registration, channel lifecycle.
- **Conversations** — `ConversationsView(Model)`, `Conversation`, `Conversation Detail/` (10), creation (3) — role banner, plan chip, staleness/empty filters.
- **Consent / sync** — `ConversationConsentWriter`, `ConversationWriter`, `StreamProcessor`, `Writers/` (5), `Inboxes/` (3), `Messaging/` (3) — agent-trust, no-op consent delete.
- **Storage models** — `Storage/Models/` (7) — Goldilocks fields on Conversation/Member/Profile.
- **Message list UI** — `Messages List Items/` (10), view controllers (3) — Advisory/Reports rendering.
- **Settings / shared UI** — `App Settings/` (3), `Shared Views/` (4) — role-aware settings, AvatarView.
- **Build** — `project.pbxproj` (**the single hardest merge**), `Scripts/build-phases/` (3), `Scripts/hooks/` (2), xcconfig.
- **Tests / mocks** — 17 files, mechanical once the code they cover is reconciled.

> Note: some `Convos/Contacts/` entries appear here because of the in-flight Contacts decision (Wave C of the old plan). After the rebase, Contacts comes from upstream directly — we keep only the "people-not-agents" gating as a small delta, which shrinks this further.

## Recommended method: fresh base + categorized replay (not `git rebase`)

A raw `git rebase --onto upstream/dev <base> main` would replay all ~155 commits — including the 13 redundant cherry-picks (mostly empty/conflicting) and the garbage-message commits — forcing ~155 conflict resolutions and preserving messy history. **Don't.** The messy history is a gift: there's nothing to preserve, so we rebuild clean.

Instead, treat the delta as content to re-apply, organized by concern:

1. **Branch from upstream/dev:** `git checkout upstream/dev && git checkout -b goldilocks-v2`.
2. **Additive layer (clean, fast):** bring the 275 additive paths over wholesale (`git checkout main -- <path>` for paths upstream lacks). Commit by concern: `backend/`, `shared/` + codegen, `docs/`, new iOS features, `dev/` + CI. Each is a clean, reviewable commit.
3. **Reconciliation layer (the work):** for the 136 modified code files, re-apply Goldilocks intent onto upstream's current version, **one subsystem at a time** (API/auth → session → storage models → consent/sync → conversations UI → settings → build). Use the old version as reference: `git show main:<file>` vs `git show upstream/dev:<file>`. Commit per subsystem; build between.
4. **`project.pbxproj` deliberately:** regenerate from the file set rather than text-merging. Add the 68 new iOS files + targets to upstream's current project. Budget real time here.
5. **Drop the redundant 13** — don't replay; upstream/dev already has them.
6. **Regenerate + verify:** `npm run codegen` (shared types → Swift/Zod), build, `swift test --package-path ConvosCore` with Docker, `/lint`.
7. **Cut over:** once `goldilocks-v2` is green and feature-complete, make it the new `main` (tag the old one).

## Prerequisite the user asked for: a labeled delta manifest

"Truly identify and separate all the changes we've made." First artifacts are in `docs/plans/rebase-inventory/`:

- `additive-files.txt` (275) — bring wholesale.
- `reconcile-files.txt` (154) — hand-reconcile.
- `redundant-cherrypicks.txt` (13) — drop.

- `reconcile-manifest.md` (done) — every reconcile file annotated with its bucket, a one-line *why*, and a security-sensitive flag, plus a suggested subsystem-by-subsystem reconciliation order. This turns the rebase into a deliberate re-application rather than a blind 3-way merge.

## The hard parts (call them out now)

- **`project.pbxproj`** — text-merging two evolved Xcode projects is the classic fork tar-pit. Regenerate from the file set instead.
- **Consent/sync** (`StreamProcessor`, `ConversationConsentWriter`) — Goldilocks' agent-trust + no-op consent delete are subtle and security-relevant; reconcile with care and test against a live node.
- **Storage model migrations** — if Goldilocks added GRDB columns/migrations, they must slot in after upstream's current migration set without renumbering collisions.
- **API layer vs upstream SIWE** — upstream now has its own SIWE; ours targets the Goldilocks backend. Keep ours; don't let the rebase silently adopt theirs.

## Going forward (so we never drift 160 PRs again)

1. **Cadence:** merge `upstream/dev` on a fixed schedule (monthly). At ~20–30 PRs of drift, reconciliation is hours, not weeks.
2. **Minimize divergence:** prefer the patterns that shrink the reconciliation surface — additive files + dependency injection (the `ConvosCoreiOS` bridge model) over editing upstream files in place. Every upstream file we *don't* edit is one we never reconcile.
3. **Keep the manifest current:** the `rebase-inventory/` lists become the living definition of "what is Goldilocks," regenerated each cycle.

## Verification gates (per CLAUDE.md)

Docker + full suite before cutover: `./dev/start && swift test --package-path ConvosCore`, plus an Xcode build of the app target and `npm run codegen:check`. The consent/sync and storage reconciliations are where a silent regression would hide — test those hardest.

## Decision needed before execution

This is a multi-day effort (the 136-file reconciliation + pbxproj). Recommended next step is **not** to start merging, but to produce the annotated delta manifest (the *why* per reconcile file) so the reconciliation is mechanical and reviewable. Confirm scope/sequencing, then execute subsystem by subsystem on `goldilocks-v2`.
