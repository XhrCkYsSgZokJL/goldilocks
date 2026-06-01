// Prepaid-balance billing.
//
// POST /v2/billing/checkout  — top up: buy 1/3/6 months of cover; returns
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
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { billingCheckouts, clients, devices } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { getStripe, isStripeConfigured } from '../billing/stripe.js';
import { isAllowedDuration, monthlyTotalCents } from '../billing/pricing.js';
import { activeUntil, isCoverageActive, liveBalanceCents, monthlyRateCents, settle } from '../billing/balance.js';
import { reconcileCheckoutSession } from '../billing/reconcile-checkout.js';
import { togglePersonCoverage } from '../billing/person-activation.js';
import { queueSampleReport } from '../billing/sample-report.js';
import { emitBillingEvent } from '../observability/billing-events.js';
import type Stripe from 'stripe';

const CheckoutBody = z.object({
  // 'card' routes to Stripe. 'crypto' is reserved — no provider yet.
  paymentMethod: z.enum(['card', 'crypto']),
  // Months of cover to buy: 1, 3 or 6.
  durationMonths: z.number().int(),
  seats: z.number().int().min(0).max(999),
});

const SeatsBody = z.object({
  seats: z.number().int().min(0).max(999),
});

export default async function billingRoutes(app: FastifyInstance, opts: { publicBaseUrl: string }) {
  const { publicBaseUrl } = opts;

  // ---------------------------------------------------------------------
  // POST /v2/billing/checkout — buy a block of cover (a balance top-up).
  // body: { paymentMethod, durationMonths, seats }
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
    const { paymentMethod, durationMonths, seats } = parsed.data;

    if (paymentMethod === 'crypto') {
      return reply.code(501).send({
        error: 'crypto_not_available',
        message: 'Crypto payments are coming soon. Please pay by card for now.',
      });
    }
    if (!isAllowedDuration(durationMonths)) {
      return reply.code(400).send({ error: 'invalid_duration', message: 'durationMonths must be 1, 3 or 6.' });
    }
    if (seats < 1) {
      return reply.code(400).send({ error: 'no_seats', message: 'Add at least one person before buying cover.' });
    }

    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    const stripe = getStripe();
    const amountCents = monthlyTotalCents(seats) * durationMonths;

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
      durationMonths: String(durationMonths),
      seats: String(seats),
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
                name: `Goldilocks cover — ${durationMonths} month${durationMonths === 1 ? '' : 's'}`,
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
        context: { error: (err as Error).message, paymentMethod, durationMonths, seats },
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
      durationMonths,
      seats,
      amountCents,
      currency: 'usd',
      status: 'pending',
    });

    emitBillingEvent(req.log, {
      event: 'billing.checkout.initiated',
      clientId: client.id,
      inboxId: client.inboxId,
      context: { paymentMethod, durationMonths, seats, amountCents },
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

    // Settle at the current (old) rate, then switch to the new seat count.
    const settled = settle(client);
    const [updated] = await db
      .update(clients)
      .set({
        billingBalanceCents: settled.balanceCents,
        billingBalanceAsOf: settled.asOf,
        billingSeats: seats,
      })
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

    const settled = settle(client);
    let refundedTotal = 0;
    const rate = monthlyRateCents(client);

    // The current month is non-refundable — services are already being
    // consumed. Subtract one month's rate from the settled balance so
    // only future unused months are in the refund budget.
    const retainedCents: number = Math.min(rate, settled.balanceCents);
    const refundBudget: number = Math.max(0, settled.balanceCents - rate);

    if (refundBudget > 0) {
      const stripe = getStripe();
      const refundable = await db
        .select()
        .from(billingCheckouts)
        .where(and(
          eq(billingCheckouts.clientId, client.id),
          eq(billingCheckouts.status, 'completed'),
          isNotNull(billingCheckouts.stripePaymentIntentId),
        ))
        .orderBy(desc(billingCheckouts.createdAt));

      let proRataBudget = refundBudget;

      for (const checkout of refundable) {
        const remaining = checkout.amountCents - checkout.refundedCents;
        if (remaining <= 0) continue;
        if (proRataBudget <= 0) break;

        const amount = Math.min(remaining, proRataBudget);

        try {
          await stripe.refunds.create({
            payment_intent: checkout.stripePaymentIntentId as string,
            amount,
          });
          emitBillingEvent(req.log, {
            event: 'billing.refund.completed',
            clientId: client.id,
            inboxId: client.inboxId,
            context: { amountCents: amount },
          });
        } catch (err) {
          emitBillingEvent(req.log, {
            event: 'billing.refund.failed',
            severity: 'error',
            clientId: client.id,
            inboxId: client.inboxId,
            context: { amountCents: amount, error: (err as Error).message },
          });
          continue;
        }
        await db
          .update(billingCheckouts)
          .set({ refundedCents: checkout.refundedCents + amount })
          .where(eq(billingCheckouts.id, checkout.id));
        refundedTotal += amount;
        proRataBudget = Math.max(0, proRataBudget - amount);
      }
    }

    // Zero the balance whether or not every cent could be refunded —
    // cover has ended either way.
    await db
      .update(clients)
      .set({ billingBalanceCents: 0, billingBalanceAsOf: settled.asOf })
      .where(eq(clients.id, client.id));

    emitBillingEvent(req.log, {
      event: 'billing.balance.zeroed',
      clientId: client.id,
      inboxId: client.inboxId,
      context: { refundedCents: refundedTotal, retainedCents, previousBalanceCents: settled.balanceCents },
    });

    return reply.code(200).send({ refundedCents: refundedTotal, retainedCents });
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
  monthlyRateCents: number;
  seats: number;
  coveredPeople: number;
  reportDay: string;
} {
  const until = activeUntil(client);
  return {
    activeUntil: until ? until.toISOString() : null,
    coverageActive: isCoverageActive(client),
    coverageEnabled: client.coverageEnabled,
    balanceCents: liveBalanceCents(client),
    monthlyRateCents: monthlyRateCents(client),
    seats: client.billingSeats,
    coveredPeople: client.coveredPeople,
    reportDay: client.reportDay,
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
