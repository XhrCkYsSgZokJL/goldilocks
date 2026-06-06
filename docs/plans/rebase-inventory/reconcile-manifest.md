# Reconcile Manifest — per-file handling for the rebase onto `upstream/dev`

_Generated 2026-06-06 by per-file analysis of the Goldilocks divergence (`git diff 4c47949b..HEAD`). Companion to `../upstream-rebase-strategy.md`. Covers the 154 files in `reconcile-files.txt` (the files that exist in both our fork and `upstream/dev` and genuinely differ). The 275 additive files in `additive-files.txt` are not listed here — they replay clean._

## Buckets

- **REPLACE-EXTEND** — genuine Goldilocks logic (backend calls, brand, role/admin, our-auth, our-billing, security hardening, agent-trust consent) that must be re-applied onto upstream's current version. **The real work.**
- **TAKE-UPSTREAM** — our copy is an older/divergent version of an upstream feature with no Goldilocks intent worth preserving. Take `upstream/dev`'s canonical version; discard our diff.
- **TAKE-UPSTREAM-DISABLE** — same, but the file belongs to a feature we gate off (agents, IAP, agent-contacts). Take upstream's; gating happens at the entry points, not here.
- **STRIP** — part of a third-party SDK we remove (Composio / PostHog / Sentry / StoreKit). Drop with its dependency.
- **MECHANICAL** — test, generated, lockfile, config, or docs that follow once the code they cover settles.

## Summary

| Bucket | ~Count | Effort |
|--------|-------|--------|
| REPLACE-EXTEND | ~63 | High — re-apply by hand, subsystem by subsystem |
| TAKE-UPSTREAM | ~59 | Trivial — accept upstream's file (incl. 6 multi-attachment/HTML files, decided) |
| TAKE-UPSTREAM-DISABLE | ~10 | Trivial here + a gating edit elsewhere |
| MECHANICAL | ~25 | Low — regenerate / follow |
| STRIP | ~2 | Low — already partly done (Firebase/Sentry removed) |

**The genuine reconciliation is ~69 files, not 154.** Roughly 88 files just take upstream or are mechanical.

## Key findings that shape the work

- **Security hardening is the densest REPLACE-EXTEND cluster** and must be preserved exactly: SE-backed identity key wrapping (F8.1) in `KeychainIdentityStore` / `PlatformProviders` / `ClipIdentityBootstrap` / `NotificationExtensionEnvironment`; `NSFileProtectionComplete` entitlement; keychain access groups; cert pinning + SIWE in `ConvosAPIClient`; `SecureWindow` / `CaptureMonitor` in the app delegate.
- **Consent/sync is security-relevant and subtle** — `StreamProcessor` (agent-trust auto-allow for Goldilocks creators), `ConversationConsentWriter` (no-op consent.denied for managed channels), `ConversationWriter`. Reconcile these hardest and test against a live node.
- **Firebase + Sentry are already removed** in our fork (STRIP confirmed). The strip policy for telemetry is partly executed; replicate it onto the new base and extend to PostHog (new upstream addition) + StoreKit.
- **Contacts is NOT just an old copy of upstream's** — our data layer (`DBContact`, `Contact`, `ContactsRepository`, `ContactsWriter`, `ContactSyncCoordinator`, `SharedDatabaseMigrator`) carries Goldilocks **admin-contact tracking + role/agent-verification overlays + GRDB migrations**. So contacts reconciliation = take upstream's canonical contacts UI **+ re-apply our admin/role data overlays**. The "contacts comes free" claim holds for the *UI*, not the data layer.
- **Multi-attachment media: DECIDED — adopt upstream's.** Our `MessagesBottomBar` / `MessagesInputView` / `MessagesMediaInputView` / `MessagesView` / `MessagesViewRepresentable` / `MessagesGroupItemView` carry a Goldilocks multi-file attachment + HTML-tile refactor. Upstream shipped its own (#790/#791 + HTML attachments). **We take upstream's** — these reclassify REPLACE-EXTEND → TAKE-UPSTREAM. `ConversationViewModel` and `ConversationView` stay REPLACE-EXTEND but only for their *non-attachment* Goldilocks logic (toolbar gating for managed groups, etc.); discard our attachment-staging diff there in favor of upstream's. Net effect: ~6 files leave the real-work bucket (genuine reconcile ~69 → ~63).
- **`project.pbxproj`** carries a "Copy Brand Config" build phase (brand.json → bundle). Re-add to upstream's project rather than text-merge.
- **Branding is mechanical-but-pervasive** — config domains (`goldilocksdigital.xyz`), URL schemes, display names, `BrandConfig.shared` asset/string lookups. Tedious but low-risk; batch it.

