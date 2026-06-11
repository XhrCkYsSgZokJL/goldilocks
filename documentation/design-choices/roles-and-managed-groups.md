# Roles & Managed Groups

**Category:** Product · **Primary strategy:** OWN (infra) + REPLACE-EXTEND (UI/data overlays) · **This is the densest customization.**

## What

Goldilocks is a managed-channel product with two user roles and a set of backend-provisioned, always-present groups:

- **Roles** — `admin` and `client`. The role is read live from `GoldilocksSession` so the UI updates mid-session on upgrade.
- **Managed ("Goldilocks-owned") channels** — Advisory, Reports, Admins, Audit Log. These are provisioned server-side by our backend agents (admins-agent, reports-agent) and arrive via XMTP welcomes. They render as pinned rows sorted to the top in a role-specific order, are excluded from normal filtering, and have role-gated visibility.
- **Agent trust** — Goldilocks creators are auto-allowed (`GoldilocksAgentTrust`); managed channels get a no-op `consent.denied` so they can't be accidentally rejected.
- **Admin-contact tracking** — contacts carry an `isAdminContact` overlay synced from the backend.

## Why

This *is* the product. Upstream is a peer-to-peer messenger; Goldilocks is a concierge with a structured admin/client relationship and curated channels. Almost every list/detail/consent surface needs a role-aware or managed-channel-aware branch.

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks |
|--------|----------|------------|
| User model | flat peers | `admin` / `client` roles (`GoldilocksSession.role`) |
| Special groups | none | Advisory / Reports / Admins / Audit Log (server-provisioned) |
| List ordering | recency | managed channels pinned + role-ordered, then recency |
| Consent | user-driven | agent-trust auto-allow; no-op deny for managed channels |
| Contacts | flat | `isAdminContact` + role/agent-verification overlays |

## Files affected

### Owned (additive — the role/channel infrastructure)
- `Convos/Config/GoldilocksSession.swift` — live role, client number, admin inbox IDs, pending-invoice state. **The hub.**
- `Convos/Config/GoldilocksConfig.swift` — group names, hardcoded recipients, role config.
- `Convos/Config/GoldilocksRole.swift` — the role enum **and** `GoldilocksRolePrefs` (role persisted to keychain, `applyToKeychain()`).
- `ConvosCore/Sources/ConvosCore/Goldilocks/GoldilocksAgentTrust.swift` — agent-trust allow-list.
- `ConvosCore/Sources/ConvosCore/Goldilocks/GoldilocksOwnedChannels.swift` — managed-channel identity.
- `ConvosCore/Sources/ConvosCore/Goldilocks/GoldilocksNameRegistry.swift` — managed-channel display names.
- `Convos/Conversations List/AdminChannelsView.swift`, `AdminClientPeopleListView.swift` — admin surfaces.

### Extended (REPLACE-EXTEND — role/channel overlays on upstream files)
- `Convos/Conversations List/ConversationsViewModel.swift` — role filtering, managed-channel sort-to-top, setup kickoff (`kickGoldilocksSetup`), `isVisibleInCurrentRole`, `isGoldilocksGroup`. **Heaviest overlay.**
- `Convos/Conversations List/ConversationsView.swift` / `ConversationsViewController.swift` — admin banner, role/tier chips, managed-channel rows.
- `Convos/Conversation Detail/ConversationViewModel.swift` / `ConversationInfoView.swift` / `ConversationMemberView.swift` — role-gated actions.
- `Convos/Shared Views/AvatarView.swift` — bot/agent-trust avatar rendering.
- `ConvosCore/Sources/ConvosCore/Storage/Models/Conversation.swift`, `Contact.swift` — `isGoldilocksGroup`, `goldilocksDisplayName`, `isAdminContact`.
- `ConvosCore/Sources/ConvosCore/Storage/Database Models/DBContact.swift`, `Storage/Writers/ContactsWriter.swift`, `Storage/SharedDatabaseMigrator.swift` — admin-contact column + sync + GRDB migration.
- `ConvosCore/Sources/ConvosCore/Storage/Writers/ConversationConsentWriter.swift`, `Syncing/StreamProcessor.swift` — agent-trust auto-allow, no-op managed-channel deny. **Security-relevant; reconcile with care.**
- `ConvosCore/Sources/ConvosCore/Sessions/SessionManager.swift` / `SessionManagerProtocol.swift` — Goldilocks registration + channel lifecycle.

## Markers

`GoldilocksSession`, `GoldilocksConfig`, `GoldilocksRole`, `GoldilocksRolePrefs`, `GoldilocksAgentTrust`, `GoldilocksOwnedChannels`, `GoldilocksNameRegistry`, `isGoldilocksGroup`, `goldilocksDisplayName`, `isVisibleInCurrentRole`, `isPinnedGoldilocksGroup`, `isAdminContact`, `syncAdminContacts`, `kickGoldilocksSetup`.

## Upstream-sync guidance

- **The owned files are free** — they have no upstream equivalent; bring them as-is.
- **The extended files are the real work.** When upstream evolves the conversations list, conversation detail, consent writer, or storage models, take upstream's current file and re-apply the Goldilocks overlay. Keep the overlay branched on a small `GoldilocksSession`/`isGoldilocksGroup` condition so the structural diff stays small.
- **Consent/sync is the danger zone.** `StreamProcessor` (agent-trust auto-allow) and `ConversationConsentWriter` (no-op deny) are subtle and security-relevant — reconcile them last, deliberately, and test against a live node.
- **Storage migrations must slot in after upstream's current migration set** without renumbering collisions (`SharedDatabaseMigrator`). Goldilocks is pre-launch enough that contact-migration data loss is acceptable — adopt upstream's migrations and append `isAdminContact`.
- **Contacts comes mostly free for the UI, not the data layer** — take upstream's contacts UI, re-apply our admin/role data overlays.

## Related

[Branding](branding.md) (role/tier chips use `BrandConfig`) · [Goldilocks billing & credits](goldilocks-billing-credits.md) (tier chips) · [Backend & shared monorepo](backend-and-shared-monorepo.md) (the agents that provision channels) · [Auth against Goldilocks backend](auth-against-goldilocks-backend.md) (role comes from our backend)
