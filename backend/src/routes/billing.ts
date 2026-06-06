// Prepaid-balance billing.
//
// POST /v2/billing/checkout  — deposit funds (in $100 increments); returns
//                              a hosted Stripe Checkout URL.
// GET  /v2/billing/status    — balance, monthly rate, and "active until".
// POST /v2/billing/seats     — sync the seat mix (the burn rate) when the
//                              client edits their people list.
// POST /v2/billing/cancel    — stop cover and refund the unused balance.
// GET  /v2/billing/return    — browser landing page after checkout.
// GET  /v2/billing/cancel    — browser landing page after a cancelled one.
//
// The balance accounting lives in src/billing/balance.ts. The webhook in
// stripe-webhook.ts is what credits a completed top-up to the balance.

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { billingCheckouts, clients, devices } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { getStripe, isStripeConfigured } from '../billing/stripe.js';
import { activeUntil, isCoverageActive, liveBalanceCents, monthlyRateCents } from '../billing/balance.js';
import { reconcileCheckoutSession } from '../billing/reconcile-checkout.js';
import { cancelAtPeriodEnd, ensureCustomer } from '../billing/subscriptions.js';
import { togglePersonCoverage } from '../billing/person-activation.js';
import { queueSampleReport } from '../billing/sample-report.js';
import { emitBillingEvent } from '../observability/billing-events.js';
import type Stripe from 'stripe';

const CheckoutBody = z.object({
  // 'card' routes to Stripe. 'crypto' is reserved — no provider yet.
  paymentMethod: z.enum(['card', 'crypto']),
  // Deposit amount in cents, must be a positive multiple of $100 (10000 cents).
  amountCents: z.number().int().min(10000),
});

const SeatsBody = z.object({
  seats: z.number().int().min(0).max(999),
});

const PaymentMethodConfirmBody = z.object({
  sessionId: z.string(),
});