---

## Chunk 1 — infra / config / contacts-UI / conversation-creation

| File | Bucket | Why | Sec |
|------|--------|-----|-----|
| .claude/DESIGNER.md | MECHANICAL | Removed Firebase-token command reference; docs only. | N |
| .claude/commands/firebase-token.md | STRIP | File deleted; Firebase App Check removed. | N |
| .claude/commands/setup.md | MECHANICAL | Removed Firebase setup steps. | N |
| .env.example | TAKE-UPSTREAM-DISABLE | Goldilocks removed Firebase App Check req; take upstream and re-apply removal. | Y |
| .gitignore | MECHANICAL | Added `.dev-sim-id`, codegen node_modules, `*.bundle`. | N |
| CLAUDE.md | REPLACE-EXTEND | Monorepo docs: backend, shared types, brand, type-check rules. | N |
| Convos.xcodeproj/project.pbxproj | REPLACE-EXTEND | "Copy Brand Config" build phase; regenerate against upstream project. | N |
| project.xcworkspace/.../Package.resolved | MECHANICAL | Lockfile; regenerate. | N |
| Convos/App Settings/AppSettingsView.swift | REPLACE-EXTEND | BrandConfig logo/name, membership tier UI, deep-link routes, upgrade prompt. | N |
| Convos/App Settings/AssistantSettingsView.swift | TAKE-UPSTREAM-DISABLE | Removed assistant learn-more link; agent gating. | N |
| Convos/App Settings/CustomizeSettingsView.swift | MECHANICAL | Subtitle copy change. | N |
| Convos/Config/Dev.xcconfig | REPLACE-EXTEND | `DEBUG_DISABLE_SECURE_WINDOW`, Goldilocks domain. | Y |
| Convos/Config/Local.xcconfig | REPLACE-EXTEND | `DEBUG_DISABLE_SECURE_WINDOW`, domain, display name. | Y |
| Convos/Config/Prod.xcconfig | REPLACE-EXTEND | Goldilocks domain + `goldilocks` URL scheme. | Y |
| Convos/Config/SentryConfiguration.swift | STRIP | Sentry init removed; now a no-op stub. | N |
| Convos/Config/config.dev.json | REPLACE-EXTEND | Goldilocks dev backend URL + scheme. | Y |
| Convos/Config/config.local.json | REPLACE-EXTEND | Goldilocks local domain + scheme. | Y |
| Convos/Config/config.prod.json | REPLACE-EXTEND | Goldilocks prod backend URL + scheme. | Y |
| Convos/Contacts/AddFromContactsPickerModifier.swift | MECHANICAL | New contacts-UI plumbing (matches upstream contacts). | N |
| Convos/Contacts/Contact+ListSubtitle.swift | MECHANICAL | New contacts subtitle helper. | N |
| Convos/Contacts/ContactDetailView.swift | MECHANICAL | New contact detail card. | N |
| Convos/Contacts/ContactRowView.swift | MECHANICAL | New contact row. | N |
| Convos/Contacts/ContactsListView.swift | MECHANICAL | New sectioned-list shell. | N |
| Convos/Contacts/ContactsPickerRow.swift | MECHANICAL | New picker row. | N |
| Convos/Contacts/ContactsPickerView.swift | MECHANICAL | New multi-select picker. | N |
| Convos/Contacts/ContactsPickerViewModel.swift | MECHANICAL | New picker VM. | N |
| Convos/Contacts/ContactsSearchBar.swift | MECHANICAL | New search bar. | N |
| Convos/Contacts/ContactsView.swift | MECHANICAL | New contacts browse screen. | N |
| Convos/Contacts/ContactsViewModel.swift | MECHANICAL | New contacts list VM. | N |
| Convos/Conversation Creation/ComposeFlowView.swift | MECHANICAL | New compose entry wrapping picker. | N |
| Convos/Conversation Creation/JoinConversationView.swift | MECHANICAL | "Scan a Gold code" copy. | N |
| Convos/Conversation Creation/NewConversationViewModel.swift | MECHANICAL | Draft-graduation flag. | N |

