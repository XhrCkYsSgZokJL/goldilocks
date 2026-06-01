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

import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { getStripe, isStripeConfigured } from '../billing/stripe.js';
import { reconcileCheckoutSession } from '../billing/reconcile-checkout.js';
import { emitSecurityEvent } from '../observability/security-events.js';

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
        await reconcileCheckoutSession(event.data.object as Stripe.Checkout.Session, req.log);
      }
    } catch (err) {
      req.log.error({ err, type: event.type }, 'stripe webhook handler failed');
      // 500 tells Stripe to retry the delivery.
      return reply.code(500).send({ error: 'handler_error' });
    }

    return reply.code(200).send({ received: true });
  });
}

