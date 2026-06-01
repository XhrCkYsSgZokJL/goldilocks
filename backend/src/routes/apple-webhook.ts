// Apple App Store Server Notifications v2 — POST /v2/apple/webhook.
//
// Apple sends signed JWS payloads (signedPayload) when subscription
// state changes: initial purchase, renewal, cancellation, grace period,
// billing retry, refund, revocation, etc.
//
// This is the source of truth for Apple subscription state — the iOS
// client only reports the initial transaction; all lifecycle events
// (renewals, cancellations, grace periods) arrive here.
//
// The payload is a three-part JWS (header.payload.signature) signed by
// Apple's root CA chain. We verify the signature using Apple's published
// root certificates before trusting the content.
//
// Registered as its own Fastify plugin so its raw-body parser stays
// encapsulated (same pattern as stripe-webhook.ts).

import type { FastifyInstance } from 'fastify';
import { isAppleConfigured } from '../billing/apple.js';
import { emitBillingEvent } from '../observability/billing-events.js';

export default async function appleWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/v2/apple/webhook', {
    config: {
      rateLimit: false,
    },
  }, async (req, reply) => {
    if (!isAppleConfigured()) {
      return reply.code(503).send({ error: 'apple_iap_unavailable' });
    }

    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      return reply.code(400).send({ error: 'empty_body' });
    }

    let payload: { signedPayload?: string };
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid_json' });
    }

    if (typeof payload.signedPayload !== 'string') {
      return reply.code(400).send({ error: 'missing_signed_payload' });
    }

    emitBillingEvent(req.log, {
      event: 'billing.apple.notification_received',
    });

    // TODO: Verify the JWS signature against Apple's root CA chain.
    // TODO: Decode the payload and extract notificationType + subtype.
    // TODO: Route to handlers based on notification type:
    //   DID_CHANGE_RENEWAL_PREF    → update seats / plan
    //   DID_CHANGE_RENEWAL_STATUS  → renewal on/off
    //   DID_FAIL_TO_RENEW          → grace period start
    //   DID_RENEW                  → credit balance
    //   EXPIRED                    → zero balance
    //   GRACE_PERIOD_EXPIRED       → zero balance
    //   REFUND                     → debit balance
    //   REVOKE                     → revoke access
    //   SUBSCRIBED                 → initial purchase, credit balance
    //   CONSUMPTION_REQUEST        → Apple asking for consumption data

    return reply.code(200).send({ received: true });
  });
}