export default async function billingRoutes(app: FastifyInstance, opts: { publicBaseUrl: string }) {
  const { publicBaseUrl } = opts;

  // ---------------------------------------------------------------------
  // POST /v2/billing/checkout — deposit funds into prepaid balance.
  // body: { paymentMethod, amountCents }
  // returns: { checkoutUrl, sessionId }
  // ---------------------------------------------------------------------
  app.post('/v2/billing/checkout', { preHandler: requireJwt }, async (req, reply) => {
    if (!isStripeConfigured()) {
      return reply.code(503).send({ error: 'billing_unavailable', message: 'Stripe is not configured on this server.' });
    }

    const parsed = CheckoutBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { paymentMethod, amountCents } = parsed.data;

    if (paymentMethod === 'crypto') {
      return reply.code(501).send({
        error: 'crypto_not_available',
        message: 'Crypto payments are coming soon. Please pay by card for now.',
      });
    }
    if (amountCents % 10000 !== 0) {
      return reply.code(400).send({ error: 'invalid_amount', message: 'Amount must be a multiple of $100.' });
    }

    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    const stripe = getStripe();

    // Find-or-create the Stripe customer so a client's top-ups group
    // under one customer record.
    let customerId = client.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { clientId: client.id, inboxId: client.inboxId, clientNumber: String(client.clientNumber) },
      });
      customerId = customer.id;
      await db.update(clients).set({ stripeCustomerId: customerId }).where(eq(clients.id, client.id));
      emitBillingEvent(req.log, {
        event: 'billing.customer.created',
        clientId: client.id,
        inboxId: client.inboxId,
      });
    }

    const metadata: Record<string, string> = {
      clientId: client.id,
      inboxId: client.inboxId,
      paymentMethod,
      amountCents: String(amountCents),
    };

    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        client_reference_id: client.id,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: amountCents,
              product_data: {
                name: `Goldilocks deposit — $${amountCents / 100}`,
              },
            },
          },
        ],
        success_url: successUrl(publicBaseUrl),
        cancel_url: cancelUrl(publicBaseUrl),
        metadata,
        payment_intent_data: { metadata },
      });
    } catch (err) {
      emitBillingEvent(req.log, {
        event: 'billing.checkout.initiated',
        severity: 'error',
        clientId: client.id,
        inboxId: client.inboxId,
        context: { error: (err as Error).message, paymentMethod, amountCents },
      });
      return reply.code(502).send({ error: 'stripe_error', message: 'Could not start checkout. Please try again.' });
    }

    if (!session.url) {
      return reply.code(502).send({ error: 'stripe_error', message: 'Stripe did not return a checkout URL.' });
    }

    await db.insert(billingCheckouts).values({
      clientId: client.id,
      stripeSessionId: session.id,
      paymentMethod,
      amountCents,
      currency: 'usd',
      status: 'pending',
    });

    emitBillingEvent(req.log, {
      event: 'billing.checkout.initiated',
      clientId: client.id,
      inboxId: client.inboxId,
      context: { paymentMethod, amountCents },
    });

    return reply.code(200).send({ checkoutUrl: session.url, sessionId: session.id });
  });

  // ---------------------------------------------------------------------
  // GET /v2/billing/status — the caller's balance, rate and cover end.
  // ---------------------------------------------------------------------
  app.get('/v2/billing/status', { preHandler: requireJwt }, async (req, reply) => {
    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }
    return reply.code(200).send(billingStatus(client));
  });

  // ---------------------------------------------------------------------
  // POST /v2/billing/payment-method — start a Stripe Checkout in setup mode
  // so the client can save a card. The card is taken off-session later for
  // the $100 initial-report fee and the recurring subscription.
  // returns: { checkoutUrl, sessionId }
  // ---------------------------------------------------------------------
  app.post('/v2/billing/payment-method', { preHandler: requireJwt }, async (req, reply) => {
    if (!isStripeConfigured()) {
      return reply.code(503).send({ error: 'billing_unavailable', message: 'Stripe is not configured on this server.' });
    }
    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }
    const stripe = getStripe();
    const customerId = await ensureCustomer(client);

    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'setup',
        customer: customerId,
        client_reference_id: client.id,
        success_url: successUrl(publicBaseUrl),
        cancel_url: cancelUrl(publicBaseUrl),
        metadata: { clientId: client.id, inboxId: client.inboxId, kind: 'payment_method_setup' },
      });
    } catch (err) {
      emitBillingEvent(req.log, {
        event: 'billing.checkout.initiated',
        severity: 'error',
        clientId: client.id,
        inboxId: client.inboxId,
        context: { error: (err as Error).message, kind: 'payment_method_setup' },
      });
      return reply.code(502).send({ error: 'stripe_error', message: 'Could not start card setup. Please try again.' });
    }
    if (!session.url) {
      return reply.code(502).send({ error: 'stripe_error', message: 'Stripe did not return a setup URL.' });
    }
    return reply.code(200).send({ checkoutUrl: session.url, sessionId: session.id });
  });

  // ---------------------------------------------------------------------
  // POST /v2/billing/payment-method/confirm — after the setup checkout
  // completes, attach the saved card as the customer's default and flag the
  // client as having a payment method. Idempotent.
  // body: { sessionId }  returns: { hasPaymentMethod }
  // ---------------------------------------------------------------------
  app.post('/v2/billing/payment-method/confirm', { preHandler: requireJwt }, async (req, reply) => {
    if (!isStripeConfigured()) {
      return reply.code(503).send({ error: 'billing_unavailable' });
    }
    const parsed = PaymentMethodConfirmBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }
    const stripe = getStripe();
    try {
      const session = await stripe.checkout.sessions.retrieve(parsed.data.sessionId, { expand: ['setup_intent'] });
      const setupIntent = session.setup_intent;
      const pm = setupIntent && typeof setupIntent !== 'string' ? setupIntent.payment_method : null;
      const pmId = pm ? (typeof pm === 'string' ? pm : pm.id) : null;
      if (!pmId || !client.stripeCustomerId) {
        return reply.code(200).send({ hasPaymentMethod: client.hasPaymentMethod });
      }
      await stripe.customers.update(client.stripeCustomerId, {
        invoice_settings: { default_payment_method: pmId },
      });
      const [updated] = await db
        .update(clients)
        .set({ hasPaymentMethod: true })
        .where(eq(clients.id, client.id))
        .returning();
      emitBillingEvent(req.log, {
        event: 'billing.customer.created',
        clientId: client.id,
        inboxId: client.inboxId,
        context: { kind: 'payment_method_saved' },
      });
      return reply.code(200).send({ hasPaymentMethod: updated?.hasPaymentMethod ?? true });
    } catch (err) {
      req.log.warn({ err }, 'payment-method confirm failed');
      return reply.code(502).send({ error: 'stripe_error', message: 'Could not confirm your card.' });
    }
  });

  // ---------------------------------------------------------------------
  // POST /v2/billing/seats — the client edited their people list. Settle
  // the balance at the old rate, then store the new seat count; the
  // cover end date moves with no charge.
  // body: { seats }
  // ---------------------------------------------------------------------
  app.post('/v2/billing/seats', { preHandler: requireJwt }, async (req, reply) => {
    const parsed = SeatsBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { seats } = parsed.data;

    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    // Seat changes are billed by Stripe (proration on the subscription),
    // so this just records the seat count for the rate display.
    const [updated] = await db
      .update(clients)
      .set({ billingSeats: seats })
      .where(eq(clients.id, client.id))
      .returning();
    if (!updated) {
      return reply.code(409).send({ error: 'client_missing' });
    }
    emitBillingEvent(req.log, {
      event: 'billing.seats.updated',
      clientId: client.id,
      inboxId: client.inboxId,
      context: { previousSeats: client.billingSeats, newSeats: seats },
    });
    return reply.code(200).send(billingStatus(updated));
  });

  // ---------------------------------------------------------------------
  // POST /v2/billing/report-day — set the monthly report delivery date.
  // body: { reportDay: '1st' | '14th' }
  // ---------------------------------------------------------------------
  const ReportDayBody = z.object({
    reportDay: z.enum(['1st', '14th']),
  });

  app.post('/v2/billing/report-day', { preHandler: requireJwt }, async (req, reply) => {
    const parsed = ReportDayBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }

    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    const [updated] = await db
      .update(clients)
      .set({ reportDay: parsed.data.reportDay })
      .where(eq(clients.id, client.id))
      .returning();
    if (!updated) {
      return reply.code(409).send({ error: 'client_missing' });
    }
    return reply.code(200).send(billingStatus(updated));
  });

  // ---------------------------------------------------------------------
  // POST /v2/billing/coverage — enable or disable coverage.
  // body: { enabled: boolean }
  // Disabling is blocked within 3 days of the 1st (day 29, 30, 31, 1).
  // ---------------------------------------------------------------------
  const CoverageBody = z.object({ enabled: z.boolean() });

  app.post('/v2/billing/coverage', { preHandler: requireJwt }, async (req, reply) => {
    const parsed = CoverageBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }

    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    if (!parsed.data.enabled) {
      const now = new Date();
      const dayOfMonth: number = now.getUTCDate();
      const daysInMonth: number = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const daysUntilNextFirst: number = daysInMonth - dayOfMonth + 1;
      if (daysUntilNextFirst <= 3 && dayOfMonth !== 1) {
        return reply.code(409).send({
          error: 'too_close_to_delivery',
          message: 'Coverage cannot be disabled within 3 days of the 1st.',
        });
      }
    }

    const [updated] = await db
      .update(clients)
      .set({ coverageEnabled: parsed.data.enabled })
      .where(eq(clients.id, client.id))
      .returning();
    if (!updated) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    emitBillingEvent(req.log, {
      event: 'billing.coverage.toggled',
      clientId: client.id,
      inboxId: client.inboxId,
      context: { enabled: parsed.data.enabled },
    });

    return reply.code(200).send(billingStatus(updated));
  });

  // ---------------------------------------------------------------------
  // POST /v2/billing/person-toggle — enable or disable a specific person.
  // body: { personId: string, displayName: string, enabled: boolean }
  //
  // Enabling a person deducts the initial monthly fee from the client's
  // balance and queues a sample report. Disabling removes them from the
  // active report delivery list.
  // ---------------------------------------------------------------------
  const PersonToggleBody = z.object({
    personId: z.string().uuid(),
    displayName: z.string(),
    enabled: z.boolean(),
  });

  app.post('/v2/billing/person-toggle', { preHandler: requireJwt }, async (req, reply) => {
    const parsed = PersonToggleBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }

    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    try {
      const result = await togglePersonCoverage({
        clientId: client.id,
        personId: parsed.data.personId,
        displayName: parsed.data.displayName,
        enabled: parsed.data.enabled,
      });

      if (result.needsInitialReport && result.activated) {
        queueSampleReport(
          client.id,
          client.clientNumber,
          parsed.data.personId,
          parsed.data.displayName,
        ).catch((err) => req.log.error({ err }, 'failed to queue sample report'));
      }

      if (result.deductedCents > 0) {
        emitBillingEvent(req.log, {
          event: 'billing.balance.settled',
          clientId: client.id,
          inboxId: client.inboxId,
          context: {
            reason: 'person_activation',
            personId: parsed.data.personId,
            deductedCents: result.deductedCents,
          },
        });
      }

      // Re-fetch client to get the updated balance.
      const [refreshed] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, client.id))
        .limit(1);

      return reply.code(200).send({
        ...billingStatus(refreshed ?? client),
        activated: result.activated,
        deductedCents: result.deductedCents,
      });
    } catch (err: unknown) {
      const message: string = err instanceof Error ? err.message : 'unknown_error';
      if (message === 'no_payment_method') {
        return reply.code(402).send({ error: 'no_payment_method', message: 'Add a payment method before enabling people.' });
      }
      if (message === 'seat_price_not_configured') {
        return reply.code(503).send({ error: 'billing_unavailable', message: 'Billing is not fully configured on this server.' });
      }
      if (message === 'insufficient_balance') {
        return reply.code(402).send({ error: 'insufficient_balance', message: 'Not enough balance to activate this person.' });
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------
  // POST /v2/billing/cancel — stop cover and refund unused future months.
  //
  // The current month is treated as an immediate cost — third-party
  // services are triggered the moment coverage starts, so that month
  // is non-refundable. Only complete future months are returned.
  // Refunds run newest-checkout-first so the charges touched are as
  // recent as possible (within Stripe's refund window).
  // returns: { refundedCents, retainedCents }
  // ---------------------------------------------------------------------
  app.post('/v2/billing/cancel', { preHandler: requireJwt }, async (req, reply) => {
    if (!isStripeConfigured()) {
      return reply.code(503).send({ error: 'billing_unavailable', message: 'Stripe is not configured on this server.' });
    }
    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    // Stop the subscription at the end of the current paid period. The
    // current period and the $100 initial fees are non-refundable; future
    // periods are simply not billed. No cash refund in this model.
    try {
      await cancelAtPeriodEnd(client);
    } catch (err) {
      req.log.warn({ err }, 'subscription cancel failed');
      return reply.code(502).send({ error: 'stripe_error', message: 'Could not cancel your subscription. Please try again.' });
    }

    await db
      .update(clients)
      .set({ coverageEnabled: false })
      .where(eq(clients.id, client.id));

    emitBillingEvent(req.log, {
      event: 'billing.balance.zeroed',
      clientId: client.id,
      inboxId: client.inboxId,
      context: { reason: 'subscription_cancelled' },
    });

    return reply.code(200).send({ refundedCents: 0 });
  });

  // ---------------------------------------------------------------------
  // GET /v2/billing/return  — Stripe redirects the browser here on success.
  // GET /v2/billing/cancel  — …and here when the user backs out.
  // ---------------------------------------------------------------------
  // The browser lands here after Stripe checkout. Reconcile the payment
  // immediately so the balance is credited even if the webhook hasn't
  // arrived yet (common in local dev, and a reliable fallback in prod).
  app.get('/v2/billing/return', async (req, reply) => {
    const sessionId = (req.query as Record<string, string>).session_id;
    if (sessionId && isStripeConfigured()) {
      try {
        await reconcileCheckoutSession(sessionId, req.log);
      } catch (err) {
        req.log.warn({ err }, 'return-page reconcile failed — webhook will retry');
      }
    }
    return reply.type('text/html').send(landingPage('Payment received', 'Your coverage is being added. You can close this page and return to Goldilocks.'));
  });

  app.get('/v2/billing/cancel', async (_req, reply) => {
    return reply.type('text/html').send(landingPage('Checkout cancelled', 'No charge was made. You can close this page and return to Goldilocks.'));
  });

  // Authenticated endpoint for iOS to poll after checkout. Reconciles the
  // session with Stripe (idempotent), then returns the updated billing
  // status so the app can update in one call.
  app.get<{ Params: { sessionId: string } }>(
    '/v2/billing/checkout-status/:sessionId',
    { preHandler: requireJwt },
    async (req, reply) => {
      const client = await resolveClient(req.deviceId!);
      if (!client) {
        return reply.code(409).send({ error: 'client_missing' });
      }
      if (!isStripeConfigured()) {
        return reply.code(503).send({ error: 'billing_unavailable' });
      }
      try {
        await reconcileCheckoutSession(req.params.sessionId, req.log);
      } catch (err) {
        req.log.warn({ err }, 'checkout-status reconcile failed');
      }
      const updated = await resolveClient(req.deviceId!);
      return reply.code(200).send(billingStatus(updated ?? client));
    },
  );
}

type ClientRow = typeof clients.$inferSelect;

async function resolveClient(deviceId: string): Promise<ClientRow | null> {
  const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
  if (!device?.inboxId) return null;
  const [client] = await db.select().from(clients).where(eq(clients.inboxId, device.inboxId)).limit(1);
  return client ?? null;
}

function billingStatus(client: ClientRow): {
  activeUntil: string | null;
  coverageActive: boolean;
  coverageEnabled: boolean;
  balanceCents: number;
  referralCreditCents: number;
  monthlyRateCents: number;
  seats: number;
  coveredPeople: number;
  reportDay: string;
  hasPaymentMethod: boolean;
} {
  const until = activeUntil(client);
  return {
    activeUntil: until ? until.toISOString() : null,
    coverageActive: isCoverageActive(client),
    coverageEnabled: client.coverageEnabled,
    balanceCents: liveBalanceCents(client),
    referralCreditCents: client.referralCreditCents,
    monthlyRateCents: monthlyRateCents(client),
    seats: client.billingSeats,
    coveredPeople: client.coveredPeople,
    reportDay: client.reportDay,
    hasPaymentMethod: client.hasPaymentMethod,
  };
}

function successUrl(publicBaseUrl: string): string {
  const base = config.STRIPE_SUCCESS_URL ?? `${publicBaseUrl}/api/v2/billing/return`;
  if (base.includes('{CHECKOUT_SESSION_ID}')) return base;
  return `${base}${base.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`;
}

function cancelUrl(publicBaseUrl: string): string {
  return config.STRIPE_CANCEL_URL ?? `${publicBaseUrl}/api/v2/billing/cancel`;
}

function landingPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #f5f5f7;
         color: #1d1d1f; display: flex; min-height: 100vh; margin: 0;
         align-items: center; justify-content: center; }
  .card { background: #fff; padding: 40px; border-radius: 16px; max-width: 360px;
          text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,0.08); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.5; color: #6e6e73; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
}
