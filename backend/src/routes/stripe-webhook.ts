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
import { emitSecurityEvent } from '../observability/security-events.js';
import { emitBillingEvent } from '../observability/billing-events.js';

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
      emitSecurityEvent(req.log, {
        event: 'stripe.webhook.missing_signature',
        ip: req.ip,
        severity: 'warn',
      });
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
      // Critical: someone is hitting our webhook with bad signatures.
      // Stripe's own retries don't produce these — it's either a probe
      // or a misconfigured environment. The error object is logged for
      // diagnostics; its .message comes from the Stripe SDK and never
      // contains the secret or the raw body.
      emitSecurityEvent(req.log, {
        event: 'stripe.webhook.invalid_signature',
        ip: req.ip,
        severity: 'critical',
        context: { error: (err as Error).message },
      });
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
    emitBillingEvent(log, {
      event: 'billing.checkout.completed',
      severity: 'warn',
      context: { reason: 'unknown_session' },
    });
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
    emitBillingEvent(log, {
      event: 'billing.checkout.completed',
      severity: 'warn',
      clientId: checkout.clientId,
      context: { reason: 'unknown_client' },
    });
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

  emitBillingEvent(log, {
    event: 'billing.checkout.completed',
    clientId: client.id,
    inboxId: client.inboxId,
    context: { amountCents: checkout.amountCents, durationMonths: checkout.durationMonths, seats: checkout.seats },
  });

  emitBillingEvent(log, {
    event: 'billing.balance.credited',
    clientId: client.id,
    inboxId: client.inboxId,
    context: {
      creditedCents: checkout.amountCents,
      previousBalanceCents: settled.balanceCents,
      newBalanceCents: settled.balanceCents + checkout.amountCents,
    },
  });
}

// A Stripe field that can be an id string, an expanded object, or null.
function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}
