# Goldilocks Design Choices

Each file here documents **one intentional way Goldilocks diverges from upstream**. The format is consistent so a sync can scan them fast:

- **What / Why** — the divergence and its rationale (so nobody "fixes" it back).
- **Upstream vs Goldilocks** — the contrast at a glance.
- **Files affected** — grouped by [reconciliation strategy](../reconciliation-strategies.md): Owned / Extended / Gated / Stripped.
- **Markers** — greppable identifiers that reveal the divergence in code.
- **Sync guidance** — what to do when upstream changes these files.

## The choices

### Security posture
- **[No telemetry / no-egress](no-telemetry-no-egress.md)** — a security concierge ships no phone-home code. Sentry + Firebase stripped, PostHog/metrics no-op'd, Composio gated.
- **[Identity recovery & hardening](identity-recovery-and-hardening.md)** — Secure-Enclave key wrapping + iCloud key backup, capture protection, file protection, cert pinning.
- **[Cloud Connections gated](cloud-connections-gated.md)** — Composio-brokered SaaS integrations kept in the tree but hard-locked off.

### Product identity
- **[Roles & managed groups](roles-and-managed-groups.md)** — admin/client roles and the Goldilocks-owned channels (Advisory, Reports, Admins, Audit Log). The densest customization.
- **[Branding](branding.md)** — `BrandConfig`/`brand.json`-driven names, assets, domains, icons.
- **[Goldilocks billing & credits](goldilocks-billing-credits.md)** — our credits/subscription backend; StoreKit IAP skipped.
- **[Auth against Goldilocks backend](auth-against-goldilocks-backend.md)** — SIWE/refresh-token auth pointed at our backend, not upstream's.

### App surface
- **[App shell: direct root](app-shell-direct-root.md)** — `ConvosApp → ConversationsView` directly; upstream's `MainTabView` tab shell dropped.
- **[Gated agents](gated-agents.md)** — upstream's Agents/agent-builder/agent-contacts gated; Goldilocks uses its own backend agents.
- **[Profile (formerly Quickname)](profile-vs-quickname.md)** — the Quickname→Profile migration (now complete; we use upstream Profile).

### Platform
- **[Backend & shared monorepo](backend-and-shared-monorepo.md)** — the Node backend + shared codegen that upstream has no equivalent of.
- **[Platform build constraints](platform-build-constraints.md)** — arm64-only libxmtp, ConvosCore macOS-compilability, the `ConvosCoreiOS` bridge, the brand-config build phase.

## Categorized by sync cost

| Cost | Choices |
|------|---------|
| **Free** (additive / replays clean) | Backend & shared monorepo; the owned files within Roles, Branding, Billing |
| **Cheap** (gate / re-strip / mechanical) | No telemetry, Gated agents, Cloud Connections, Branding (the pervasive-but-mechanical parts), Platform build constraints |
| **Expensive** (replace-extend by hand) | Roles & managed groups, Identity hardening, Billing, Auth, App shell |

When in doubt about a single file, the [File Divergence Map](../file-divergence-map.md) is the reverse index: file → owning choice → strategy.
