# App Shell: Direct Root

**Category:** Product · **Primary strategy:** OWN the root + REPLACE-EXTEND the list

## What

Goldilocks roots the app **directly on the conversations list**: `ConvosApp → WindowGroup { ConversationsView(...) }`. Upstream introduced a tab-based home shell (`MainTabView`, PR #918) with Chats / Contacts / Agents tabs. **Goldilocks does not use `MainTabView`** — that file (and its `StuffTabView`, `MainTabView+MetricsObservers` helpers) is dropped from the target.

## Why

Goldilocks is conversation-first with [managed channels](roles-and-managed-groups.md) as the primary surface. The upstream tab shell foregrounds Agents and the agent-builder — features Goldilocks [gates](gated-agents.md). A tab bar selling gated features is the wrong front door. Rooting on `ConversationsView` keeps the product focused and avoids wiring a shell full of disabled tabs.

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks |
|--------|----------|------------|
| Root view | `MainTabView` (#918 tab shell) | `ConversationsView` directly |
| Tabs | Chats / Contacts / Agents | none (single surface) |
| Compose / agent-builder bar | in the tab shell chrome | in `ConversationsView` + its sheets |
| `ConversationsView` shape | embedded in tab (needs `appIndicatorContext`, chrome insets, `presentingCommittedConversation`, inline agent-builder) | standalone root with the Goldilocks admin banner + role/tier chips |

## Files affected

### Dropped (upstream files removed from the target)
- `Convos/MainTabView.swift`, `MainTabView+MetricsObservers.swift`, `Convos/Conversations List/StuffTabView.swift` — the #918 tab shell. Deleting the files removes them from the build (synchronized file group — see [Platform build constraints](platform-build-constraints.md)).
- **Kept:** `Convos/Metrics/MainTabNavigatorImpls.swift` — it also defines the `NavigatorLifecycle` protocol that ~40 metrics-navigator files depend on; the 3 tab-navigator impls inside are unused but harmless.

### Extended (REPLACE-EXTEND — our standalone root)
- `Convos/ConvosApp.swift` — `WindowGroup { ConversationsView(...) }`, our platform-provider + `NoOpCoreActions` wiring.
- `Convos/Conversations List/ConversationsView.swift` — standalone root: admin banner, role/tier chips (`goldilocksChip`), `onOpenGoldilocksGroup`, compose draft as `@State` in the sheet modifier. Threads upstream's current child views (`ConversationView`, `NewConversationView`, `ComposeFlowView`, `CloudConnectionGrantRequestSheet`).
- `Convos/Conversations List/View Controller/ConversationsViewRepresentable.swift` — take-ours to match the take-ours controller.

## Markers

Absence of `MainTabView` in the target; `ConvosApp` body rooting on `ConversationsView`; `adminBanner` / `goldilocksChip` / `onOpenGoldilocksGroup` in `ConversationsView`.

## Upstream-sync guidance

- **Do not re-adopt `MainTabView`.** When a sync re-imports it (synchronized groups pull it from disk), delete it again unless we've decided to adopt the tab shell. Anything referencing `MainTabView` types is almost always a comment, not a dependency — verify before keeping.
- **`ConversationsView` is REPLACE-EXTEND, not take-ours-wholesale.** Its child views (`ConversationView`, `ComposeFlowView`, etc.) are upstream and evolve. When they change signature, take upstream's child and re-thread our root's call sites — don't drag a stale `ConversationsView` forward. This was the single biggest dead-end of the v2 rebase (see playbook → _Don't take-ours wholesale for app-UI_).
- **Watch `NavigatorLifecycle`.** It lives in `MainTabNavigatorImpls.swift`; if you ever delete that file, ~40 `*NavigatorImpl.swift` files lose the protocol.

## Related

[Gated agents](gated-agents.md) (why no Agents tab) · [Profile (formerly Quickname)](profile-vs-quickname.md) (the list's settings VM) · [Platform build constraints](platform-build-constraints.md) (synchronized file groups)