_Note: the `Convos/Contacts/*` UI files are marked MECHANICAL because they track upstream's contacts UI; verify against `upstream/dev` and prefer upstream's versions. The Goldilocks-specific contacts logic lives in the data layer (chunk 4)._

## Chunk 2 — conversation detail + messages UI

| File | Bucket | Why | Sec |
|------|--------|-----|-----|
| AddToConversationMenu.swift | TAKE-UPSTREAM | Minor, no Goldilocks intent. | N |
| AssistantProcessingPowerInfoView.swift | TAKE-UPSTREAM-DISABLE | Removes agent-docs link; agent gating. | Y |
| InviteAcceptedView.swift | TAKE-UPSTREAM-DISABLE | Removes upstream docs link. | N |
| RequestPushNotificationsView.swift | TAKE-UPSTREAM | Minor terminology. | N |
| WhatIsQuicknameView.swift | TAKE-UPSTREAM | One-char change. | N |
| ConversationForkedInfoView.swift | TAKE-UPSTREAM-DISABLE | Removes forking learn-more link. | N |
| ConversationInfoView.swift | REPLACE-EXTEND | PeopleAndCoverage/AdminEmeraldTier sections, AdvisoryPersonSheet, seat-plan, role sorting, Gold-code branding. | Y |
| ConversationMemberView.swift | REPLACE-EXTEND | Goldilocks role gating: pinned-managed-group, AgentTrust, admin-inbox block perms. | Y |
| ConversationMembersListView.swift | TAKE-UPSTREAM | Formatting only. | N |
| ConversationOnboardingCoordinator.swift | TAKE-UPSTREAM | clientId→conversationId rename. | N |
| ConversationShareView.swift | REPLACE-EXTEND | BrandConfig logo/icon, "Your Gold code". | Y |
| ConversationView.swift | REPLACE-EXTEND | Hide toolbar when isGoldilocksManaged; media refactor. | Y |
| ConversationViewModel.swift | REPLACE-EXTEND | Keep non-attachment Goldilocks logic only; discard multi-file staging diff (adopt upstream). | Y |
| MessageReactionsView.swift | TAKE-UPSTREAM | Formatting. | N |
| ReactionsDrawerView.swift | TAKE-UPSTREAM | Formatting. | N |
| MessageInviteContainerView.swift | TAKE-UPSTREAM | Formatting. | N |
| DefaultMessagesLayoutDelegate.swift | TAKE-UPSTREAM | Minor layout. | N |
| MessagesViewController.swift | REPLACE-EXTEND | Keyboard scroll-to-bottom, focus, HTML preview. | N |
| MessagesBottomBar.swift | TAKE-UPSTREAM | Adopt upstream multi-attachment (decided). | Y |
| MessagesInputView.swift | TAKE-UPSTREAM | Adopt upstream multi-attachment (decided). | Y |
| MessagesMediaInputView.swift | TAKE-UPSTREAM | Adopt upstream multi-attachment; re-apply only brand logo if needed. | Y |
| MessageContextMenuOverlay.swift | TAKE-UPSTREAM | Formatting. | N |
| AssistantJoinedInfoView.swift | TAKE-UPSTREAM-DISABLE | Strips "See its skills" agent link. | N |
| ConversationInfoPreview.swift | TAKE-UPSTREAM | Formatting. | N |
| HTMLAttachmentBubble.swift | TAKE-UPSTREAM | Identical to upstream HTML feature. | N |
| HTMLBodyBackgroundBridge.swift | TAKE-UPSTREAM | Upstream HTML infra. | N |
| HTMLContentPrewarmer.swift | TAKE-UPSTREAM | Upstream HTML infra. | N |
| HTMLThumbnailRenderer.swift | TAKE-UPSTREAM | Upstream HTML infra. | N |
| NewConvoIdentityView.swift | TAKE-UPSTREAM-DISABLE | Strips agent-template flow. | N |
| PhotosInfoSheet.swift | TAKE-UPSTREAM | Minor cleanup. | N |
| ReplyReferenceView.swift | TAKE-UPSTREAM | Formatting. | N |
| RevealMediaInfoSheet.swift | TAKE-UPSTREAM | Minor cleanup. | N |
| MessagesGroupItemView.swift | TAKE-UPSTREAM | Adopt upstream HTML-attachment rendering (decided). | N |
| MessagesGroupView.swift | TAKE-UPSTREAM | Formatting. | N |
| MessagesView.swift | TAKE-UPSTREAM | Adopt upstream multi-attachment (decided). | Y |
| MessagesViewRepresentable.swift | TAKE-UPSTREAM | Adopt upstream multi-attachment (decided). | N |

