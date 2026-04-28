import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueToken } from '../auth/jwt.js';
import { db } from '../db/client.js';
import { devices, sessions } from '../db/schema.js';
import { sql } from 'drizzle-orm';

const Body = z.object({ deviceId: z.string().min(1).max(256) });

export default async function authRoutes(app: FastifyInstance) {
  // POST /v2/auth/token
  // The iOS client sends an X-Firebase-AppCheck header here. We don't verify
  // it — Goldilocks doesn't use App Check. Leaving the header in place is
  // harmless. If you want to add device attestation later, do it here.
  app.post('/v2/auth/token', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { deviceId } = parsed.data;

    // Upsert the device row so we have a referent for the session FK.
    await db
      .insert(devices)
      .values({ deviceId })
      .onConflictDoUpdate({
        target: devices.deviceId,
        set: { updatedAt: sql`now()` },
      });

    const { token, jti, expiresAt } = issueToken(deviceId);
    await db.insert(sessions).values({ jti, deviceId, expiresAt });

    return reply.code(200).send({ token });
  });
}
