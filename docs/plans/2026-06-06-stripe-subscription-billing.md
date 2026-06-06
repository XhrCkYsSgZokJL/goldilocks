# Stripe Subscription Billing

**Status:** Draft
**Date:** 2026-06-06
**Owner:** Morgan

> Replaces the prepaid-balance billing model with a single per-client Stripe
> subscription. Stripe owns proration, invoicing, dunning, and cancellation.
> The only bespoke rule is a flat **$100 one-time charge when a new person is
> enabled** (the initial report).

## Summary

Move billing to a single Stripe subscription per client, priced per seat at
**$100/mo** (`MONTHLY_PRICE_CENTS`), with the subscription quantity equal to the
number of enabled people. Every mid-cycle change is handled by Stripe proration.
The one exception is **adding a new person**, which triggers an immediate flat
**$100** charge for their initial report instead of a prorated partial month.
After that first charge the person is an ordinary seat and renews on the 1st of
the month with everyone else.

This removes the hand-rolled prepaid wallet entirely: no stored balance, no
deposit/top-up checkout, no monthly balance tick, no pro-rata refund loop.

## Why

The current system (`backend/src/billing/balance.ts`, `daily-tick.ts`,
`person-activation.ts`) is a stored-value wallet built on top of metered billing:
clients pre-fund a balance, we deduct on enable and again on a monthly tick,
coverage lapses at zero, and cancellation runs a manual pro-rata Stripe refund.
That is a lot of money-handling code we maintain and must keep correct.

Stripe subscriptions already provide all of it — proration, scheduled invoicing,
failed-payment dunning, cancellation at period end, and account credits — so the
balance, the tick, and the refund loop become redundant. We keep one small rule
of our own (the $100 new-person fee), and Stripe does the rest.

Payment is **Stripe-only** for now. Apple Pay and Crypto are already hidden in
the UI (`GoldilocksPaymentMethod.selectableCases`) and are out of scope here.

## Scope

In scope:
- One Stripe `Customer` + per-seat `Subscription` per client, anchored to the 1st.
- Enable new person → immediate $100 charge + add a seat (recurring from next anchor).
- Disable / re-enable existing seats → quantity change, Stripe proration.
- Cancellation → `cancel_at_period_end`.
- Referral credit → Stripe coupon / customer credit balance.
- Billing-status endpoint derived from the subscription, not a balance.
- Migration of existing clients off the prepaid balance.

Out of scope (future):
- Apple Pay / StoreKit and Crypto payment paths.
- Prepaid multi-month "durations" (the deposit model is being removed).
- Per-person self-pay (today one client pays for the whole roster).

## Billing model

One subscription per client. Price = $100/seat/mo. Quantity = enabled people.
Anchor = 1st of the month at 00:00. Stripe computes proration on every change.

| Event | What's charged | When | Owner |
|---|---|---|---|
| Add a **new** person | **$100 flat** (initial report) | Immediately | Our code (one-time charge) |
| New person's recurring billing | $100/mo | Starting next 1st | Stripe |
| Ongoing monthly renewal | $100 × seats | 1st of month, 00:00 | Stripe |
| Re-enable an existing seat mid-cycle | pro-rata $100 | Now / next invoice | Stripe |
| Disable a person mid-cycle | pro-rata credit | Next invoice | Stripe |
| Cancel coverage | nothing; runs to period end | Period end | Stripe (`cancel_at_period_end`) |
| Referral credit | discount on invoices | Next invoice | Stripe coupon / credit |

The $100 stands in for the prorated partial first month, so a new person is never
double-charged: $100 now, then $100/mo on the next 1st.

### Coverage window for the $100 (decision needed)

The $100 covers the new person from enable through **either**:

- **(A) end of the current month** → first recurring $100 lands on the next 1st.
- **(B) end of next month** → first recurring $100 lands on the 1st after next
  (the earlier "30–60 days" idea).

This single choice sets when the first recurring charge happens and how the seat
is added to the subscription (immediately vs. deferred one cycle). **Recommend (A)**
for simplicity unless the longer initial window is a product requirement.

### Re-enable rule (decision needed)

Re-enabling a previously removed person: does it cost $100 again? **Recommend yes**
(a new report is produced), but it could be free within a grace window. Needs a
product call.

## What changes

### Backend

- **Remove:** the prepaid balance (`billingBalanceCents` and its accounting in
  `balance.ts`), the deposit/top-up Stripe Checkout flow, the monthly charge math
  in `daily-tick.ts`, and the pro-rata refund loop in `POST /v2/billing/cancel`.
- **Add:** Stripe subscription plumbing — ensure a `Customer` and per-seat
  `Subscription` per client; a helper to set the subscription item quantity.
- `person-activation.ts` **enable (new):** create the $100 one-time charge, record
  the initial report, add the seat (recurring from the next anchor).
- `person-activation.ts` **disable:** decrement quantity; Stripe issues the credit.
- `POST /v2/billing/cancel`: set `cancel_at_period_end = true`.
- **Billing status:** derive `coverageActive` / `activeUntil` from subscription
  `status` and `current_period_end` rather than the balance.
- **Webhooks:** handle `invoice.paid`, `invoice.payment_failed`,
  `customer.subscription.updated/deleted` to keep coverage state in sync.
- **Schema:** drop balance columns; store `stripeCustomerId`,
  `stripeSubscriptionId`, `stripeSubscriptionItemId` on the client.

### iOS (`MembershipView`)

- Remove the **Balance** row and the deposit/top-up checkout flow entirely.
- Change the enable-person confirmation copy from "$X/mo deducted from balance"
  to "$100 initial report fee."
- Replace the Account section with subscription status: active / renews on the 1st,
  current monthly cost (seats × $100), and per-person status.
- Payment-method and duration pickers are already hidden (Stripe-only, subscription).

### Shared types

- Update the billing-status response: drop `balanceCents`; add subscription status
  fields. Run `npm run codegen` to regenerate Swift + Zod.

## Migration

Existing clients hold a prepaid balance. On cutover, for each client with active
coverage: create the Stripe subscription at the current seat count and convert any
remaining balance into a Stripe **customer credit balance** so it draws down
against future invoices (no cash refund). Zero out the old balance columns after
the credit is applied. Run as a one-time backfill script with a dry-run mode.

## Risks / open questions

- **Coverage-window choice (A vs B)** and **re-enable fee** — product decisions
  above; both affect implementation.
- **Webhook reliability** — coverage state now depends on Stripe webhooks; needs
  idempotent handlers and a reconcile fallback (we already have a reconcile path
  for checkout that can be adapted).
- **Apple/Crypto re-entry** — this model is Stripe-shaped; bringing Apple back
  later means seat-tier products or a separate design (auto-renewable subs don't
  do arbitrary quantity/proration).
- **Migration correctness** — balance→credit conversion must be exact; dry-run and
  reconcile before flipping clients over.

## Rollout

1. Land this plan (PR 1).
2. Stripe plumbing + schema + webhooks behind a feature flag, no behavior change.
3. Enable/disable/cancel switched to the subscription path; balance code removed.
4. iOS Membership UI updated; shared types regenerated.
5. Migration backfill (dry-run → live), then remove the balance columns.
