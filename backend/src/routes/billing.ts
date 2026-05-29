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
import { activeUntil, liveBalanceCents, monthlyRateCents, settle } from '../billing/balance.js';
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
      req.log.error({ err }, 'stripe checkout session create failed');
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
    return reply.code(200).send(billingStatus(updated));
  });

  // ---------------------------------------------------------------------
  // POST /v2/billing/cancel — stop cover and refund the unused balance.
  //
  // Coverage starts the moment a person is verified onto the plan, so
  // every top-up is pro-rata only — there's no buyer's-remorse window.
  // Refunds run newest-checkout-first against the live (settled)
  // balance, so the charges touched are as recent as possible (well
  // within Stripe's refund window).
  // returns: { refundedCents }
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

    if (settled.balanceCents > 0) {
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

      // Pro-rata budget: the unused balance still owed back, split
      // across the refundable checkouts newest-first.
      let proRataBudget = settled.balanceCents;

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
        } catch (err) {
          req.log.error({ err, checkoutId: checkout.id }, 'stripe refund failed');
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

    return reply.code(200).send({ refundedCents: refundedTotal });
  });

  // ---------------------------------------------------------------------
  // GET /v2/billing/return  — Stripe redirects the browser here on success.
  // GET /v2/billing/cancel  — …and here when the user backs out.
  // ---------------------------------------------------------------------
  app.get('/v2/billing/return', async (_req, reply) => {
    return reply.type('text/html').send(landingPage('Payment received', 'Your cover is being added. You can close this page and return to Goldilocks.'));
  });

  app.get('/v2/billing/cancel', async (_req, reply) => {
    return reply.type('text/html').send(landingPage('Checkout cancelled', 'No charge was made. You can close this page and return to Goldilocks.'));
  });
}

type ClientRow = typeof clients.$inferSelect;

async function resolveClient(deviceId: string): Promise<ClientRow | null> {
  const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
  if (!device?.inboxId) return null;
  const [client] = await db.select().from(clients).where(eq(clients.inboxId, device.inboxId)).limit(1);
  return client ?? null;
}

// The /v2/billing/status response body, computed from a client row.
function billingStatus(client: ClientRow): {
  activeUntil: string | null;
  balanceCents: number;
  monthlyRateCents: number;
  seats: number;
} {
  const until = activeUntil(client);
  return {
    activeUntil: until ? until.toISOString() : null,
    balanceCents: liveBalanceCents(client),
    monthlyRateCents: monthlyRateCents(client),
    seats: client.billingSeats,
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
