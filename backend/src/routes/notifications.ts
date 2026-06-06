import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, installations, subscriptions } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { sql } from 'drizzle-orm';
import { emitOpsEvent } from '../observability/ops-events.js';

const HmacKey = z.object({
  thirtyDayPeriodsSinceEpoch: z.number().int(),
  key: z.string(),
});

const TopicSubscription = z.object({
  topic: z.string().min(1),
  hmacKeys: z.array(HmacKey).default([]),
});

const SubscribeBody = z.object({
  deviceId: z.string().min(1),
  clientId: z.string().min(1),
  topics: z.array(TopicSubscription).max(500),
});

const UnsubscribeBody = z.object({
  clientId: z.string().min(1),
  topics: z.array(z.string()).max(500),
});

export default async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireJwt);

  // POST /v2/notifications/subscribe
  app.post('/v2/notifications/subscribe', async (req, reply) => {
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { deviceId, clientId, topics } = parsed.data;

    // Make sure device exists (registers via /v2/device/register before this).
    const [dev] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (!dev) {
      return reply.code(404).send({ error: 'device_not_found' });
    }

    await db
      .insert(installations)
      .values({ clientId, deviceId })
      .onConflictDoNothing();

    if (topics.length > 0) {
      await db
        .insert(subscriptions)
        .values(topics.map((t) => ({ clientId, topic: t.topic, hmacKeys: t.hmacKeys })))
        .onConflictDoUpdate({
          target: [subscriptions.clientId, subscriptions.topic],
          set: { hmacKeys: sql`excluded.hmac_keys` },
        });
    }

    emitOpsEvent(req.log, {
      event: 'notification.subscribed',
      deviceId,
      context: { topicCount: topics.length },
    });

    return reply.code(200).send({});
  });

  // POST /v2/notifications/unsubscribe
  app.post('/v2/notifications/unsubscribe', async (req, reply) => {
    const parsed = UnsubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { clientId, topics } = parsed.data;

    if (topics.length === 0) {
      return reply.code(200).send({});
    }

    await db
      .delete(subscriptions)
      .where(and(eq(subscriptions.clientId, clientId), inArray(subscriptions.topic, topics)));

    emitOpsEvent(req.log, {
      event: 'notification.unsubscribed',
      context: { topicCount: topics.length },
    });

    return reply.code(200).send({});
  });

  // DELETE /v2/notifications/unregister/:clientId
  app.delete<{ Params: { clientId: string } }>(
    '/v2/notifications/unregister/:clientId',
    async (req, reply) => {
      const { clientId } = req.params;
      if (!clientId) {
        return reply.code(400).send({ error: 'missing_client_id' });
      }
      // Cascading FK removes subscriptions automatically.
      await db.delete(installations).where(eq(installations.clientId, clientId));
      emitOpsEvent(req.log, {
        event: 'notification.unregistered',
        clientId,
      });
      return reply.code(200).send({});
    },
  );
}
