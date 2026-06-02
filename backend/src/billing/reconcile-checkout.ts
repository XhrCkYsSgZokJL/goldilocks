// Shared checkout reconciliation.
//
// Called by:
//   1. The Stripe webhook (checkout.session.completed)
//   2. GET /v2/billing/return (browser redirect after checkout)
//   3. GET /v2/billing/checkout-status/:sessionId (iOS polling)
//
// Idempotent — safe to call multiple times for the same session.

import type { FastifyBaseLogger } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billingCheckouts, clients, referrals } from '../db/schema.js';
import { getStripe, isStripeConfigured } from './stripe.js';
import { settle } from './balance.js';
import { emitBillingEvent } from '../observability/billing-events.js';
import { logger } from '../observability/logger.js';

const REFERRAL_CREDIT_CENTS = 5000;
const REFERRAL_DISCOUNT_CENTS = 5000;

const log = logger.child({ module: 'billing.reconcile' });

function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

export interface ReconcileResult {
  credited: boolean;
  alreadyCompleted: boolean;
  amountCents: number;
}

// Credit a checkout session's amount to the client's balance.
// Accepts either a Stripe Session object (from webhook) or just a
// session ID (from polling — fetches the session from Stripe).
export async function reconcileCheckoutSession(
  sessionOrId: string | { id: string; payment_intent: string | { id: string } | null; customer: string | { id: string } | null },
  parentLog?: FastifyBaseLogger,
): Promise<ReconcileResult> {
  const emitLog = parentLog ?? log;

  type StripeRef = string | { id: string } | null | undefined;
  let sessionId: string;
  let paymentIntent: StripeRef;
  let customer: StripeRef;

  if (typeof sessionOrId === 'string') {
    if (!isStripeConfigured()) {
      return { credited: false, alreadyCompleted: false, amountCents: 0 };
    }
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionOrId);
    if (session.payment_status !== 'paid') {
      return { credited: false, alreadyCompleted: false, amountCents: 0 };
    }
    sessionId = session.id;
    paymentIntent = session.payment_intent;
    customer = session.customer;
  } else {
    sessionId = sessionOrId.id;
    paymentIntent = sessionOrId.payment_intent;
    customer = sessionOrId.customer;
  }

  // stripeSessionId is encrypted at rest with AES-GCM (random nonce),
  // so SQL equality won't match. Fetch recent rows and match in-app
  // after Drizzle's fromDriver decrypts them.
  const recentCheckouts = await db
    .select()
    .from(billingCheckouts);
  const checkout = recentCheckouts.find(c => c.stripeSessionId === sessionId);

  if (!checkout) {
    emitBillingEvent(emitLog, {
      event: 'billing.checkout.completed',
      severity: 'warn',
      context: { reason: 'unknown_session' },
    });
    return { credited: false, alreadyCompleted: false, amountCents: 0 };
  }
  if (checkout.status === 'completed') {
    return { credited: false, alreadyCompleted: true, amountCents: checkout.amountCents };
  }

  await db
    .update(billingCheckouts)
    .set({
      status: 'completed',
      completedAt: new Date(),
      stripePaymentIntentId: stripeId(paymentIntent),
    })
    .where(eq(billingCheckouts.id, checkout.id));

  const [client] = await db.select().from(clients).where(eq(clients.id, checkout.clientId)).limit(1);
  if (!client) {
    emitBillingEvent(emitLog, {
      event: 'billing.checkout.completed',
      severity: 'warn',
      clientId: checkout.clientId,
      context: { reason: 'unknown_client' },
    });
    return { credited: false, alreadyCompleted: false, amountCents: checkout.amountCents };
  }

  const settled = settle(client);
  const customerId = stripeId(customer);

  await db
    .update(clients)
    .set({
      billingBalanceCents: settled.balanceCents + checkout.amountCents,
      billingBalanceAsOf: settled.asOf,
      billingSeats: checkout.seats,
      ...(customerId && !client.stripeCustomerId ? { stripeCustomerId: customerId } : {}),
    })
    .where(eq(clients.id, client.id));

  emitBillingEvent(emitLog, {
    event: 'billing.checkout.completed',
    clientId: client.id,
    inboxId: client.inboxId,
    context: { amountCents: checkout.amountCents, durationMonths: checkout.durationMonths, seats: checkout.seats },
  });

  emitBillingEvent(emitLog, {
    event: 'billing.balance.credited',
    clientId: client.id,
    inboxId: client.inboxId,
    context: {
      creditedCents: checkout.amountCents,
      previousBalanceCents: settled.balanceCents,
      newBalanceCents: settled.balanceCents + checkout.amountCents,
    },
  });

  await applyReferralCredits(client.id, emitLog);

  const dollars = (checkout.amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  await sendAdvisoryMessage(client.id, `Your ${dollars} payment has been received. Thank you!`);

  return { credited: true, alreadyCompleted: false, amountCents: checkout.amountCents };
}

