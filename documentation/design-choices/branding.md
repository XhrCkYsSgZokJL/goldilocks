# Branding

**Category:** Product · **Primary strategy:** OWN (`BrandConfig`/`brand.json`) + MECHANICAL (pervasive call sites)

## What

Goldilocks rebrands the white-label Convos app: name, logo/assets, color theme, legal copy, URL schemes, domains, and app icons. Branding is driven by a single source of truth — `shared/brand.json` → `BrandConfig.shared` — so the app reads brand values at runtime rather than hardcoding "Convos".

## Why

Goldilocks is a distinct product, not "Convos with a different icon." Centralizing brand in `BrandConfig`/`brand.json` keeps the divergence **mechanical and low-risk**: a sync re-points call sites at `BrandConfig` rather than reconciling scattered string literals.

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks |
|--------|----------|------------|
| Name/logo/strings | "Convos", bundled assets | `BrandConfig.shared.brand.name` / `.assets` / `.theme` |
| Source of truth | hardcoded | `shared/brand.json` (codegen → Swift) |
| Domains / URL schemes | convos | `goldilocksdigital.xyz`, Goldilocks schemes |
| App icons | Convos | `AppIcon-{Prod,Dev,Local}.icon` |
| Legal copy | Convos | Goldilocks (`LegalView`) |

## Files affected

### Owned (additive)
- `Convos/Config/BrandConfig.swift` — the brand accessor. **The hub.**
- `shared/brand.json` — the source of truth (codegen input).
- `Convos/Assets.xcassets/*` (~20 files), `Convos/AppIcon-{Prod,Dev,Local}.icon/*` (~12 files) — brand assets.
- `Convos/App Settings/LegalView.swift`, `GoldilocksMembershipTier+Style.swift` — branded surfaces.

### Extended (REPLACE-EXTEND — `BrandConfig` lookups in upstream files)
- `Convos/ConvosApp.swift`, `ConvosAppDelegate.swift` — preferred color scheme, launch branding.
- `Convos/Conversation Detail/ConversationShareView.swift` — branded share card (`logoImageName`).
- `Convos/App Settings/AppSettingsView.swift` — brand name/logo header.
- `Convos/Conversations List/ConversationsListEmptyCTA.swift`, `Shared Views/AvatarView.swift`, `Window/CaptureOverlay.swift` — branded glyphs/fallbacks.

### Mechanical (config / build)
- xcconfig domains + URL schemes, `Info.plist` display names, the "Copy Brand Config" build phase (see [Platform build constraints](platform-build-constraints.md)).

## Markers

`BrandConfig`, `BrandConfig.shared`, `brand.json`, `goldilocksdigital.xyz`, `logoImageName`, `botImageName`, `AppIcon-`.

## Upstream-sync guidance

- **Mechanical but pervasive — batch it.** When upstream adds a new "Convos" string literal or bundled asset reference in a file we render, re-point it at `BrandConfig.shared`. Low-risk, just tedious; do it in one pass.
- **Owned brand files are free** — assets, `brand.json`, `BrandConfig`, icons have no upstream equivalent.
- **The build phase is the one gotcha** — re-add the "Copy Brand Config" build phase to upstream's project after a pbxproj regeneration ([Platform build constraints](platform-build-constraints.md)).
- Prefer adding any *new* brand value to `brand.json` + `BrandConfig` rather than a literal, so the next sync stays mechanical.

## Related

[Platform build constraints](platform-build-constraints.md) (brand build phase, codegen) · [Roles & managed groups](roles-and-managed-groups.md) (chips use brand colors) · [Backend & shared monorepo](backend-and-shared-monorepo.md) (`shared/` codegen)
