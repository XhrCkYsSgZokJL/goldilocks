# Seat-based subscriptions + people management — Plan

_Generated 2026-05-21._

## What this is

Replace the single-plan model (No plan / Light / Active, pick one) with
**configurable seat quantities**: a client buys, say, 2 Light seats and 4
Active seats. The Settings section shows the monthly total and the next
charge date, and a people-management section lets the client name the
person in each seat and push that roster to their Advisory chat.

This **supersedes** the just-built single-tier model (`subscription_tier`,
`requested_tier`, the No plan row, the request/approve flow). That code
will be largely removed.

## Decisions locked in

- **Seats:** quantity per tier (Light $100/mo, Active $200/mo), set
  directly by the client — no team approval.
- **Billing:** Stripe, card entered in-app.
- **People:** one named person per seat (name / email / phone), the list
  capped at total seats; stored on the device.
- **Roster → Advisory:** a "Send to Advisory chat" button posts the
  people list into the client's Advisory XMTP group.

## App Review caveat — read before building

Selling a digital subscription in-app with Stripe rather than Apple IAP
is allowed **only** in specific cases. Apple requires IAP for digital
goods/services consumed in the app; it permits outside payment for
real-world/person-to-person services. A security service delivered by
human advisors plausibly qualifies as a real-world service — but this is
an App Review judgement call, and a rejection is costly. **Confirm the
classification (ideally with Apple or an App Review-savvy consultant)
before submitting.**

## What you need to set up (I can't do these)

- A **Stripe account**.
- In the Stripe dashboard: two recurring **Prices** — "Light" $100/mo and
  "Active" $200/mo. Stripe handles per-seat quantity and proration
  natively via the subscription line-item `quantity`.
- **API keys**: secret key → `goldilocks-backend` env; publishable key →
  iOS config. A **webhook signing secret** for the backend.

## Stages

### Stage 1 — UI redesign (billing-agnostic, buildable now)

No Stripe dependency — pure SwiftUI + local state.

- Replace the SubscriptionView rows with per-tier **steppers** (Light −/N/+,
  Active −/M/+).
- Show **monthly total** = N×$100 + M×$200.
- Show **"Next charge: <1st of next month>"**.
- A **people section** below: up to N+M rows, each name / email / phone,
  add / edit / remove. Persisted on-device.
- **"Send to Advisory chat"** button — composes the roster as a message
  and sends it to the client's Advisory XMTP group.
- The "Subscribe / Update" button is stubbed until Stage 3.

### Stage 2 — Backend Stripe integration

- Add the `stripe` SDK to `goldilocks-backend`.
- Migration: `clients` gains `stripe_customer_id`, `stripe_subscription_id`,
  `light_seats`, `active_seats`.
- Endpoints: create/fetch the client's Stripe customer; create/update the
  subscription with the seat quantities; issue a SetupIntent for card entry.
- `POST /v2/stripe/webhook` — handle `invoice.paid`, `payment_failed`,
  `customer.subscription.updated`; keep `clients` in sync.

### Stage 3 — iOS Stripe SDK

- Add the Stripe iOS SDK (`StripePaymentSheet`) — card entry is PCI-handled
  by Stripe; the app never touches raw card numbers.
- Wire "Subscribe / Update" to PaymentSheet.
- On seat changes, call the backend to update the subscription quantity
  (Stripe prorates automatically).

## Recommendation

1. **Stabilise first.** Get the current build green (the libxmtp 4.10
   migration), tested, and committed before starting this. Don't stack a
   project on an unverified build.
2. Then **Stage 1** — it's real, valuable, and has zero Stripe
   dependency, so it can ship and be tested on its own.
3. **Stages 2–3** once the Stripe account + dashboard products exist.
