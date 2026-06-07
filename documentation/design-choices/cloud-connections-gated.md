# Cloud Connections Gated

**Category:** Security · **Primary strategy:** GATE (hard-locked `false`)

## What

Upstream's **Cloud Connections** — Composio-brokered SaaS integrations (the agent reaches third-party services on the user's behalf) — are kept in the tree but **hard-locked off**. The feature flag `FeatureFlags.isCloudConnectionsEnabled` returns a constant `false`; the UI that references it compiles but never activates.

Note the distinction from **Device Connections** (the on-device Apple-SDK pathway in `ConvosConnections`), which is a separate subsystem and not gated by this flag.

## Why

Composio is a third-party broker that data passes through — incompatible with the [no-egress](no-telemetry-no-egress.md) posture. We chose to **gate rather than gut**: ripping Composio out touches ~61 files, which is a large permanent reconciliation tax. Locking the flag `false` is one line and keeps upstream's files mergeable.

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks |
|--------|----------|------------|
| Cloud Connections flag | enabled | `isCloudConnectionsEnabled { false }` |
| Composio source | present, active | present, inert |
| UI (connection grant sheet, connections section) | shown | compiled, never reached |

## Files affected

### Gated (kept, neutralized at the flag)
- `Convos/Config/FeatureFlags.swift` — the flag, hard-locked `false`. **The gate.**
- `Convos/App Settings/CloudConnectionGrantRequestSheet.swift` — the grant sheet (compiles, unreached).
- `Convos/Conversation Detail/ConversationConnectionsSection.swift`, `ConversationInfoView.swift` — guarded by the flag.
- `Convos/Conversations List/ConversationsView.swift` / `ConversationsViewModel.swift` — the deep-link grant path (`pendingGrantRequest`, `makeGrantRequestSheetViewModel`) compiles but the flag-gated entry never fires.
- Composio source in `ConvosCore` + `backend/` — left intact, no egress because it's never invoked.

## Markers

`isCloudConnectionsEnabled`, `CloudConnectionGrantRequestSheet`, `CloudConnectionManagerProtocol`, `ConversationConnectionsSection`, `connectionGrant` (deep link).

## Upstream-sync guidance

- **Re-confirm the gate holds.** Upstream may add new entry points to Cloud Connections; ensure each is behind `isCloudConnectionsEnabled` (or otherwise unreachable). The flag must stay a hard-locked constant `false` — not a UserDefaults toggle that could be flipped.
- **Keep the files mergeable.** Take upstream's version of the Cloud-Connections UI/source verbatim (TAKE-UPSTREAM) — our only divergence is the flag. Don't hand-edit these files; that would turn a free gate into a reconciliation.
- **Verify inertness.** Gated Composio code must not initiate any network call at launch. If a sync wires Composio into startup, neutralize that path.
- If the no-egress stance ever changes, this is the one flag to flip — but that's a product+security decision, not a sync decision.

## Related

[[no-telemetry-no-egress]] · [[gated-agents]] · [[reconciliation-strategies]] (GATE)