## Chunk 3 — conversations list + app shell + ConvosCore API/session/messaging

| File | Bucket | Why | Sec |
|------|--------|-----|-----|
| ConversationsListEmptyCTA.swift | TAKE-UPSTREAM-DISABLE | Branding-specific empty state. | N |
| ConversationsListItem.swift | REPLACE-EXTEND | goldilocksDisplayName, role/tier rendering. | N |
| ConversationsView.swift | REPLACE-EXTEND | Admin/client role banner, plan-chip, membership status. | N |
| ConversationsViewModel.swift | REPLACE-EXTEND | Goldilocks setup, role filtering, new-convo gating, tier checks. | N |
| ConversationListItemCell.swift | TAKE-UPSTREAM | ViewBuilder refactor. | N |
| ConversationsViewController.swift | REPLACE-EXTEND | Section grouping by Goldilocks role. | N |
| Convos.entitlements | REPLACE-EXTEND | NSFileProtectionComplete (F8.2). | Y |
| ConvosApp.swift | REPLACE-EXTEND | GoldilocksRolePrefs, brand theme, Firebase removal, keychain access group. | Y |
| ConvosAppDelegate.swift | REPLACE-EXTEND | Brand tiers/pricing, CaptureMonitor, SecureWindow, Sentry removal. | Y |
| DebugView.swift | REPLACE-EXTEND | Role-downgrade action; Sentry conditional. | N |
| MyInfoView.swift | TAKE-UPSTREAM | Generic nav utility. | N |
| AutoShareSheetView.swift | TAKE-UPSTREAM-DISABLE | QR share branding. | N |
| AvatarView.swift | REPLACE-EXTEND | Brand bot avatar, AgentTrust check. | N |
| LinkDetectingTextView.swift | TAKE-UPSTREAM | URL rebrand only. | N |
| QuickEditView.swift | TAKE-UPSTREAM | Placeholder copy. | N |
| ConvosAppClipApp.swift | REPLACE-EXTEND | Firebase removal, keychain access group. | Y |
| ConvosCore/Package.resolved | MECHANICAL | Lockfile. | N |
| ConvosCore/Package.swift | REPLACE-EXTEND | libxmtp pin, Firebase/Sentry removal. | N |
| ConvosAPIClient+Models.swift | REPLACE-EXTEND | Goldilocks identity/billing/channel/people models. | Y |
| ConvosAPIClient.swift | REPLACE-EXTEND | SIWE endpoints, billing/channel/admin/people, cert pinning. | Y |
| MockAPIClient.swift | REPLACE-EXTEND | Stubs for Goldilocks API methods. | N |
| AppEnvironment.swift | REPLACE-EXTEND | Firebase URL removal, xmtp-logs dir, keychain access group. | Y |
| KeychainIdentityStore.swift | REPLACE-EXTEND | SE-backed key wrapping (F8.1), ThisDeviceOnly, dual-identity slots. | Y |
| Connections/ConnectionManager.swift | REPLACE-EXTEND | Orphaned-grant republish (Goldilocks-guarded). *Re-evaluate vs strip Composio.* | N |
| Contacts/ContactSyncCoordinator.swift | TAKE-UPSTREAM | Auto contact-sync; but see data-layer overlays (chunk 4). | N |
| ConvosClient+App.swift | REPLACE-EXTEND | identityKeyWrapper wiring. | Y |
| ConversationStateMachine.swift | TAKE-UPSTREAM | sendFile() — upstream feature. | N |
| MessagingService+PushNotifications.swift | REPLACE-EXTEND | GoldilocksNameRegistry display names. | N |
| SessionStateMachine.swift | REPLACE-EXTEND | Firebase auth removed, lifecycle fixes, SE connection kept open. | Y |
| MessagingService.swift | TAKE-UPSTREAM | contacts repo/writer factories. | N |
| MessagingServiceProtocol.swift | TAKE-UPSTREAM | contacts protocol methods. | N |
| MockContactsRepository.swift | MECHANICAL | Test mock. | N |
| MockConversationStateManager.swift | MECHANICAL | Mock. | N |
| MockMessagingService.swift | TAKE-UPSTREAM | contacts stubs. | N |
| MockOutgoingMessageWriter.swift | MECHANICAL | Mock. | N |
| ModelMocks.swift | TAKE-UPSTREAM | convo→channel terminology. | N |
| NotificationExtensionEnvironment.swift | REPLACE-EXTEND | identityKeyWrapper param. | Y |
| PlatformProviders.swift | REPLACE-EXTEND | identityKeyWrapper (F8.1). | Y |
| ClipIdentityBootstrap.swift | REPLACE-EXTEND | identityKeyWrapper wiring. | Y |
| SessionManager.swift | REPLACE-EXTEND | SIWE, admin/billing/channel/people endpoints, logout, unused-convo reuse. | Y |
| SessionManagerProtocol.swift | REPLACE-EXTEND | New Goldilocks endpoints. | Y |

