# No Telemetry / No-Egress

**Category:** Security · **Primary strategy:** STRIP (SDKs) + GATE (Composio) + no-op shims

## What

Goldilocks ships **no analytics, crash-reporting, or third-party phone-home code**. Upstream's observability stack — Sentry, Firebase (App Check), PostHog — is removed or neutralized, and the metrics layer (`CoreActions`) is wired to a no-op implementation.

## Why

Goldilocks is a security concierge product. A dormant analytics SDK is both an egress risk (it transmits usage data) and a supply-chain attack surface (it's code we didn't write, loaded into a process holding user keys). We accept no telemetry rather than try to configure it "privately."

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks |
|--------|----------|------------|
| Crash reporting | Sentry SDK | Removed; no-op `SentryConfiguration` |
| App attestation | Firebase App Check | Removed |
| Product analytics | PostHog | No-op delegate; `NoOpCoreActions` |
| Metrics interface | `CoreActions` → PostHog | `CoreActions` → `NoOpCoreActions` (interface kept, egress removed) |

The key nuance: we **keep the `CoreActions`/metrics *interface*** (it's threaded through dozens of call sites in `ConvosMetrics`) and only swap the *implementation* for a no-op. Gutting all 60+ call sites would be a permanent reconciliation tax; a no-op sink is free.

## Files affected

### Stripped (removed with dependency)
- Sentry: dependency removed from `ConvosCore/Package.swift`; `Convos/Config/SentryConfiguration.swift` is a no-op stub.
- Firebase: dependency + App Check wiring removed (`Package.swift`, config).

### No-op shim (interface kept)
- `ConvosCore/Sources/ConvosCore/Metrics/NoOpCoreActions.swift` — the no-op `CoreActions` (used by `ConvosApp`, `DebugExportView`, etc. — 19 files reference it).
- PostHog metrics delegate → no-op (`PostHogConfiguration.sharedMetricsDelegate` falls back to a `CollectorDelegate()` no-op).

### Retroactive Sendable shim
- `Convos/Metrics/ConvosMetricsSendable.swift` — retroactive `Sendable` for the payload-free `ConvosMetrics` enums (so the kept interface compiles under strict concurrency). See playbook → _Cross-module enums_.

## Markers

`NoOpCoreActions`, `SentryConfiguration` (no-op), absence of `import Sentry` / `import Firebase` / `FirebaseApp` / `AppCheck` in the dependency graph. `PostHogConfiguration.sharedMetricsDelegate`.

## Upstream-sync guidance

- **Re-strip each cycle.** Upstream keeps these SDKs, so every merge re-introduces them. Remove the dependency from `Package.swift` + app target package refs, and re-point any new `CoreActions` call sites at `NoOpCoreActions`. The pattern is known and cheap.
- **New metrics events are free** — they call the no-op sink. Don't reconcile the *content* of new `CoreActions` methods; just ensure `NoOpCoreActions` conforms (add empty method bodies).
- **Watch for new SDKs.** If upstream adds another observability/attestation dependency, strip it on arrival. Treat any new networking dependency as suspect.
- If a build fails on a metrics enum crossing an actor boundary, add it to `ConvosMetricsSendable.swift` (payload-free enums only).

## Related

[Cloud Connections gated](cloud-connections-gated.md) (the other no-egress strip) · [Gated agents](gated-agents.md) · [Platform build constraints](platform-build-constraints.md)
