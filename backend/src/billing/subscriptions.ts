// Stripe subscription billing service.
//
// One per-seat subscription per client ($100/mo × enabled seats), plus a
// flat one-time $100 initial-report fee charged when a new person is
// enabled. Stripe owns proration, invoicing, dunning, and cancellation.
//
// Seat quantity = the number of enabled people whose initial coverage
// window has ended (i.e. who have rolled into recurring billing). New
// people are covered by the $100 fee until the 1st of the month after
// next, then promoted into the subscription quantity by the daily tick.
//
// This module is the Stripe-facing layer only — callers (person-activation,
// daily-tick, billing routes) own the database bookkeeping.

import { and, eq, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db/client.js';
import { clients, referrals } from '../db/schema.js';
import { config } from '../config.js';
import { getStripe } from './stripe.js';
import { INITIAL_REPORT_FEE_CENTS } from './pricing.js';
import { emitBillingEvent } from '../observability/billing-events.js';
import { logger } from '../observability/logger.js';

// Referral rewards, in cents — $50 credit for the referrer, $50 discount
// for the referred client, both applied as Stripe customer-balance credit.
const REFERRAL_CREDIT_CENTS = 50_00;
const REFERRAL_DISCOUNT_CENTS = 50_00;

const log = logger.child({ module: 'billing.subscriptions' });

type ClientRow = typeof clients.$inferSelect;

// The next 1st of the month at 00:00 UTC — the subscription billing anchor.
function nextMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// Find-or-create the Stripe customer for a client and cache its id.
export async function ensureCustomer(client: ClientRow): Promise<string> {
  if (client.stripeCustomerId) return client.stripeCustomerId;
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    metadata: {
      clientId: client.id,
      inboxId: client.inboxId,
      clientNumber: String(client.clientNumber),
    },
  });
  await db.update(clients).set({ stripeCustomerId: customer.id }).where(eq(clients.id, client.id));
  log.info({ clientId: client.id }, 'stripe customer created');
  return customer.id;
}

// The customer's card on file, or null if none has been saved yet.
export async function defaultPaymentMethod(customerId: string): Promise<string | null> {
  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) return null;
  const pm = customer.invoice_settings?.default_payment_method;
  if (pm) return typeof pm === 'string' ? pm : pm.id;
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
  return methods.data[0]?.id ?? null;
}

// Charge the flat one-time $100 initial-report fee off-session against the
// customer's saved card. Throws 'no_payment_method' if no card is on file.
export async function chargeInitialReportFee(client: ClientRow): Promise<{ paymentIntentId: string }> {
  const stripe = getStripe();
  const customerId = await ensureCustomer(client);
  const pm = await defaultPaymentMethod(customerId);
  if (!pm) throw new Error('no_payment_method');
  const intent = await stripe.paymentIntents.create({
    amount: INITIAL_REPORT_FEE_CENTS,
    currency: 'usd',
    customer: customerId,
    payment_method: pm,
    off_session: true,
    confirm: true,
    description: 'Goldilocks initial report',
    metadata: { clientId: client.id, kind: 'initial_report' },
  });
  log.info({ clientId: client.id, paymentIntentId: intent.id }, 'initial report fee charged');
  return { paymentIntentId: intent.id };
}

export interface SeatQuantityResult {
  subscriptionId: string | null;
  subscriptionItemId: string | null;
}

