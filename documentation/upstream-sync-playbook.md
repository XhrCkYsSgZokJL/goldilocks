# Upstream Sync Playbook

How to pull `upstream/dev` into Goldilocks without re-living the great drift of 2026. Read this end-to-end before your first sync; skim the **Lessons** section before every sync.

## Cadence (the most important rule)

> **Merge `upstream/dev` monthly.** At ~20–30 PRs of drift, reconciliation is hours. At ~160 PRs, it is a multi-day rebuild (we know — see _History_).

Put it on a schedule. The reconciliation surface grows super-linearly with drift, because each upstream fix lands on top of refactors you skipped, so a backport pulls a fix *backward* onto a base whose surrounding code no longer matches.

## Before you start

1. `git fetch upstream`
2. Read `git log --oneline <last-sync>..upstream/dev` and skim the merged PRs. Flag anything touching a [design choice](design-choices/) — those are your reconciliation targets.
3. Branch: `git checkout -b sync/<date>` from current `main`.
4. Make sure Docker is up (`./dev/up`) — you'll need it for the test gate. If `dev/compose` fails with `docker-compose: command not found`, the wrapper (upstream-verbatim) calls compose v1; run `docker compose -f dev/docker-compose.yml -p convos-ios up -d` directly.

## The process

For a **routine monthly sync** (small drift), a real `git merge upstream/dev` is usually viable — resolve conflicts file-by-file using the [Reconciliation Strategies](reconciliation-strategies.md) decision tree, then build and test.

For a **large catch-up** (months of drift), do **not** `git merge` or `git rebase` the whole history — replay the delta by concern instead (this is what the v2 rebase did):

1. **Branch from upstream:** `git checkout upstream/dev && git checkout -b goldilocks-vN`.
2. **Additive layer first (clean, fast):** bring over the files upstream lacks (`backend/`, `shared/` + codegen, `docs/`, our iOS-only views, `dev/`, CI). `git checkout <old-main> -- <path>`. Commit per concern.
3. **Reconciliation layer (the work):** for each [design choice](design-choices/), re-apply Goldilocks intent onto upstream's *current* file. Work **one subsystem at a time**, build between. Use `git show <old-main>:<file>` vs `git show upstream/dev:<file>` as the 3-way reference.
4. **`project.pbxproj` deliberately:** the synchronized file groups (`Convos`, `ConvosAppClip`, `NotificationService` are `PBXFileSystemSynchronizedRootGroup`) auto-include files from the filesystem, so most of the historical pbxproj tar-pit is gone. Only the **brand-config build phase** and **app-level package refs** need hand-editing. See [Platform Build Constraints](design-choices/platform-build-constraints.md).
5. **Drop redundant cherry-picks** — anything upstream already has.
6. **Regenerate + verify** (see Gates below).
7. **Cut over:** once green and feature-complete, make the branch the new `main` (tag the old one).

## Verification gates (do not skip)

Run in this order; each catches a class the previous misses:

| Gate | Command | Catches |
|------|---------|---------|
| Syntax | `xcrun swiftc -parse <file>` | Brace/comma damage from conflict resolution |
| Core compiles + links | Xcode build of the app (see flags below) | Semantic errors, API drift |
| Warning sweep | Same build, `grep -c "warning:"` vs the pre-sync count | New deprecations / real warnings hiding in the log (the project builds with `SWIFT_TREAT_WARNINGS_AS_ERRORS=NO` — see Lessons) |
| Codegen | `npm run codegen` (in `shared/codegen`) then build | Shared-type drift between Swift/Zod/TS |
| Tests | `./dev/up && swift test --package-path ConvosCore` | Consent/sync + storage regressions (where silent bugs hide) |

**The build command** (libxmtp is arm64-only — see Lessons):

```bash
xcodebuild build \
  -project Convos.xcodeproj \
  -scheme "Convos (Dev)" \
  -destination "platform=iOS Simulator,id=<sim-id>" \
  -derivedDataPath .derivedData \
  EXCLUDED_ARCHS=x86_64 ONLY_ACTIVE_ARCH=YES
```

