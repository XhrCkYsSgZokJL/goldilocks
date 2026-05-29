// Stripe webhook — POST /v2/stripe/webhook.
//
// This is the source of truth for top-ups. /v2/billing/checkout only
// *starts* a payment; the balance is credited only when Stripe calls
// back here and the signature verifies.
//
// With the prepaid-balance model there are no subscriptions or invoices,
// so the only event that matters is checkout.session.completed.
//
// Registered as its own Fastify plugin so its raw-body content-type
// parser stays encapsulated and doesn't affect JSON-parsing routes.

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { billingCheckouts, clients } from '../db/schema.js';
import { getStripe, isStripeConfigured } from '../billing/stripe.js';
import { settle } from '../billing/balance.js';

export default async function stripeWebhookRoutes(app: FastifyInstance) {
  // Stripe signs the exact raw request bytes, so we must verify against
  // the unparsed body. Capture application/json as a Buffer instead of
  // letting Fastify parse it. Encapsulated to this plugin.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/v2/stripe/webhook', {
    config: {
      // Stripe's retry policy can fire bursts of webhook deliveries; the
      // signature check is the real defence. Skip the global rate limit
      // here so a legitimate burst from Stripe isn't dropped.
      rateLimit: false,
    },
  }, async (req, reply) => {
    if (!isStripeConfigured() || !config.STRIPE_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'billing_unavailable' });
    }

    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      return reply.code(400).send({ error: 'missing_signature' });
    }

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(
        req.body as Buffer,
        signature,
        config.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      req.log.warn({ err }, 'stripe webhook signature verification failed');
      return reply.code(400).send({ error: 'invalid_signature' });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        await onCheckoutCompleted(event.data.object as Stripe.Checkout.Session, req.log);
      }
      // Every other event type is intentionally ignored.
    } catch (err) {
      req.log.error({ err, type: event.type }, 'stripe webhook handler failed');
      // 500 tells Stripe to retry the delivery.
      return reply.code(500).send({ error: 'handler_error' });
    }

    return reply.code(200).send({ received: true });
  });
}

// A top-up completed — mark the audit row done and credit its amount to
// the client's prepaid balance, settling first so the existing balance is
// drained for the time elapsed before the top-up.
async function onCheckoutCompleted(session: Stripe.Checkout.Session, log: FastifyBaseLogger): Promise<void> {
  const [checkout] = await db
    .select()
    .from(billingCheckouts)
    .where(eq(billingCheckouts.stripeSessionId, session.id))
    .limit(1);

  if (!checkout) {
    log.warn({ sessionId: session.id }, 'checkout.session.completed for an unknown session');
    return;
  }
  if (checkout.status === 'completed') {
    return; // Idempotent — Stripe may deliver the same event more than once.
  }

  await db
    .update(billingCheckouts)
    .set({
      status: 'completed',
      completedAt: new Date(),
      stripePaymentIntentId: stripeId(session.payment_intent),
    })
    .where(eq(billingCheckouts.id, checkout.id));

  const [client] = await db.select().from(clients).where(eq(clients.id, checkout.clientId)).limit(1);
  if (!client) {
    log.warn({ clientId: checkout.clientId }, 'completed checkout for an unknown client');
    return;
  }

  // Settle the running balance at the old rate, then credit the top-up
  // and switch to the seat count the client checked out with.
  const settled = settle(client);
  const customerId = stripeId(session.customer);

  await db
    .update(clients)
    .set({
      billingBalanceCents: settled.balanceCents + checkout.amountCents,
      billingBalanceAsOf: settled.asOf,
      billingSeats: checkout.seats,
      ...(customerId && !client.stripeCustomerId ? { stripeCustomerId: customerId } : {}),
    })
    .where(eq(clients.id, client.id));

  log.info({ clientId: client.id, amountCents: checkout.amountCents }, 'billing top-up credited');
}

// A Stripe field that can be an id string, an expanded object, or null.
function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}