// Set the recurring seat quantity. Creates the subscription on the first
// billable seat (anchored to the next 1st), updates the quantity with
// proration thereafter, and cancels the subscription when it reaches zero.
export async function setSeatQuantity(client: ClientRow, quantity: number): Promise<SeatQuantityResult> {
  const stripe = getStripe();
  const priceId = config.STRIPE_SEAT_PRICE_ID;
  if (!priceId) throw new Error('seat_price_not_configured');

  if (quantity <= 0) {
    if (client.stripeSubscriptionId) {
      await stripe.subscriptions.cancel(client.stripeSubscriptionId);
      await db
        .update(clients)
        .set({ stripeSubscriptionId: null, stripeSubscriptionItemId: null })
        .where(eq(clients.id, client.id));
      log.info({ clientId: client.id }, 'subscription cancelled (zero seats)');
    }
    return { subscriptionId: null, subscriptionItemId: null };
  }

  if (client.stripeSubscriptionId && client.stripeSubscriptionItemId) {
    await stripe.subscriptionItems.update(client.stripeSubscriptionItemId, {
      quantity,
      proration_behavior: 'create_prorations',
    });
    return {
      subscriptionId: client.stripeSubscriptionId,
      subscriptionItemId: client.stripeSubscriptionItemId,
    };
  }

  const customerId = await ensureCustomer(client);
  const pm = await defaultPaymentMethod(customerId);
  if (!pm) throw new Error('no_payment_method');
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId, quantity }],
    default_payment_method: pm,
    billing_cycle_anchor: Math.floor(nextMonthStart().getTime() / 1000),
    proration_behavior: 'create_prorations',
    metadata: { clientId: client.id },
  });
  const itemId = subscription.items.data[0]?.id ?? null;
  await db
    .update(clients)
    .set({ stripeSubscriptionId: subscription.id, stripeSubscriptionItemId: itemId })
    .where(eq(clients.id, client.id));
  log.info({ clientId: client.id, subscriptionId: subscription.id, quantity }, 'subscription created');
  return { subscriptionId: subscription.id, subscriptionItemId: itemId };
}

// Stop coverage at the end of the current paid period. The current period
// and the $100 initial fee are non-refundable; future periods are simply
// not billed.
export async function cancelAtPeriodEnd(client: ClientRow): Promise<{ active: boolean }> {
  if (!client.stripeSubscriptionId) return { active: false };
  const stripe = getStripe();
  const sub = await stripe.subscriptions.update(client.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
  log.info({ clientId: client.id, subscriptionId: sub.id }, 'subscription set to cancel at period end');
  return { active: sub.status === 'active' || sub.status === 'trialing' };
}

export interface SubscriptionStatus {
  active: boolean;
  status: string | null;
  quantity: number;
  cancelAtPeriodEnd: boolean;
}

// Read the live subscription state from Stripe.
export async function subscriptionStatus(client: ClientRow): Promise<SubscriptionStatus> {
  if (!client.stripeSubscriptionId) {
    return { active: false, status: null, quantity: 0, cancelAtPeriodEnd: false };
  }
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(client.stripeSubscriptionId);
  const item = sub.items.data[0];
  const activeStatuses: string[] = ['active', 'trialing', 'past_due'];
  return {
    active: activeStatuses.includes(sub.status),
    status: sub.status,
    quantity: item?.quantity ?? 0,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

// --- Webhook-driven state changes -------------------------------------

// Subscription statuses that mean coverage has truly ended (past dunning).
const LAPSED_STATUSES: string[] = ['canceled', 'unpaid', 'incomplete_expired'];

// Whether a subscription status should flip a client's coverage off.
export function isLapsedStatus(status: string): boolean {
  return LAPSED_STATUSES.includes(status);
}

// Turn a client's coverage off when their subscription lapses (final
// payment failure or cancellation). Looked up by subscription id; safe to
// call for unknown subscriptions. Clears the cached subscription handles
// when the subscription was deleted.
export async function handleSubscriptionLapsed(
  subscriptionId: string,
  options: { clearHandles?: boolean } = {},
): Promise<void> {
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.stripeSubscriptionId, subscriptionId))
    .limit(1);
  if (!client) return;
  await db
    .update(clients)
    .set({
      coverageEnabled: false,
      ...(options.clearHandles ? { stripeSubscriptionId: null, stripeSubscriptionItemId: null } : {}),
    })
    .where(eq(clients.id, client.id));
  log.warn({ clientId: client.id, subscriptionId }, 'coverage lapsed via stripe webhook');
}

// Persist the saved card from a completed setup-mode Checkout Session as
// the customer's default and flag the client. Backstop for the
// /payment-method/confirm endpoint in case the app never calls it.
export async function handleSetupSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
  const setupIntentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id ?? null;
  if (!customerId || !setupIntentId) return;
  const stripe = getStripe();
  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
  const pm = setupIntent.payment_method;
  const pmId = pm ? (typeof pm === 'string' ? pm : pm.id) : null;
  if (!pmId) return;
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pmId } });
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.stripeCustomerId, customerId))
    .limit(1);
  if (!client) return;
  await db.update(clients).set({ hasPaymentMethod: true }).where(eq(clients.id, client.id));
  log.info({ clientId: client.id }, 'payment method saved via stripe webhook');
}

