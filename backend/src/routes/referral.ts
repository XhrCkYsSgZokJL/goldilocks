// Referral system.
//
// GET  /v2/me/referral  — returns (or generates) the caller's referral code + URL.
// POST /v2/me/referral  — record that the caller was referred by a code.
// GET  /r/:code         — public landing page for referral links (registered
//                          at the app root, outside /api, so the URL is clean).

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { db } from '../db/client.js';
import { clients, devices, referrals } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ module: 'referral' });

function generateCode(): string {
  return randomBytes(4).toString('base64url');
}

function referralDomain(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    || 'goldilocksdigital.xyz';
}

export default async function referralApiRoutes(
  app: FastifyInstance,
  opts: { publicBaseUrl: string },
) {
  const { publicBaseUrl } = opts;

  app.get('/v2/me/referral', { preHandler: requireJwt }, async (req, reply) => {
    const deviceId = req.deviceId!;
    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (!device?.inboxId) {
      return reply.code(409).send({ error: 'device_not_registered' });
    }
    const [client] = await db.select().from(clients).where(eq(clients.inboxId, device.inboxId)).limit(1);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    let code = client.referralCode;
    if (!code) {
      code = generateCode();
      await db.update(clients).set({ referralCode: code }).where(eq(clients.id, client.id));
      log.info({ clientId: client.id, code }, 'generated referral code');
    }

    const domain = referralDomain(publicBaseUrl);
    const referralUrl = `https://${domain}/r/${code}`;

    return reply.code(200).send({ code, referralUrl });
  });

  const ClaimBody = z.object({
    referralCode: z.string().min(1),
  });

  app.post('/v2/me/referral', { preHandler: requireJwt }, async (req, reply) => {
    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const { referralCode } = parsed.data;

    const deviceId = req.deviceId!;
    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (!device?.inboxId) {
      return reply.code(409).send({ error: 'device_not_registered' });
    }
    const [referred] = await db.select().from(clients).where(eq(clients.inboxId, device.inboxId)).limit(1);
    if (!referred) {
      return reply.code(409).send({ error: 'client_missing' });
    }

    const [referrer] = await db.select().from(clients).where(eq(clients.referralCode, referralCode)).limit(1);
    if (!referrer) {
      return reply.code(404).send({ error: 'invalid_code' });
    }
    if (referrer.id === referred.id) {
      return reply.code(400).send({ error: 'self_referral' });
    }

    try {
      await db.insert(referrals).values({
        referrerClientId: referrer.id,
        referredClientId: referred.id,
      }).onConflictDoNothing();
      log.info({ referrerId: referrer.id, referredId: referred.id }, 'referral recorded');
    } catch (err) {
      log.warn({ err }, 'referral insert failed (likely duplicate)');
    }

    return reply.code(200).send({ ok: true });
  });
}

export async function referralLandingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { code: string } }>('/r/:code', async (req, reply) => {
    const { code } = req.params;
    const [referrer] = await db.select().from(clients).where(eq(clients.referralCode, code)).limit(1);

    const brandName = 'Goldilocks Digital';
    const valid = !!referrer;

    return reply.type('text/html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${brandName}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 60px 20px; background: #0A0A0A; color: #EBEBEB; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #CAA452; }
  p { color: #999; margin-top: 0.5rem; }
  a { color: #CAA452; text-decoration: none; }
</style>
</head>
<body>
  <h1>${brandName}</h1>
  ${valid
    ? `<p>You've been invited to join ${brandName}.</p><p>Download the app to get started.</p>`
    : `<p>This referral link is not valid.</p>`}
</body>
</html>`);
  });
}