## Chunk 4 — ConvosCore storage models / writers / sync (security-dense)

| File | Bucket | Why | Sec |
|------|--------|-----|-----|
| ConvosKeychainItem.swift | TAKE-UPSTREAM | Refresh-token support; upstream-standard. | Y |
| DBContact.swift | REPLACE-EXTEND | Admin-contact tracking + agent-verification fields. | N |
| AgentVerification.swift | TAKE-UPSTREAM | roleLabel presentation prop. | N |
| Contact.swift | REPLACE-EXTEND | Admin tracking + agent metadata overlays (role model). | N |
| Conversation.swift | REPLACE-EXTEND | isGoldilocksManaged, stale-channel, emoji rotation, placeholder filter. | Y |
| ConversationMember.swift | REPLACE-EXTEND | GoldilocksNameRegistry, creator-ordering role sort. | N |
| HydratedAttachment.swift | TAKE-UPSTREAM | isHTMLFile prop. | N |
| MessagesListProcessor.swift | TAKE-UPSTREAM | Index-based grouping perf. | N |
| Profile.swift | REPLACE-EXTEND | GoldilocksNameRegistry displayName fallback. | N |
| ContactsRepository.swift | REPLACE-EXTEND | Goldilocks contacts repo + blocking. | N |
| SharedDatabaseMigrator.swift | REPLACE-EXTEND | GRDB migrations: contact table + admin column. | N |
| ContactsWriter.swift | REPLACE-EXTEND | Upsert/block/admin-sync. | N |
| ConversationConsentWriter.swift | REPLACE-EXTEND | No-op consent.denied for managed channels (anti-flicker). | Y |
| ConversationStateManager.swift | TAKE-UPSTREAM | sendFile protocol method. | N |
| ConversationWriter.swift | REPLACE-EXTEND | inviteTag fallback for agent-created groups. | N |
| OutgoingMessageWriter.swift | TAKE-UPSTREAM | Generic sendFile + dedup. | N |
| StreamProcessor.swift | REPLACE-EXTEND | Agent-trust auto-allow for Goldilocks creators; typing-event filtering. | Y |
| IOSDeviceInfo.swift | REPLACE-EXTEND | deviceIdSuffix for role-toggle dev model. | N |
| AssetRenewalManagerTests.swift | TAKE-UPSTREAM | Mock auth signature update. | N |
| ConnectionManagerTests.swift | TAKE-UPSTREAM | Mock auth signature update. | N |
| ContactSyncCoordinatorTests.swift | REPLACE-EXTEND | Tests Goldilocks contact sync. | N |
| ContactsRepositoryTests.swift | REPLACE-EXTEND | Tests Goldilocks contacts repo. | N |
| ContactsWriterTests.swift | REPLACE-EXTEND | Tests Goldilocks contacts writer. | N |
| ConversationConsentWriterDeleteTests.swift | REPLACE-EXTEND | Tests no-op consent.denied (security behavior). | Y |
| SyncingManagerTests.swift | TAKE-UPSTREAM | Mock auth signature update. | N |

