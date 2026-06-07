# Reconciliation Strategies

When an upstream sync touches a file, you need one decision: **how do we reconcile our version with upstream's?** There are five strategies. Each [design choice](design-choices/) tags its files with one of them so the decision is already made before you hit the conflict.

## The five strategies

| Strategy | Meaning | When | Sync cost |
|----------|---------|------|-----------|
| **TAKE-UPSTREAM** | Accept upstream's file verbatim; discard our diff. | Our copy is just an older version of an upstream feature with no Goldilocks intent worth keeping. | ~0 |
| **REPLACE-EXTEND** | Re-apply our Goldilocks logic onto upstream's *current* file. | The file carries genuine Goldilocks behavior (our backend, roles, brand, hardening). **The real work.** | High |
| **GATE** | Keep upstream's file intact; neutralize the feature at its entry point / a flag. | A pure-UI feature we don't want but that's cheap to leave in place. | Low (re-confirm the gate holds) |
| **STRIP** | Remove the file with its dependency. | Part of a third-party SDK we refuse to ship (telemetry, Composio, StoreKit). | Low (re-strip; pattern is known) |
| **OWN** | Additive file with no upstream equivalent; bring wholesale. | Backend, brand, our agents, role infra. | ~0 (replays clean) |

## The decision tree

```
Does the file exist in upstream/dev?
├─ NO  → OWN. Bring it over wholesale. (≈64% of our delta is here — it replays clean.)
└─ YES → Does our version carry intentional Goldilocks behavior?
         (check the design-choice doc + grep for markers)
         ├─ NO → Is the file part of an SDK we strip (telemetry/Composio/StoreKit)?
         │       ├─ YES → STRIP (drop with the dependency)
         │       └─ NO  → Is it a feature we gate but keep?
         │                ├─ YES → TAKE-UPSTREAM, then confirm the GATE still holds
         │                └─ NO  → TAKE-UPSTREAM (accept upstream's, discard our diff)
         └─ YES → REPLACE-EXTEND. Re-apply our intent onto upstream's current file.
                  ⚠ For UI files, take upstream's structure and re-apply only the
                    Goldilocks overlay — don't drag our stale view forward.
```

## How to tell if a file "carries intentional Goldilocks behavior"

1. **Check its design-choice doc.** Every divergent file is listed under a [design choice](design-choices/) with its strategy. Start there.
2. **Grep for markers.** `GoldilocksSession`, `BrandConfig`, `isCloudConnectionsEnabled`, `NoOpCoreActions`, `identityKeyWrapper`, etc. (full list in the [File Divergence Map](file-divergence-map.md)). A marker means REPLACE-EXTEND or OWN.
3. **3-way diff.** `git show <old-base>:<file>` vs `git show upstream/dev:<file>` vs ours. If our diff vs the old base is *only* an older form of what upstream now does, it's TAKE-UPSTREAM. If our diff adds backend calls, role checks, brand lookups, or hardening, it's REPLACE-EXTEND.

## REPLACE-EXTEND in practice

This is the only expensive strategy. Tactics that make it tractable:

- **Take upstream's file as the base**, then graft our overlay on — not the reverse. Upstream's version is the one wired to current child APIs.
- **For SwiftUI**, branch behavior on a small condition (a `GoldilocksSession.role` check, a `BrandConfig` lookup) rather than restructuring the view. Keep the structural diff minimal so the *next* sync is cheap.
- **Hoist Goldilocks logic into additive helpers** (`GoldilocksConfig`, `BrandConfig`, `GoldilocksOwnedChannels`) that the upstream file *calls*, so the edit-in-place surface shrinks to a call site.
- **Build between every subsystem.** Don't reconcile ten files then build — the error cascade is unreadable.

## STRIP in practice

- Remove the source files **and** the package dependency (`ConvosCore/Package.swift`, app target package refs).
- Replace any referenced symbols with a no-op shim so call sites compile (`NoOpCoreActions`, the no-op `SentryConfiguration`). Gating at call sites beats deleting every call site.
- Expect to re-strip each cycle — upstream keeps the SDK, so it returns on every merge. This is an accepted, deliberate cost for a smaller attack surface. The pattern is known, so it's cheap.

## GATE in practice

- Keep upstream's file **unedited** so future merges don't fight us on it.
- Neutralize at the **entry point**: a `FeatureFlags` switch (hard-locked, e.g. `isCloudConnectionsEnabled` returns `false`), a hidden menu item, or simply not wiring the feature into our [app shell](design-choices/app-shell-direct-root.md).
- **Verify the gate is truly inert** — gated upstream code often assumes backend endpoints (agent pool, Composio grants, StoreKit, telemetry ingest). A gated feature must not call an absent Goldilocks endpoint or crash at launch.

## Minimize future cost

The cheapest reconciliation is the one you don't do. Two habits:

1. **Additive over in-place.** New behavior in a new file beats editing an upstream file. New files are OWN (free); edited files are REPLACE-EXTEND (expensive forever).
2. **Dependency injection over forking.** When ConvosCore needs iOS behavior, define a protocol and inject (`ConvosCoreiOS` bridge) instead of editing the upstream file. See [Platform Build Constraints](design-choices/platform-build-constraints.md).