async function applyReferralCredits(
  payingClientId: string,
  emitLog: FastifyBaseLogger,
): Promise<void> {
  const [referral] = await db
    .select()
    .from(referrals)
    .where(
      and(
        eq(referrals.referredClientId, payingClientId),
        isNull(referrals.referrerCreditAppliedAt),
      ),
    )
    .limit(1);

  if (!referral) return;

  const now = new Date();

  // $50 discount for the referred client (first payment only).
  if (!referral.referredDiscountAppliedAt) {
    const [referred] = await db.select().from(clients).where(eq(clients.id, payingClientId)).limit(1);
    if (referred) {
      const referredSettled = settle(referred);
      await db
        .update(clients)
        .set({
          billingBalanceCents: referredSettled.balanceCents + REFERRAL_DISCOUNT_CENTS,
          billingBalanceAsOf: referredSettled.asOf,
        })
        .where(eq(clients.id, payingClientId));

      emitBillingEvent(emitLog, {
        event: 'billing.referral.discount',
        clientId: payingClientId,
        context: { discountCents: REFERRAL_DISCOUNT_CENTS, referralId: referral.id },
      });
    }

    await db
      .update(referrals)
      .set({ referredDiscountAppliedAt: now })
      .where(eq(referrals.id, referral.id));
  }

  // $50 credit for the referrer — added to the separate referral credit
  // pool, which is drawn before the prepaid balance on charges.
  const [referrer] = await db.select().from(clients).where(eq(clients.id, referral.referrerClientId)).limit(1);
  if (referrer) {
    await db
      .update(clients)
      .set({
        referralCreditCents: referrer.referralCreditCents + REFERRAL_CREDIT_CENTS,
      })
      .where(eq(clients.id, referrer.id));

    emitBillingEvent(emitLog, {
      event: 'billing.referral.credit',
      clientId: referrer.id,
      context: { creditCents: REFERRAL_CREDIT_CENTS, referredClientId: payingClientId, referralId: referral.id },
    });

    const creditDollars = (REFERRAL_CREDIT_CENTS / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    await sendAdvisoryMessage(referrer.id, `You earned a ${creditDollars} referral credit. Thank you for spreading the word!`);
  }

  await db
    .update(referrals)
    .set({ referrerCreditAppliedAt: now })
    .where(eq(referrals.id, referral.id));

  log.info({ referralId: referral.id, referrerId: referral.referrerClientId, referredId: payingClientId },
    'referral credits applied');
}

async function sendAdvisoryMessage(clientId: string, message: string): Promise<void> {
  try {
    const json: string = JSON.stringify({ client_id: clientId, message });
    await db.execute(sql`SELECT pg_notify('advisory_message', ${json})`);
  } catch (err) {
    log.warn({ err, clientId: clientId.slice(0, 8) }, 'failed to emit advisory_message notify');
  }
}
