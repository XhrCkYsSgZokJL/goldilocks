// Shared checkout reconciliation.
//
// Called by:
//   1. The Stripe webhook (checkout.session.completed)
//   2. GET /v2/billing/return (browser redirect after checkout)
//   3. GET /v2/billing/checkout-status/:sessionId (iOS polling)
//
// Idempotent — safe to call multiple times for the same session.

import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billingCheckouts, clients } from '../db/schema.js';
import { getStripe, isStripeConfigured } from './stripe.js';
import { settle } from './balance.js';
import { emitBillingEvent } from '../observability/billing-events.js';
import { logger } from '../observability/logger.js';

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

  return { credited: true, alreadyCompleted: false, amountCents: checkout.amountCents };
}