Reconcile **consent/sync and storage hardest, and test them against a live node** — that's where a silent regression hides (agent-trust auto-allow, no-op consent delete, GRDB migrations).

## Lessons (hard-won; read before every sync)

These each cost real time to discover during the v2 rebase. Internalize them.

### `swift build` lies — do not trust it as a verifier
The SwiftPM build cache returns **0 errors on syntactically-broken files**, even after `rm -rf .build`. It will tell you a file with a missing brace and a duplicated method body is fine. **Reliable verifiers are `xcrun swiftc -parse <file>` (syntax) and the full Xcode build (semantics).** Never declare a file fixed because `swift build` passed.

### libxmtp is arm64-only
`LibXMTPSwiftFFI.xcframework` ships no x86_64 slice. A normal simulator build fails at link with `undefined symbols ... XMTPiOS.*`. **Always build with `EXCLUDED_ARCHS=x86_64 ONLY_ACTIVE_ARCH=YES`** (on an Apple-Silicon host). This is permanent, not a workaround.

### Warnings posture is a deliberate divergence — re-apply it each sync
Goldilocks builds with `SWIFT_TREAT_WARNINGS_AS_ERRORS=NO` (all pbxproj sites); upstream uses `YES`. **A merge will silently flip it back** — re-apply `NO` along with the 500ms thresholds. Two reasons for the divergence: (1) warnings-as-errors turns machine-dependent type-check-time measurements into build failures (upstream's own unmodified files fail on a loaded host), and (2) a single fatal warning aborts that file's compilation, *masking* the real semantic errors behind it — which made reconciliation actively harder. The cost: real warnings (e.g. new deprecations) no longer break the build, so run the warning-sweep gate above and read what it finds.

### Conflict-marker "union" resolution causes syntax damage
Keeping *both* halves of a conflict that splits a brace, comma, or statement produces duplicate returns, unclosed methods, lost bodies, duplicate args. After any bulk resolution, run `xcrun swiftc -parse` on every touched file before trusting it. Prefer a proper 3-way merge (`git merge-file -p`) over hand-unioning.

### Type-check-time limits are real and partly machine-dependent
The project enforces `-warn-long-function-bodies` / `-warn-long-expression-type-checking` as **hard errors** under strict CI. Three distinct causes, and you must diagnose before "fixing":
- **Genuine solver cost** — labeled-tuple arrays, stacked ternaries in modifier args, untyped `let`s. Fix by: struct-ifying labeled tuples, hoisting ternaries to typed `let`s, annotating `let` types. (These fixes *stick* — the reported time drops.)
- **First-touch attribution** — the per-function timer is wall-clock and *includes lazy module work* (deserializing member tables for the first named-member lookup of a big type like `Profile` or `UITextField` in that compile batch). Signature: the function's reported time barely moves no matter how you shrink its body, and the per-expression timings sum to almost nothing. Refactoring cannot fix this — it just relocates the charge. If the code is a model-layer transform, moving it into ConvosCore (SwiftPM, no warn-long flags, module-local member tables) is a legitimate cure.
- **Machine load** — on a loaded host, everything inflates. Watch `lldb-rpc-server` memory (known leak; `killall lldb-rpc-server`) and overall load. (See `CLAUDE.md` → _Build Performance_.)

**How to diagnose — measure expressions, not functions.** Re-run the failing target with per-expression instrumentation and compare:

```bash
xcodebuild build ... SWIFT_TREAT_WARNINGS_AS_ERRORS=NO \
  OTHER_SWIFT_FLAGS='$(inherited) -Xfrontend -debug-time-expression-type-checking' \
  > /tmp/build.log 2>&1
grep "TheFile.swift" /tmp/build.log | grep -oE "^[0-9.]+ms.*" | sort -rn | head
```

If one expression dominates (hundreds of ms), it's solver cost — fix that expression. If all expressions are tiny but the function warning persists, it's first-touch attribution or load — refactoring the body is wasted effort. Also note: **the strict build short-circuits at the first failing file**, hiding others behind it — the warnings-mode instrumented run reveals the full set at once.

**Thresholds are a deliberate Goldilocks divergence: 500ms** (decided 2026-06, matching old main). Upstream uses 100 (PR Preview) / 300 (Dev, Local), and upstream-verbatim files (e.g. `DefaultMessagesLayoutDelegate`) trip the 300ms limit on a loaded machine purely via first-touch attribution. **Each sync must re-apply 500** to the three `OTHER_SWIFT_FLAGS` sites in `project.pbxproj` (a merge will bring upstream's 100/300 back). See [Platform build constraints](design-choices/platform-build-constraints.md).

### Synchronized file groups removed most of the pbxproj pain
`Convos`, `ConvosAppClip`, `NotificationService` are `PBXFileSystemSynchronizedRootGroup` — they compile whatever is on disk. So **adding/deleting a Swift file needs no pbxproj edit**. Deleting a file from disk drops it from the build (this is how we removed the upstream tab shell). Only build phases and package refs still need pbxproj work.

### Don't take-ours wholesale for app-UI files
The v2 rebase's biggest dead-end: taking our *old* app-UI files wholesale, then finding they expect old APIs while their upstream children evolved (the [app shell](design-choices/app-shell-direct-root.md) #918 finding). For UI, **take upstream's current child views and re-apply only the Goldilocks overlay** (role banner, plan chip, our VM methods) — don't drag a stale view forward and try to wire it to new children.

### Watch for upstream renames behind a "missing member" error
"`X` has no member `Y`" is often a *rename*, not a deletion — `hasEverHadVerifiedAssistant` → `hasEverHadVerifiedConvosAgent`, `ConnectionGrantRequestSheet` → `CloudConnectionGrantRequestSheet`, `markQuicknameEditorShown` → `markProfileEditorShown`, `AssistantFilesLinks*` → `AgentFilesLinks*`. Grep upstream for the concept before re-implementing.

### Cross-module enums need explicit `Sendable`
A public enum from a dependency module (e.g. `ConvosMetrics`'s `ConversationSource`) is **not** implicitly `Sendable` across the module boundary, so passing it into a `Task` trips strict concurrency. Add a retroactive conformance in our module (`extension X: @retroactive @unchecked Sendable {}`) for the payload-free ones rather than forking the dependency. Qualify the name if it collides with an app-local type.

## History

The v2 reconciliation (2026-06) was the one-time catch-up after ~160 PRs of drift made cherry-picking impossible. Full record:
- Strategy: `docs/plans/upstream-rebase-strategy.md`
- Per-file manifest: `docs/plans/rebase-inventory/reconcile-manifest.md`
- Inventory lists: `docs/plans/rebase-inventory/{additive,reconcile,redundant-cherrypicks}*.txt`

Those are the *one-time* record. This playbook is the *durable* process. Keep this one current.

## Sync log

| Date | Drift | Notes |
|------|-------|-------|
| 2026-06-10 | 15 PRs (#1003-#1029) | First post-rebase sync, ~2h. 9 conflicts: tab-shell deletes (kept deleted, incl. the StuffTab→ThingsTab rename), Package.swift re-strip (Sentry back out, kept upstream's convos-shared branch pin), AppEnvironment (kept our `xmtp-logs` name inside upstream's new self-diagnosing helper), AvatarView (upstream's no-GeometryReader sizes + our bot/group branches), ConversationsView (ours — upstream's side was the tab-shell rewrite). Re-strips beyond conflicts: PostHogCollector's new bare `import Sentry` (took ours), Sentry MCP out of `.mcp.json`. New `AssistantJoinSurface` enum needed the retroactive-Sendable shim. Two app-test mocks needed the new `registerClaimedConversation(id:)` stub. |
