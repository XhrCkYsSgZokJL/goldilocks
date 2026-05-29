import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueToken } from '../auth/jwt.js';
import { issueNewFamily, revokeFamilyByToken, rotateRefreshToken } from '../auth/refresh-tokens.js';
import { db } from '../db/client.js';
import { devices, sessions } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

const TokenBody = z.object({ deviceId: z.string().min(1).max(256) });
const RefreshBody = z.object({ refreshToken: z.string().min(1).max(256) });

export default async function authRoutes(app: FastifyInstance) {
  // POST /v2/auth/token
  // Unauthenticated: the device proves identity inside the JWT lifecycle
  // (later /v2/me + SIWE binds the JWT to an inbox). Abuse on this surface
  // is bounded by the per-route rate limit configured in src/server.ts.
  // Goldilocks does not use Firebase App Check — the iOS client used to
  // send an X-Firebase-AppCheck header, but it's now removed.
  app.post('/v2/auth/token', {
    config: {
      // Unauthenticated — key per IP. Tight enough that a single attacker
      // can't waste the global 120/min budget on this endpoint, loose
      // enough for a normal app cold-start (auth → me → channels).
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = TokenBody.safeParse(req.body);
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

    // Pull the inbox_id (if the device has registered before) so we
    // can attach it to the refresh-token family.
    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    const refresh = await issueNewFamily(deviceId, device?.inboxId ?? null);

    return reply.code(200).send({
      token,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt.toISOString(),
    });
  });

  // POST /v2/auth/refresh
  // Exchange a refresh token for a new access + refresh pair. Replay
  // of a consumed refresh token revokes the entire family (theft
  // detection — RFC 6819 §5.2.2.3).
  app.post('/v2/auth/refresh', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = RefreshBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const result = await rotateRefreshToken(parsed.data.refreshToken);
    switch (result.kind) {
      case 'invalid':
        return reply.code(401).send({ error: 'invalid_refresh_token' });
      case 'expired':
        return reply.code(401).send({ error: 'refresh_token_expired' });
      case 'reused':
        req.log.warn({ familyId: result.familyId }, 'refresh token reused — family revoked');
        return reply.code(401).send({ error: 'refresh_token_reused' });
      case 'rotated': {
        const { token, jti, expiresAt } = issueToken(result.deviceId);
        await db.insert(sessions).values({ jti, deviceId: result.deviceId, expiresAt });
        return reply.code(200).send({
          token,
          refreshToken: result.refresh.token,
          refreshExpiresAt: result.refresh.expiresAt.toISOString(),
        });
      }
    }
  });

  // POST /v2/auth/logout
  // Revoke the supplied refresh-token's whole family. Idempotent —
  // unknown tokens return 204 rather than leak existence.
  app.post('/v2/auth/logout', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = RefreshBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    await revokeFamilyByToken(parsed.data.refreshToken);
    return reply.code(204).send();
  });
}
