# Upstream Sync Plan — Convos → Goldilocks

_Refreshed 2026-06-06 after `git fetch upstream`. Supersedes the 2026-05-20 revision (kept inline as "already executed" history). Re-run the analysis after each fetch._

## Snapshot

- **Last shared ancestor:** `4c47949b` — "Add Cloud Connections v0.1 (#719)", 2026-04-27.
- **`upstream/main`:** effectively frozen — only 3 trivial CI commits since the fork (`4d2b1b29`, 2026-04-16). **Not the line to track.**
- **`upstream/dev`:** the active line — `b75d9f09`, 2026-06-06. **This is what "convos main" really means for us.**
- **Behind by:** 277 commits / 184 PRs on `upstream/dev`.
- **Already pulled (12 PRs):** #762, #763, #766, #768, #772, #773, #780, #790, #794, #815, #818, #822 (Wave 1 + start of Wave 2 from the prior revision).
- **File spread:** upstream changed 933 files; Goldilocks changed 495; **166 overlap** (the conflict zone).

### Strategic decisions (confirmed 2026-06-06)

These shape every wave below:

| Cluster | Decision | Rationale |
|---------|----------|-----------|
| **Agents** (Agent Builder, Templates, agent-share/QR, agent-contacts — ~50 PRs) | **Skip entirely** | Consistent with removing the Assistants row; largest conflict source; off-strategy for a security concierge. |
| **IAP / Credits / StoreKit subscriptions** (~12 PRs) | **Keep ours, skip upstream** | Goldilocks has its own backend billing (per-admin upgrade codes, tier schema). Review their fixes for bugs worth replicating, don't cherry-pick. |
| **Observability** (Sentry crash reporting, PostHog metrics — ~15 PRs) | **Skip both** | No external crash/analytics SDKs in Goldilocks. |
| **Contacts — people** (list, picker, blocking, DM-from-contact, contact card/detail, Contacts tab) | **Bring in** (Wave C below) | Wanted. Hand-merged mini-project — base MVP touches 52 conflict-zone files. |
| **Contacts — agents** (agent-contacts, suggested agents, agent-share cards, agent reorder) | **Skip** | Same rationale as the Agents decision. The base Contacts code already hides agents until functional, so this UI stays **inert** without the agent-template PRs — we just don't pull the PRs that *populate* agent contacts. |
| **SIWE auth #827/#846** | **Keep ours, skip upstream** | Goldilocks shipped its own SIWE against its backend. Review #846 once for a signing-context bug worth mirroring in `GoldilocksAuth`. |
| **Backups / iCloud backup #725/#760/#778** | **Skip** | Upstream reverted all of it (`c74f475b`); not in `upstream/dev`. |
| **Firebase / fastlane CI** | **Skip** | Goldilocks runs its own CI. |

Everything below is what remains **after** removing those clusters: the standalone crash, correctness, and UX fixes that apply to a chat app regardless of the Agents/billing/contacts surface.

## Agents — re-review (2026-06-06): why we don't adopt upstream's, and what we do instead

The "skip Agents" decision was revisited against the goal of **a Goldilocks agent customers can chat with about their report results**. Conclusion unchanged — but the reasoning matters, so it's recorded here.

**Two different things share the name "agent":**

1. **Upstream's agent system** is a *consumer agent-authoring product*. A user opens the Agent Builder, writes a prompt + attaches media + toggles Composio connections (Google Calendar, Apple Health), taps "Make", and an agent is **provisioned by upstream's backend pool** and joins the chat. Templates are publishable and shareable (QR/deeplink/"Suggested agents"). The ~40 new iOS files (`Convos/Agent Builder/*`, `ConvosCore/.../AgentBuilder/*`, `Convos/Contacts/AgentShare*`, `ConvosCore/.../AgentShare/*`, `DBAgentTemplate`, `DBAgentBuilderSummary`) are **config UI + display + share + verification only — the agent brain runs on upstream's backend, which we don't run.** It is tightly coupled to the three clusters we skip: **Cloud Connections (Composio), IAP/Credits ("Power"), and the Contacts MVP** (agents render as synthetic contacts).

2. **What Goldilocks wants** is a *server-owned* agent — and we already own the substrate. `backend/src/agent/reports-agent.ts` is an XMTP `Client` that owns each client's Back Office / Reports group as super-admin and **already streams incoming client messages** (`startAutoResponder` → `handleIncomingMessage`); today it posts a canned "no one is monitoring this" reply. We also already have a generic agent-join endpoint + pool (`docs/plans/agent-join-endpoint.md`), an `AdminsAgent`, a `reports-watcher`, and an `xmtp-runtime`.

**Verdict:** adopting upstream's stack would mean importing ~50 PRs / ~40 files for a backend runtime we don't run, then stripping out Connections + Credits + builder/templates/share — deleting ~90% of what we imported. The one reusable *primitive* (make a backend agent join a conversation) we already have.

