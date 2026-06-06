// Stripe webhook — POST /v2/stripe/webhook.
//
// Source of truth for billing state changes. The app only *starts* flows
// (card setup, person activation); Stripe calls back here once the
// signature verifies and we update coverage accordingly.
//
// Handled events:
//   checkout.session.completed   — setup mode: save the card; payment
//                                  mode: credit a legacy deposit.
//   customer.subscription.updated — flip coverage off if the status has
//                                  lapsed (unpaid / canceled).
//   customer.subscription.deleted — coverage ended; flip it off.
//   invoice.payment_failed        — logged; Stripe dunning continues, the
//                                  subscription.* events drive any lapse.
//
// Registered as its own Fastify plugin so its raw-body content-type
// parser stays encapsulated and doesn't affect JSON-parsing routes.

import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { getStripe, isStripeConfigured } from '../billing/stripe.js';
import { reconcileCheckoutSession } from '../billing/reconcile-checkout.js';
import { handleSetupSessionCompleted, handleSubscriptionLapsed, isLapsedStatus } from '../billing/subscriptions.js';
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
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.mode === 'setup') {
            await handleSetupSessionCompleted(session);
          } else {
            await reconcileCheckoutSession(session, req.log);
          }
          break;
        }
        case 'customer.subscription.updated': {
          const sub = event.data.object as Stripe.Subscription;
          if (isLapsedStatus(sub.status)) {
            await handleSubscriptionLapsed(sub.id);
          }
          break;
        }
        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          await handleSubscriptionLapsed(sub.id, { clearHandles: true });
          break;
        }
        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice;
          // Stripe dunning keeps retrying; the subscription.* events drive
          // any actual lapse. Just record the failure here.
          req.log.warn({ invoiceId: invoice.id, type: event.type }, 'stripe invoice payment failed');
          break;
        }
        default:
          break;
      }
    } catch (err) {
      req.log.error({ err, type: event.type }, 'stripe webhook handler failed');
      // 500 tells Stripe to retry the delivery.
      return reply.code(500).send({ error: 'handler_error' });
    }

    return reply.code(200).send({ received: true });
  });
}

