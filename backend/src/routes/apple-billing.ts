// Apple In-App Purchase billing routes.
//
//   POST /v2/billing/apple/verify    — iOS sends a signed transaction after
//                                      a StoreKit 2 purchase. We verify it
//                                      with Apple's servers, credit the
//                                      balance, and persist the subscription.
//   GET  /v2/billing/apple/status    — subscription state for this client.
//
// These routes complement the existing /v2/billing/* Stripe routes. The
// same prepaid-balance model applies: Apple purchases credit the balance
// just like a Stripe checkout does.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, devices } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { isAppleConfigured, getAppleConfig } from '../billing/apple.js';
import { emitBillingEvent } from '../observability/billing-events.js';

const VerifyBody = z.object({
  signedTransaction: z.string().min(1),
});

export default async function appleBillingRoutes(app: FastifyInstance) {
  // -----------------------------------------------------------------------
  // POST /v2/billing/apple/verify
  //
  // The iOS client sends the JWS-signed transaction string it received
  // from StoreKit 2 after a successful purchase. We:
  //   1. Verify the JWS against Apple's root CA
  //   2. Decode the transaction to extract product, quantity, expiration
  //   3. Call the App Store Server API to confirm the transaction status
  //   4. Credit the client's prepaid balance
  //   5. Store the subscription record for renewal tracking
  //
  // body: { signedTransaction: "<JWS string>" }
  // returns: { status, expiresDate, productId }
  // -----------------------------------------------------------------------
  app.post('/v2/billing/apple/verify', { preHandler: requireJwt }, async (req, reply) => {
    if (!isAppleConfigured()) {
      return reply.code(503).send({
        error: 'apple_iap_unavailable',
        message: 'Apple In-App Purchase is not configured on this server.',
      });
    }

    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }

    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    const _appleConfig = getAppleConfig();

    emitBillingEvent(req.log, {
      event: 'billing.apple.purchase',
      clientId: client.id,
      inboxId: client.inboxId,
      context: { environment: _appleConfig.environment },
    });

    // TODO: Verify the signed transaction JWS
    // TODO: Decode transaction payload (originalTransactionId, productId,
    //       expiresDate, quantity, environment)
    // TODO: Check transaction hasn't already been processed (idempotency)
    // TODO: Map productId to duration/seats and credit balance
    // TODO: Store subscription record for webhook renewal tracking

    return reply.code(501).send({
      error: 'not_yet_implemented',
      message: 'Apple IAP verification is scaffolded but not yet complete. Install @apple/app-store-server-library and implement JWS verification.',
    });
  });

  // -----------------------------------------------------------------------
  // GET /v2/billing/apple/status
  //
  // Returns the current Apple subscription state for this client.
  // -----------------------------------------------------------------------
  app.get('/v2/billing/apple/status', { preHandler: requireJwt }, async (req, reply) => {
    if (!isAppleConfigured()) {
      return reply.code(503).send({ error: 'apple_iap_unavailable' });
    }

    const client = await resolveClient(req.deviceId!);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    // TODO: Query stored Apple subscription records for this client
    // TODO: Return subscription state (active, expired, grace period, etc.)

    return reply.code(200).send({
      configured: true,
      subscription: null,
    });
  });
}

type ClientRow = typeof clients.$inferSelect;

async function resolveClient(deviceId: string): Promise<ClientRow | null> {
  const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
  if (!device?.inboxId) return null;
  const [client] = await db.select().from(clients).where(eq(clients.inboxId, device.inboxId)).limit(1);
  return client ?? null;
}
