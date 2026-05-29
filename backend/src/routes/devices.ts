import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { sql } from 'drizzle-orm';

const Body = z.object({
  deviceId: z.string().min(1).max(256),
  pushToken: z.string().nullable().optional(),
  pushTokenType: z.enum(['apns', 'fcm']).nullable().optional(),
  apnsEnv: z.enum(['sandbox', 'production']).nullable().optional(),
});

export default async function deviceRoutes(app: FastifyInstance) {
  // POST /v2/device/register
  // Called BEFORE the iOS client has a JWT, so this endpoint is unauthenticated.
  // Add device attestation here if needed (e.g. Apple DeviceCheck).
  app.post('/v2/device/register', {
    config: {
      // Unauthenticated — key per IP. Device registration is a one-shot
      // per install; 5/min/IP comfortably covers normal retries while
      // throttling automated enrolment from a single source.
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { deviceId, pushToken, pushTokenType, apnsEnv } = parsed.data;

    await db
      .insert(devices)
      .values({
        deviceId,
        pushToken: pushToken ?? null,
        pushTokenType: pushTokenType ?? null,
        apnsEnv: apnsEnv ?? null,
      })
      .onConflictDoUpdate({
        target: devices.deviceId,
        set: {
          pushToken: pushToken ?? null,
          pushTokenType: pushTokenType ?? null,
          apnsEnv: apnsEnv ?? null,
          updatedAt: sql`now()`,
        },
      });

    return reply.code(200).send({});
  });
}