**Recommended path (own backend, small + self-contained):** design doc + disabled-by-default plumbing landed in `docs/plans/report-agent-llm-venice.md`.

1. **LLM provider: Venice** (https://venice.ai) — privacy-first, **zero-retention**, OpenAI-compatible. Chosen over Claude/OpenAI because we'd be sending client report fragments to a third party, so non-retention is the deciding property.
2. Plumbing added (inert): `backend/src/llm/venice.ts` (client), `backend/src/agent/report-assistant.ts` (retrieval → prompt → completion), config vars `REPORTS_LLM_ENABLED=false` + `VENICE_*`, and a behavior-preserving gated hook in `ReportsAgent.handleIncomingMessage` (returns the canned reply unless the flag is on **and** a key is set). `generateReportReply` short-circuits before any work when disabled, so runtime is unchanged today.
3. **Not enabled.** To turn on later: confirm Venice DPA, set a key + model, decide the channel (Advisory/Ask vs. Reports), add an audit ops-event, then flip the flag in staging. PDF text extraction + group-history context are deferred TODOs.
4. Backend-only, in code we own; **no upstream iOS needed.**

**Worth borrowing from upstream (decoupled, and valuable *because* we're a security product):**

- **Agent attestation / verification** — `AgentAttestationVerifier`, `AgentKeyset` (reads `/.well-known/agents.json`), and the verified-agent badge. Lets the iOS client **cryptographically prove the member posting reports is genuinely the Goldilocks agent, not an impostor.** Independent of Connections/Credits/Contacts. _(Requires the backend to publish an `agents.json` keyset and attest agent membership — scope before committing.)_
- **`AgentJoinStatusView`** ("Agent is joining…" status line) — small UX nicety if we surface agent joins in-app.

Treat both as optional follow-ons to the backend agent work, not part of the sync waves.

## Approach (unchanged)

Do **not** merge `upstream/dev`. Cherry-pick discrete PRs onto a dedicated branch, in waves, building and testing between waves. Most PRs are squash-merged, so each `(#NNN)` is the whole PR.

```bash
git fetch upstream
git checkout main && git checkout -b upstream-sync-0606
git cherry-pick -x <sha>          # one per PR
# build + swift test after each wave
```

`Scripts/upstream-sync.sh` automates the commit/PR mapping — re-run it against `upstream/dev` to refresh the sha list.

## The conflict zone (the files that force hand-merges)

Goldilocks customizations live here; any upstream touch needs a hand-merge, not a blind cherry-pick:

- **Message view stack** — `MessagesViewController.swift`, `MessagesGroupView.swift`, `MessagesGroupItemView.swift`, `MessagesBottomBar.swift`, `MessagesView.swift`, `MessagesViewRepresentable.swift`, `MessageContextMenuOverlay.swift`. (This is where almost all the animation/layout fixes land.)
- **Conversation** — `ConversationView.swift`, `ConversationViewModel.swift`, `ConversationsView.swift`, `ConversationsViewController.swift`, `NewConversationViewModel.swift`, `Conversation.swift`.
- **Sync / writers** — `StreamProcessor.swift`, `ConversationWriter.swift`, `ConversationConsentWriter.swift`, `MessagingService.swift`, `SessionStateMachine.swift`, `SessionManager(.swift/Protocol.swift)`.
- **API** — `ConvosAPIClient.swift`, `MockAPIClient.swift` (Goldilocks endpoints + billing).
- **UI / settings** — `AppSettingsView.swift`, `DebugView.swift`, `AvatarView.swift`, `HydratedAttachment.swift`.
- **Build** — `project.pbxproj`, `Local.xcconfig`, `Scripts/hooks/*`.

---

## Wave 1 — Clean pulls (no conflict-zone touch; high value)

Cherry-pick in this order, then build + `swift test` once at the end.

| PR | What | Why | Files |
|----|------|-----|-------|
| **#1001** | **Bound memory in receive-side image pipeline** (background OOM crash) | **Top priority — real prod crash.** Adds `BoundedImageDecode` + `AsyncSemaphore` with tests; touches `ImageCache`/`EncryptedImageLoader` but **not** in our conflict set. | 7 (incl. tests) |
| **#1008** | Move keyboard input settling into ConvosCoreiOS to fix archive type-check timeout | Build-health; aligns with our CLAUDE.md type-check rules. New `KeyboardInputSettling.swift` in ConvosCoreiOS. | 2 |
| **#933** | Switch to Chats tab when tapping a message notification | Correctness; `MainTabView` only. | 1 |
| **#957** | Keep tab bar visible in the empty/no-convos state | UX fix; isolated. | 1 |
| **#896** | Don't mark the active conversation unread during batch catch-up | Correctness; check it doesn't depend on the #902 ingest refactor (it's the standalone half). | 3 |
| **#894** | docs: fix emoji metadata guidance | Docs only; trivial. | 1 |

> Note #1001's new files (`BoundedImageDecode.swift`, `AsyncSemaphore.swift`) are net-new to us — they apply cleanly. Verify `EncryptedImageLoader.swift` patches apply against our encrypted-image customizations during the cherry-pick.

## Wave 2 — Hand-merge fixes (conflict zone; one at a time, build + test after each)

These are genuinely valuable chat fixes but land in the message/conversation stack we've customized. Apply individually, resolve by hand, test after each.

**Conversation-open flicker / scroll / animation cluster** (apply in chronological order — they build on each other):

- **#982** Fix message-list animations: receipts, sends, composer interplay _(6 files — the foundational one)_
- **#987** Apply bottom-bar insets synchronously outside `performWithoutAnimation`
- **#998** Snap bar-height re-anchors until the view has appeared
- **#1010** Keep bottom anchor pinned while the open transition settles
- **#960** Fix phantom ~200pt top inset above a single new convo _(touches `ConversationsView`/`Controller`)_
- **#978** Fix sheet keyboard crash: defer `bottomBarHeight` inset one runloop tick _(**crash fix**)_

**Composer / focus:**

- **#977** Fix composer text not clearing after send (keyboard + dictation) — pairs with #1008
- **#995** Fix reply/attachment not focusing composer when focus value is stale

**iPad / layout polish:**

- **#974** Cap Stuff grid at 5 columns; bound bubble/contact-card widths
- **#1000** Fix iPad photo context-menu preview aspect ratio + rounded corners
- **#1002** Stop re-presenting the forked-conversation sheet after dismissal

**Other:**

- **#985** Add Support section to conversation info with "Report an issue" email row — useful for a concierge product; touches `AppSettingsView`/`ConversationInfoView`.
- **#943** Fix reveal/blur toggle showing on non-image attachments — touches `HydratedAttachment` (conflict).

## Wave C — Contacts mini-project (people only; agents stay inert)

The largest item we're choosing to pull, and the most invasive. Treat it as its own branch + PR, not part of the fix waves.

**Why it's a mini-project, not a cherry-pick:** the base Contacts MVP arrived as `#782`, a **merge of ~40 commits** that adds **40 new files** and modifies **52 existing ones** — many squarely in our conflict zone (`SessionManager`, `MessagingService`, `MessagingService+PushNotifications`, `ConversationStateMachine`, `ConversationViewModel`, `ConversationsView/ViewModel/ViewController`, `ConversationView`, `AvatarView`, `AppSettingsView`, `ProfileSettingsViewModel`) plus GRDB model changes (`Conversation`, `ConversationMember`, `Profile`, `DBConversation`, and new `DBContact` / `DBConversationContactsSync`). A blind `cherry-pick -m 1` would explode. Apply the **net `#782` diff** (`git diff 343f0242^1 343f0242`) by hand against our tree.

**The human/agent seam:** in upstream, an agent is just a contact with `agentTemplateId != nil`. The base MVP already filters agents out of the UI ("filter out assistants in contacts ui until they are functional"). So bringing the base + the people-focused follow-ups gives a working **people** Contacts feature; the agent rows/sections simply never populate because we skip the agent-template PRs. No need to rip agent code out — leave it dormant.

**Confirmed clean of skipped infra:** the MVP explicitly dropped its dependency on the reverted inactive-conversation/backups work (#725). It does **not** depend on the message-ingest refactor (#902, merged later).

### Order of operations

1. **Base MVP — `#782`** (`343f0242`). New Contacts package (`Convos/Contacts/*`, `ConvosCore/.../Contacts/*`, `ContactsRepository`, `ContactsWriter`, `ContactSyncCoordinator`, `DBContact`, `InboundConversationFilter`, `QuarantineSweeper`) + the 52 conflict-zone edits. Hand-merge from the net diff. **Watch the GRDB migration ordering** — Goldilocks has its own migrations; the new `DBContact`/`DBConversationContactsSync` tables must slot in after ours without renumbering collisions. Bring the new test files too; get `swift test` green before moving on.
2. **People-focused follow-ups** (cherry-pick `-x`, build/test after each):
   - **#844** Contacts UI tweaks
   - **#850** Route to existing DMs when tapping "Chat"
   - **#855** Contact detail: shared row framework (human + agent + self) — the framework, agent branch inert
   - **#883** "Somebody" fallback, hide unnamed from list/picker
   - **#893** Immediately show prior invites when a new contact is added
   - **#936** Fix invite chip editability and member-count subtitle _(17 files — large; conflict zone)_
   - **#944** Add Contacts tab; remove App Settings Contacts row
   - **#945** Interactive keyboard dismiss + Search return key
   - **#955** Keep search bar + "Show all" empty state when search matches nothing
   - **#975** Label chat CTA "Chat" for members (agent label inert)
   - **#988** Fix tab bar overlapping conversations opened from the contact card
   - **#1007** Show the global contact name instead of "Somebody" in notification text — **now worth it** because we have contacts (was "skip" while contacts were out).
3. **Optional:** **#951** All / People / Agents filter — degrades to just "People" with no agents; pull only if you want the segmented control. **#993** copy tweak ("People and agents") — skip unless agents ship.

### Explicitly NOT in this wave (agent-contact PRs — skip)

#854 (agent template phase 2 — agent contacts), #928 / #947 / #981 / #938 / #994 (agent-share cards), #930 (refresh agent contacts UI), #950 (Suggested agents section), #969 (agent card reorder / live convo sections).

## Wave 3 — Review-before-pull (may collide with Goldilocks features)

- **#979** "Default Reveal mode to off" — Goldilocks has its own global photo-reveal / public-info toggle (`ios-236-global-reveal`). **Diff against our implementation first**; the upstream default may contradict ours.
- **#897 / #902** Unify message-ingest routing across stream + batch catch-up — touches `StreamProcessor`/`ConversationWriter` (heavily customized: agent-trust, no-op consent delete). Pull only if we want the catch-up performance work; high merge cost.
- **libxmtp bump** — ours is pinned to the `ios-4.10.0` tag; upstream/dev is on `ios-4.10.0-nightly.20260530.065bd0d`. Decide whether to chase nightlies or hold on the stable tag. If bumping: update `revision:` in `ConvosCore/Package.swift`, rebuild, run the **full** `swift test` suite against a local XMTP node.
- **HTML / file attachments** (#803, #806, #819, #820, #821, #823, #825, #861, #878, #915) — the deferred Wave 3 from the prior plan. Genuinely useful for clients sending documents to advisors, but a mini-project touching the composer. Treat separately if/when wanted. (#790 "send Files" already pulled.)

## Skip (per the decisions table above)

- **Agents / Agent Builder / Templates / Share / agent-contacts** — #830, #841, #854, #855, #876, #877, #881, #888, #890, #891, #899, #902(agent half), #904, #918, #928, #930, #934, #935, #938, #939, #940, #942, #947, #948, #953, #954, #958, #966, #967, #968, #980, #981, #994, #1004, #1006, … (~50 PRs).
- **Contacts — agents only** — #854, #930, #950, #969 and the agent-share set (#928, #947, #981, #938, #994). _(The people-side Contacts PRs moved to Wave C above; #1007 reclassified into Wave C.)_
- **IAP / Credits / Subscriptions** — #840, #849, #862, #880, #895, #913, #956, #962, #963, #965.
- **Observability** — #949 (Sentry + on-device logging), #976 (Sentry init order), #973 (PostHog metrics) and the metrics-hookup commits.
- **Device pairing / keychain identity recovery** — #863, #887, #898, #903, #971. (Goldilocks did its own single-inbox identity refactor; these will collide. Revisit only if we want multi-device.)
- **SIWE #827/#846, Backups #725/#760/#778, Firebase/fastlane CI, local-stack tooling** (#921/#927/#929/#996 — we have our own backend dev stack).
- **Assistants-on-by-default #817 / #769 / #770** — we removed the Assistants row.
- **Reverts / churn** — #783, #784, #786, #787, #905, #952 (only needed if the features they fix are pulled).
- **libxmtp renovate bumps** #765/#776/#779/#792/#798/#805/#808/#832/#834/#836/#842/#923 — collapse into the single pin decision in Wave 3.

> `dev/test` and sim-teardown improvements (#999, #997) are infra-neutral and could be cherry-picked opportunistically if our `dev/` scripts have drifted — low priority.

## Execution checklist

1. `git fetch upstream` and re-run `Scripts/upstream-sync.sh` to refresh shas (PR numbers in this doc are stable; shas are not).
2. Branch: `git checkout main && git checkout -b upstream-sync-0606`.
3. **Wave 1** — cherry-pick the 6 clean PRs (lead with #1001), build, `swift test`, `/lint`.
4. **Wave 2** — one PR at a time, hand-merge, build + full test suite after each. Start with #982 (the animation foundation), then its dependents.
5. **Wave C (Contacts)** — its **own branch + PR**. Hand-merge the net #782 diff, get tests green, then cherry-pick the people-focused follow-ups one at a time. Don't bundle it with the fix waves.
6. **Wave 3** — only after reviewing each against the colliding Goldilocks feature.
7. PR each branch into `main` once green.

## Verification gate (per CLAUDE.md)

Docker + full suite before any push: `./dev/start && swift test --package-path ConvosCore`. Never push an untested cherry-pick — the message-stack hand-merges in Wave 2 are exactly where a silent regression would hide.