## Chunk 5 — invites / tests / notification-service / scripts / dev tooling

| File | Bucket | Why | Sec |
|------|--------|-----|-----|
| ConvosInvites/Package.resolved | MECHANICAL | Lockfile. | N |
| ConvosInvites/Package.swift | TAKE-UPSTREAM | Dep version mgmt. | N |
| InviteCoordinator.swift | REPLACE-EXTEND | Logging + benign-vs-malicious outcome tracking. | Y |
| Models.swift (invites) | REPLACE-EXTEND | consentNotAllowed error, JoinRequestDMOutcome. | Y |
| JoinRequestProcessingTests.swift | TAKE-UPSTREAM | Small tweaks for model changes. | N |
| ContactsPickerViewModelTests.swift | TAKE-UPSTREAM | New upstream-style contacts test. | N |
| ContactsViewModelTests.swift | TAKE-UPSTREAM | New upstream-style contacts test. | N |
| ConversationOnboardingCoordinatorTests.swift | TAKE-UPSTREAM | Quickname regression test. | N |
| ConversationsViewModelDeleteTests.swift | TAKE-UPSTREAM | Composio scaffolding (we strip). | N |
| NotificationService.swift | REPLACE-EXTEND | keychainAccessGroup isolation. | Y |
| README.md | REPLACE-EXTEND | Rebranded; backend/dev/security docs. | N |
| copy-env-config-app-clip.sh | REPLACE-EXTEND | Firebase removal. | Y |
| copy-env-config-main-app.sh | REPLACE-EXTEND | Firebase removal, localhost default. | Y |
| copy-env-config-notification-service.sh | REPLACE-EXTEND | Firebase removal. | Y |
| generate-secrets-local.sh | REPLACE-EXTEND | localhost default + --device flag. | Y |
| Scripts/hooks/pre-commit | REPLACE-EXTEND | bash 3.2 compat. | Y |
| Scripts/hooks/pre-push | REPLACE-EXTEND | Protect upstream, allow origin. | Y |
| Scripts/setup.sh | REPLACE-EXTEND | Firebase removal, tmux install. | Y |
| dev/test | REPLACE-EXTEND | Goldilocks Docker orchestration. | Y |

## Suggested reconciliation order (subsystem by subsystem, build between)

1. **Build/config/brand** (pbxproj, xcconfig, config.json, Package.swift, entitlements, scripts/hooks) — gets it compiling on the new base; brand is mechanical.
2. **Security identity layer** (KeychainIdentityStore, PlatformProviders, ClipIdentityBootstrap, NotificationExtensionEnvironment, ConvosClient+App, AppEnvironment) — the F8.1 SE-wrapping cluster.
3. **API / session / auth** (ConvosAPIClient[+Models], SessionManager[Protocol], SessionStateMachine, MockAPIClient) — our backend contract + SIWE.
4. **Consent / sync** (StreamProcessor, ConversationConsentWriter, ConversationWriter) — the subtle, security-relevant agent-trust logic; test hardest.
5. **Contacts data layer** (DBContact, Contact, ContactsRepository, ContactsWriter, ContactSyncCoordinator, SharedDatabaseMigrator, Profile, ConversationMember) — re-apply admin/role overlays on upstream's contacts.
6. **Conversations UI** (ConversationsView[Model][Controller], ConversationsListItem, ConversationInfoView, ConversationView, member views) — role banner / plan chip / sectioning.
7. **Messages / media** (decide multi-attachment convergence first) + invites + notification service.
8. **Disable layer** (gate agents/IAP/agent-contacts entry points; FeatureFlags) and **strip layer** (Composio/PostHog/StoreKit deps; Firebase/Sentry already done).
9. **Tests + mocks** — follow once code settles.
