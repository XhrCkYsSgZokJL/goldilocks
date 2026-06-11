# File Divergence Map

The reverse index: **"I'm touching this file / I hit a conflict here — which [design choice](design-choices/) owns it, and what's the [strategy](reconciliation-strategies.md)?"**

There are ~357 files that differ from `upstream/dev` (as of the 2026-06-10 sync). Most are **OWN** (additive — `backend/`, `shared/`, `documentation/`, assets, our views) and never conflict. This map focuses on the files that *do* conflict during a sync, and the markers that route any file to its owner.

> Keep this current after each sync. A stale map implies coverage that isn't there.

## 1. Quick lookup by marker

Grep the conflicting file for these. A hit routes it to a design choice (and usually means REPLACE-EXTEND or OWN — i.e. *don't* just take upstream).

| Marker(s) | Design choice | Strategy |
|-----------|---------------|----------|
| `GoldilocksSession`, `GoldilocksConfig`, `GoldilocksRole*`, `GoldilocksAgentTrust`, `GoldilocksOwnedChannels`, `GoldilocksNameRegistry`, `isGoldilocksGroup`, `goldilocksDisplayName`, `isVisibleInCurrentRole`, `isAdminContact` | [Roles & managed groups](design-choices/roles-and-managed-groups.md) | OWN / REPLACE-EXTEND |
| `BrandConfig`, `brand.json`, `goldilocksdigital.xyz`, `logoImageName`, `botImageName` | [Branding](design-choices/branding.md) | OWN / MECHANICAL |
| `CreditsServices`, `BackendCreditsService`, `GoldilocksBilling`, `credit_balance`, `membershipTier`, `SubscriptionServices` | [Billing & credits](design-choices/goldilocks-billing-credits.md) | OWN / REPLACE-EXTEND |
| `identityKeyWrapper`, `IdentityKeyWrapper`, `SecureEnclave`, `KeychainIdentityStore`, `SecureWindow`, `CaptureMonitor`, `NSFileProtectionComplete`, `ProtectedFile` | [Identity recovery & hardening](design-choices/identity-recovery-and-hardening.md) | OWN / REPLACE-EXTEND (preserve exactly) |
| `ConvosAPIClient`, `refreshToken(deviceId:)`, `reAuthenticate`, `siweJwt`/`siweAccountId` + refresh slot | [Auth against Goldilocks backend](design-choices/auth-against-goldilocks-backend.md) | REPLACE-EXTEND |
| `NoOpCoreActions`, no-op `SentryConfiguration`, `ConvosMetricsSendable`, absent `import Sentry`/`Firebase` | [No telemetry](design-choices/no-telemetry-no-egress.md) | STRIP / no-op shim |
| `isCloudConnectionsEnabled`, `CloudConnectionGrantRequestSheet`, `CloudConnectionManagerProtocol` | [Cloud Connections gated](design-choices/cloud-connections-gated.md) | GATE |
| `MainTabView` (dropped), `adminBanner`, `goldilocksChip`, `onOpenGoldilocksGroup` | [App shell: direct root](design-choices/app-shell-direct-root.md) | drop / REPLACE-EXTEND |
| `AgentBuilder*` (gated), `AgentFilesLinks*` (adopted), `hasEverHadVerifiedConvosAgent`, `pendingAgent` | [Gated agents](design-choices/gated-agents.md) | GATE / TAKE-UPSTREAM |
| `ProfileSettingsViewModel` (Quickname fully removed) | [Profile (formerly Quickname)](design-choices/profile-vs-quickname.md) | TAKE-UPSTREAM (resolved) |
| `EXCLUDED_ARCHS`, `ImageType`, `ConvosCoreiOS`, "Copy Brand Config" phase | [Platform build constraints](design-choices/platform-build-constraints.md) | MECHANICAL / bridge |
| paths under `backend/`, `shared/` | [Backend & shared monorepo](design-choices/backend-and-shared-monorepo.md) | OWN (never conflicts) |
| `Convos/Config/config.{local,dev,prod}.json` — `"xmtpNetwork": "local"` in the local config is **load-bearing**: the local backend validates SIWE against the local node (wrong network → `address_not_bound` 401s → "Setting up your channels…" forever) | [Auth against Goldilocks backend](design-choices/auth-against-goldilocks-backend.md) | REPLACE-EXTEND |

## 2. By area (where conflicts cluster)

Counts are divergent-file counts vs `upstream/dev` at the v2 cutover.

| Area | ~Files | Dominant owner(s) | Default strategy |
|------|-------|-------------------|------------------|
| `backend/src`, `backend/migrations`, `backend/scripts` | 118 | [Backend monorepo](design-choices/backend-and-shared-monorepo.md) | OWN (free) |
| `ConvosCore/Sources` | 40 | [Roles](design-choices/roles-and-managed-groups.md), [Identity](design-choices/identity-recovery-and-hardening.md), [Auth](design-choices/auth-against-goldilocks-backend.md), [Billing](design-choices/goldilocks-billing-credits.md) | REPLACE-EXTEND (the crux) |
| `Convos/Assets.xcassets`, `Convos/AppIcon-*` | 32 | [Branding](design-choices/branding.md) | OWN |
| `Convos/Conversations List` | 13 | [Roles](design-choices/roles-and-managed-groups.md), [App shell](design-choices/app-shell-direct-root.md) | REPLACE-EXTEND |
| `Convos/Config` | 13 | [Roles](design-choices/roles-and-managed-groups.md), [Branding](design-choices/branding.md), [Auth](design-choices/auth-against-goldilocks-backend.md) | OWN / mechanical |
| `Convos/Conversation Detail` | 11 | [Roles](design-choices/roles-and-managed-groups.md), [Gated agents](design-choices/gated-agents.md), [Billing](design-choices/goldilocks-billing-credits.md) | REPLACE-EXTEND |
| `Convos/App Settings` | 10 | [Billing](design-choices/goldilocks-billing-credits.md), [Roles](design-choices/roles-and-managed-groups.md), [Profile/Quickname](design-choices/profile-vs-quickname.md) | REPLACE-EXTEND |
| `Convos/Profile` | 8 | [Profile (formerly Quickname)](design-choices/profile-vs-quickname.md) | TAKE-UPSTREAM |
| `shared/`, `Convos/Window`, `Convos/Contacts`, `Convos/Shared Views`, `Convos/Debug View` | misc | per markers | mixed |
| `docs/`, `qa/`, `.github/`, `dev/` | misc | mechanical | follow |

## 3. The crux REPLACE-EXTEND files (the expensive ones)

When these conflict, budget real time and re-apply the overlay onto upstream's current version. They are where silent regressions hide.

**Security-relevant (test against a live node):**
- `ConvosCore/.../Auth/Keychain/KeychainIdentityStore.swift` — two-slot SE + iCloud backup → [Identity](design-choices/identity-recovery-and-hardening.md)
- `ConvosCore/.../Syncing/StreamProcessor.swift` — agent-trust auto-allow → [Roles](design-choices/roles-and-managed-groups.md)
- `ConvosCore/.../Storage/Writers/ConversationConsentWriter.swift` — no-op managed-channel deny → [Roles](design-choices/roles-and-managed-groups.md)
- `ConvosCore/.../API/ConvosAPIClient.swift` — our endpoints + SIWE + cert pinning + refresh → [Auth](design-choices/auth-against-goldilocks-backend.md)
- `ConvosCore/.../Shared/ConvosKeychainItem.swift` — union of upstream SIWE accounts + our refresh slot → [Auth](design-choices/auth-against-goldilocks-backend.md)

**Product overlays:**
- `Convos/Conversations List/ConversationsViewModel.swift` — role filter, managed-channel sort → [Roles](design-choices/roles-and-managed-groups.md)
- `Convos/Conversations List/ConversationsView.swift` — standalone root, admin banner/chips → [App shell](design-choices/app-shell-direct-root.md) + [Roles](design-choices/roles-and-managed-groups.md)
- `Convos/Conversation Detail/ConversationViewModel.swift` / `ConversationInfoView.swift` — role-gated actions, files/links → [Roles](design-choices/roles-and-managed-groups.md) + [Gated agents](design-choices/gated-agents.md)
- `Convos/App Settings/AppSettingsView.swift` — tier UI, deep-link routes, brand → [Billing](design-choices/goldilocks-billing-credits.md) + [Roles](design-choices/roles-and-managed-groups.md)
- `ConvosCore/.../Storage/Models/Conversation.swift` / `Contact.swift` — Goldilocks fields → [Roles](design-choices/roles-and-managed-groups.md)
- `ConvosCore/.../Sessions/SessionManager.swift` (+`Protocol`) — registration + channel lifecycle → [Roles](design-choices/roles-and-managed-groups.md)

## 4. Authoritative one-time inventory

The exact per-file buckets from the v2 rebase (with a *why* per file) live in `docs/plans/rebase-inventory/reconcile-manifest.md` and the `*.txt` lists. Use those as the seed when regenerating this map after a large sync; use this map for day-to-day lookups.

## How to regenerate after a sync

```bash
# the divergence, by area
git diff --name-only upstream/dev HEAD | awk -F/ '{print $1"/"$2}' | sort | uniq -c | sort -rn

# files carrying each design-choice marker (repeat per marker from §1)
grep -rln "GoldilocksSession\|BrandConfig\|..." Convos ConvosCore/Sources
```
Re-tag any new conflicting files against §1, and add genuinely new crux files to §3.