// --- Referral credit ---------------------------------------------------

// Apply a Stripe customer-balance credit (a negative balance transaction
// reduces the customer's future invoices). Creates the customer if needed.
async function creditCustomerBalance(client: ClientRow, amountCents: number, description: string): Promise<void> {
  const stripe = getStripe();
  const customerId = await ensureCustomer(client);
  await stripe.customers.createBalanceTransaction(customerId, {
    amount: -amountCents,
    currency: 'usd',
    description,
  });
}

// When a referred client makes their first real payment (the $100 initial
// report fee), grant the referrer a $50 credit and the referred client a
// $50 discount — both as Stripe customer-balance credit applied to future
// invoices. The referrer's `referralCreditCents` is also bumped so the app
// can show the credit they've earned. Idempotent via the referrals
// timestamps; best-effort, never throws into the caller.
export async function applyReferralCreditsForPayingClient(
  referredClientId: string,
  emitLog: FastifyBaseLogger,
): Promise<void> {
  try {
    const [referral] = await db
      .select()
      .from(referrals)
      .where(and(eq(referrals.referredClientId, referredClientId), isNull(referrals.referrerCreditAppliedAt)))
      .limit(1);
    if (!referral) return;

    const now = new Date();

    if (!referral.referredDiscountAppliedAt) {
      const [referred] = await db.select().from(clients).where(eq(clients.id, referredClientId)).limit(1);
      if (referred) {
        await creditCustomerBalance(referred, REFERRAL_DISCOUNT_CENTS, 'Goldilocks referral discount');
        await db.update(referrals).set({ referredDiscountAppliedAt: now }).where(eq(referrals.id, referral.id));
        emitBillingEvent(emitLog, {
          event: 'billing.referral.discount',
          clientId: referredClientId,
          context: { discountCents: REFERRAL_DISCOUNT_CENTS, referralId: referral.id },
        });
      }
    }

    const [referrer] = await db.select().from(clients).where(eq(clients.id, referral.referrerClientId)).limit(1);
    if (referrer) {
      await creditCustomerBalance(referrer, REFERRAL_CREDIT_CENTS, 'Goldilocks referral credit');
      await db
        .update(clients)
        .set({ referralCreditCents: referrer.referralCreditCents + REFERRAL_CREDIT_CENTS })
        .where(eq(clients.id, referrer.id));
      emitBillingEvent(emitLog, {
        event: 'billing.referral.credit',
        clientId: referrer.id,
        context: { creditCents: REFERRAL_CREDIT_CENTS, referredClientId, referralId: referral.id },
      });
    }

    await db.update(referrals).set({ referrerCreditAppliedAt: now }).where(eq(referrals.id, referral.id));
    emitLog.info(
      { referralId: referral.id, referrerId: referral.referrerClientId, referredId: referredClientId },
      'referral credits applied (stripe customer balance)',
    );
  } catch (error) {
    emitLog.warn({ error, referredClientId }, 'failed to apply referral credits');
  }
}
