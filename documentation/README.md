# Goldilocks Documentation

Goldilocks is a fork of [`convos-ios`](https://github.com/xmtplabs/convos-ios) (referred to here as **upstream**). This folder is the durable, living definition of **what makes Goldilocks different from upstream and how to keep the fork current** as upstream ships new features.

> If you are about to pull upstream changes, start with the **[Upstream Sync Playbook](upstream-sync-playbook.md)**.

## Why this folder exists

A fork that drifts becomes un-mergeable. We learned this the hard way: at ~160 PRs / 2.5 months of drift, **every** upstream cherry-pick conflicted, and we had to do a full "rebase the fork" reconciliation (see [Upstream Sync Playbook](upstream-sync-playbook.md) → _History_). The cost of that reconciliation was almost entirely **rediscovering which divergences were intentional Goldilocks design and which were just stale code**.

This documentation exists so that work is never repeated. Every intentional divergence is captured as a **design choice** with:

- **Why** we diverge (so a future engineer doesn't "fix" it back to upstream),
- **The exact files affected** (so a sync knows what to reconcile vs accept),
- **A sync strategy** (take-ours / take-upstream / merge / gate / strip — see [Reconciliation Strategies](reconciliation-strategies.md)),
- **Greppable markers** (so the divergence is discoverable from the code).

## How to use this folder

| You are… | Read |
|----------|------|
| Pulling upstream changes | [Upstream Sync Playbook](upstream-sync-playbook.md), then the affected [design choices](design-choices/) |
| Wondering "why does Goldilocks do X differently?" | [Design Choices index](design-choices/README.md) |
| Touching a specific file and unsure if it's ours | [File Divergence Map](file-divergence-map.md) |
| Deciding how to reconcile a conflicting file | [Reconciliation Strategies](reconciliation-strategies.md) |

## The mental model: base → disable → apply-ours

Goldilocks is **not** `old-upstream + N manual backports`. It is:

> **Goldilocks = `upstream/dev` (latest) + a well-defined, isolated Goldilocks delta, replayed on top.**

Three ordered layers:

1. **Base = `upstream/dev`, whole.** We start from every upstream feature for free.
2. **Disable layer.** Features we don't want are *neutralized*, not deleted — pure-UI features are **gated** (kept intact, hidden at the entry point); data-transmitting SDKs are **stripped** (removed with their dependency). See [No Telemetry](design-choices/no-telemetry-no-egress.md), [Gated Agents](design-choices/gated-agents.md), [Cloud Connections Gated](design-choices/cloud-connections-gated.md).
3. **Apply-ours layer.** The genuine Goldilocks delta — backend, brand, roles, our auth/billing, security hardening — replayed on top.

The single most important principle for keeping syncs cheap:

> **Every upstream file we *don't* edit is one we never have to reconcile.** Prefer additive files + dependency injection (the `ConvosCoreiOS` bridge) over editing upstream files in place.

## Design choices at a glance

| Design choice | Category | Sync cost | Markers |
|---------------|----------|-----------|---------|
| [No telemetry / no-egress](design-choices/no-telemetry-no-egress.md) | Security | Re-strip (cheap, known pattern) | `NoOpCoreActions`, no Sentry/Firebase deps |
| [Goldilocks billing & credits](design-choices/goldilocks-billing-credits.md) | Product | Replace-extend | `CreditsServices`, `GoldilocksBilling`, `membershipTier` |
| [Roles & managed groups](design-choices/roles-and-managed-groups.md) | Product | Replace-extend (the densest) | `GoldilocksSession`, `GoldilocksConfig`, `isGoldilocksGroup` |
| [Branding](design-choices/branding.md) | Product | Mechanical but pervasive | `BrandConfig`, `brand.json` |
| [Identity recovery & hardening](design-choices/identity-recovery-and-hardening.md) | Security | Replace-extend (preserve exactly) | `identityKeyWrapper`, `SecureWindow`, `KeychainIdentityStore` |
| [Gated agents](design-choices/gated-agents.md) | Product | Gate (keep upstream, hide entry) | `MainTabView` dropped, agent-builder gating |
| [Cloud Connections gated](design-choices/cloud-connections-gated.md) | Security | Gate (locked `false`) | `isCloudConnectionsEnabled` |
| [App shell: direct root](design-choices/app-shell-direct-root.md) | Product | Replace (we own the root) | `ConvosApp` → `ConversationsView` |
| [Profile vs Quickname](design-choices/profile-vs-quickname.md) | Product | Converging onto upstream | `ProfileSettingsViewModel`, `QuicknameSettingsViewModel` |
| [Backend & shared monorepo](design-choices/backend-and-shared-monorepo.md) | Platform | Additive (replays clean) | `backend/`, `shared/`, codegen |
| [Auth against Goldilocks backend](design-choices/auth-against-goldilocks-backend.md) | Product | Replace-extend (don't adopt upstream SIWE) | `ConvosAPIClient`, refresh tokens |
| [Platform build constraints](design-choices/platform-build-constraints.md) | Platform | Mechanical (re-apply settings) | `EXCLUDED_ARCHS`, `ConvosCoreiOS`, brand build phase |

## Keeping this folder honest

This documentation is only useful if it stays true. **When you make a Goldilocks-specific change, update the relevant design-choice doc in the same PR** (add the file to its list, note the marker). When you do an upstream sync, refresh the [File Divergence Map](file-divergence-map.md). A stale divergence map is worse than none — it implies coverage that isn't there.

## Relationship to `docs/`

`docs/` holds ADRs, PRDs, investigations, and the **one-time** rebase artifacts (`docs/plans/upstream-rebase-strategy.md`, `docs/plans/rebase-inventory/`). Those describe *how the v2 rebase was executed*. **`documentation/` is the durable, forward-looking reference** for every sync after that. When the two disagree, `documentation/` wins.
