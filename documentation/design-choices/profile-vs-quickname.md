# Profile vs Quickname

**Category:** Product · **Status:** ⚠️ **Converging onto upstream — in flux** · **Primary strategy:** prefer TAKE-UPSTREAM (Profile)

## What

Goldilocks historically branded the per-conversation identity feature as **"Quickname"** (`QuicknameSettingsViewModel`, `QuicknameSettings`, the "What is Quickname" / `AddQuicknameView` flow). Upstream calls the same concept **"Profile"** (`ProfileSettingsViewModel`, `ProfileSettings`). As of the v2 rebase, the app is **mid-migration onto upstream's Profile terminology**, because Profile is the dominant, actively-evolving surface (15 files) and Quickname is a thin wrapper (6 files) that collides with upstream's Profile-based child views.

## Why

Maintaining a parallel "Quickname" vocabulary means every upstream Profile change becomes a rename-reconciliation. Standardizing on **Profile** makes future syncs cheap. The Quickname branding (if still desired) can be a *display-string* concern rather than a separate view-model/type hierarchy.

## Current state (verify during testing)

- **Shell standardized on Profile** — `ConvosApp` and `ConversationsView` now pass `ProfileSettingsViewModel`; `AppSettingsView`'s "My Info" destination uses the upstream Profile `MyInfoView`.
- **Quickname still present** where take-ours surfaces use it (`QuicknameSettingsViewModel`, the drawer `AddQuicknameView` flow, `QuicknameSettings`). `AppSettingsView` still reads `quicknameViewModel` for its summary display.
- `QuicknameSettingsViewModel.save()` now calls upstream's `ConversationOnboardingCoordinator.markProfileEditorShown()` (renamed from `markQuicknameEditorShown`).

> **⚠️ This is the one design choice that is not settled.** It is a half-migration captured honestly so a future engineer (or the current testing pass) can finish it deliberately rather than be surprised by two vocabularies. **Behavioral risk:** Quickname and Profile may read/write different stores — verify the "My Info" editor and the per-conversation name agree during testing.

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks (current) |
|--------|----------|----------------------|
| Concept name | Profile | mixed: Profile (shell) + Quickname (some take-ours surfaces) |
| View model | `ProfileSettingsViewModel` (148 LOC) | both; Profile is canonical |
| Editor view | `MyInfoView` (profile params) | upstream `MyInfoView` (profile) |
| Onboarding hook | `markProfileEditorShown` | `markProfileEditorShown` (adopted) |

## Files affected

- `Convos/Profile/ProfileSettingsViewModel.swift` (canonical) vs `QuicknameSettingsViewModel.swift` (wrapper).
- `Convos/Profile/MyInfoView.swift` (upstream, profile params).
- `Convos/ConvosApp.swift`, `Convos/Conversations List/ConversationsView.swift`, `Convos/App Settings/AppSettingsView.swift` — migrated to `profileSettingsViewModel` (kept `quicknameViewModel` only for the AppSettingsView display chain).
- The drawer Quickname flow (`Add/Setup/WhatIsQuicknameView`, `QuicknameSettings`).

## Markers

`ProfileSettingsViewModel`, `QuicknameSettingsViewModel`, `QuicknameSettings`, `quicknameViewModel`, `profileSettingsViewModel`, `markProfileEditorShown`.

## Upstream-sync guidance

- **Prefer TAKE-UPSTREAM (Profile).** When upstream evolves Profile, take it. Don't re-fork it into Quickname.
- **Recommended end state:** finish the migration — replace remaining `QuicknameSettingsViewModel` usages with `ProfileSettingsViewModel`, and reduce "Quickname" to a `BrandConfig` display string if the branding is still wanted. Then delete this design choice (it becomes "we use upstream Profile, branded via `BrandConfig`").
- Until then, treat any Quickname↔Profile mismatch in a sync as "move toward Profile."

## Related

[[branding]] (Quickname-as-brand-string is the clean end state) · [[app-shell-direct-root]] · [[roles-and-managed-groups]]
