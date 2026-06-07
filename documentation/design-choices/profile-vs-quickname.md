# Profile (formerly Quickname)

**Category:** Product · **Status:** ✅ **Resolved — migrated onto upstream Profile** · **Primary strategy:** TAKE-UPSTREAM

## What

Goldilocks historically branded the per-user identity feature "**Quickname**" (`QuicknameSettingsViewModel`, `QuicknameSettings`, a name *randomizer*, and an "Add/Setup/WhatIs Quickname" drawer flow). **As of 2026-06 this is fully migrated onto upstream's `Profile`** — the app now uses `ProfileSettingsViewModel` everywhere, and all Quickname types/views are deleted.

## Why

The two were not just a rename — they were different architectures:

| | Quickname (removed) | Profile (current) |
|---|---|---|
| Storage | device-local `UserDefaults["QuicknameSettings"]` + disk image | **synced** global profile via `MyGlobalProfileWriter`/`Repository` (GRDB + messaging service) |
| Extra feature | name *randomizer* (tags: gender-neutral/nature/weird) | — |
| Binding | self-initializing singleton | **session-bound** (`bind(session:)`) |

Maintaining a parallel local "Quickname" vocabulary meant every upstream Profile change became a rename-reconciliation, *and* the two could disagree (local default vs synced profile). Standardizing on upstream's synced Profile removes that tax and the split-store risk.

## What the migration did (2026-06)

- **Bound the singleton** — `ConvosApp` now calls `profileSettingsViewModel.bind(session: convos.session)` (this was the missing piece — `ProfileSettingsViewModel.shared` was previously never bound, so the migrated surfaces would have shown/saved nothing).
- **Migrated the last consumers** — `AppSettingsView` (the "My info" row + summary) and `ConversationsView`'s sheet modifier now use `ProfileSettingsViewModel`.
- **Deleted all Quickname code** — `QuicknameSettings`, `QuicknameSettingsViewModel`, `AddQuicknameView`, `SetupQuicknameView`, `WhatIsQuicknameView`, and the randomizer view + its randomizer-only component chain (`TagsField`, `ChipView`, `FlowLayoutTextEditor`, `BackspaceTextField`). Kept `FlowLayout` (used by the contacts picker).
- **Removed the orphaned pill** — `AddQuicknameView` (the "Tap to chat as…" capsule) was already unreachable; the global profile auto-applies to new conversations without prompting (see `qa/tests/14-profile.md`). Deleted the stale `qa/tests/14-quickname.*`.
- **Preserved returning-user data** — `ConversationOnboardingCoordinator` keeps `legacyHasSetQuicknamePrefix` as a read-only fallback so users who completed setup under the old Quickname keys aren't re-prompted. **Do not remove this** until the legacy install base is gone.

## Feature note: the name randomizer is gone

The Quickname *randomizer* (auto-generating pseudonymous names) was removed with the migration. Its UI was already orphaned (unreachable), so this is not a user-visible regression. If name-randomization is wanted again, re-add it as a **`ProfileSettings`-layer feature**, not a separate view model.

## Residual markers (intentional keepers)

- `ConversationOnboardingCoordinator.legacyHasSetQuicknamePrefix` — the returning-user migration. Keep.
- `MyInfoNavigatorImpl.navigateTo(quicknameRandomizer:)` — a no-op stub required by the `ConvosMetrics` navigator protocol (`QuicknameRandomizerNavigatorArgs` is a dependency type). Harmless; can't remove without forking the dependency.

## Upstream-sync guidance

- **TAKE-UPSTREAM for Profile.** This is now a non-divergence — we use upstream's `ProfileSettingsViewModel`/`MyInfoView`/`ProfileSettings` directly. Accept upstream's evolution wholesale.
- **Don't re-introduce Quickname.** If a sync surfaces "Quickname" again, it's stale.
- If Goldilocks wants the "Quickname" *branding* back, make it a `BrandConfig` display string over the Profile feature — not a fork of the view model.

## Related

[[branding]] (Quickname-as-brand-string is the clean way to keep the name) · [[app-shell-direct-root]] · [[roles-and-managed-groups]]
