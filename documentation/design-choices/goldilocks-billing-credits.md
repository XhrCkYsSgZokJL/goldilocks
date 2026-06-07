# Goldilocks Billing & Credits

**Category:** Product · **Primary strategy:** OWN (credits service) + REPLACE-EXTEND (subscription UI) + GATE (StoreKit)

## What

Goldilocks runs its **own credits + subscription system** against our backend, rather than Apple StoreKit in-app purchases. Membership tiers (with branded styling) and a credit balance drive the paywall and upgrade surfaces. The StoreKit purchase path exists in upstream and is kept but not the billing source of truth.

## Why

Goldilocks bills through its own backend (membership tiers, credits, upgrade codes), not the App Store. Tying revenue to StoreKit would cede control and a 30% cut, and doesn't fit a concierge model. We keep a `StoreKitSubscriptionService` for compatibility but the live path is `BackendCreditsService`.

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks |
|--------|----------|------------|
| Billing source | StoreKit IAP | Goldilocks backend (`GoldilocksBilling`, credits) |
| Balance | — | `CreditsServices` / `BackendCreditsService` (upserts `credit_balance`, observed via `CreditsRepository`) |
| Tiers | — | `GoldilocksMembershipTier` (+ branded `…+Style`) |
| Paywall | StoreKit products | tier/credits-driven |

## Files affected

### Owned (additive)
- `ConvosCore/Sources/ConvosCore/Billing/GoldilocksBilling.swift` — backend billing.
- `ConvosCore/Sources/ConvosCore/Services/Credits/CreditsServices.swift`, `BackendCreditsService.swift` — credit balance service + repository wiring.
- `Convos/App Settings/GoldilocksMembershipTier+Style.swift` — tier styling.
- `Convos/Subscription/SubscriptionServices.swift`, `SubscriptionSettingsView.swift` (+ `PaywallView`/`PaywallViewModel` Goldilocks surfaces).

### Extended (REPLACE-EXTEND)
- `ConvosCore/Sources/ConvosCore/ConvosClient+App.swift` — wires `CreditsServices` to the DB + API at construction.
- `ConvosCore/Sources/ConvosCore/API/ConvosAPIClient.swift` — credits/subscription endpoints (see [[auth-against-goldilocks-backend]]).
- `Convos/App Settings/AppSettingsView.swift` — membership tier UI, upgrade prompt.
- `Convos/Conversation Detail/ConversationView.swift` / `ConversationViewModel.swift`, `…/ConversationOnboardingView.swift` — low-balance banner, paywall step.

### Gated (kept for compatibility)
- `Convos/Subscription/StoreKitSubscriptionService.swift` — StoreKit path kept but not the source of truth.

## Markers

`GoldilocksBilling`, `CreditsServices`, `BackendCreditsService`, `CreditsRepository`, `credit_balance`, `MembershipTier` / `GoldilocksMembershipTier`, `membershipTier`, `SubscriptionServices`.

## Upstream-sync guidance

- **Don't let a sync adopt StoreKit as the billing source.** Upstream's IAP evolution is GATE/compatibility-only — keep `BackendCreditsService` as the live path.
- **The credits service is owned** — bring it as-is; only its wiring in `ConvosClient+App` is REPLACE-EXTEND.
- When upstream changes the paywall/subscription UI, re-apply the tier/credits binding on top of their structure.
- Backend billing lives in `backend/src/billing/` (see [[backend-and-shared-monorepo]]); keep the iOS credit model and shared types in sync via codegen.
- Reference: `docs/plans/in-app-purchases-and-credits.md`, `docs/plans/subscription-product-catalog.md`.

## Related

[[auth-against-goldilocks-backend]] · [[roles-and-managed-groups]] (tier chips) · [[backend-and-shared-monorepo]]
