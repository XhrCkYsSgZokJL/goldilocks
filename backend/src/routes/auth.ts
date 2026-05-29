import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueToken } from '../auth/jwt.js';
import { issueNewFamily, revokeFamilyByToken, rotateRefreshToken } from '../auth/refresh-tokens.js';
import { db } from '../db/client.js';
import { devices, sessions } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { emitSecurityEvent } from '../observability/security-events.js';

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

    emitSecurityEvent(req.log, {
      event: 'auth.token.issued',
      deviceId,
      inboxId: device?.inboxId ?? null,
      familyId: refresh.familyId,
      ip: req.ip,
      context: { jti: jti.slice(0, 8) + '…' },
    });

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
        emitSecurityEvent(req.log, {
          event: 'auth.refresh.invalid',
          ip: req.ip,
          severity: 'warn',
        });
        return reply.code(401).send({ error: 'invalid_refresh_token' });
      case 'expired':
        emitSecurityEvent(req.log, {
          event: 'auth.refresh.expired',
          ip: req.ip,
        });
        return reply.code(401).send({ error: 'refresh_token_expired' });
      case 'reused':
        // Critical: someone is replaying an already-consumed refresh
        // token. Either a buggy client (unlikely with single-flight) or
        // the legitimate user's token was stolen and is racing against
        // the client. Family is already nuked at this point.
        emitSecurityEvent(req.log, {
          event: 'auth.refresh.reused_family_revoked',
          familyId: result.familyId,
          ip: req.ip,
          severity: 'critical',
        });
        return reply.code(401).send({ error: 'refresh_token_reused' });
      case 'rotated': {
        const { token, jti, expiresAt } = issueToken(result.deviceId);
        await db.insert(sessions).values({ jti, deviceId: result.deviceId, expiresAt });
        emitSecurityEvent(req.log, {
          event: 'auth.token.refreshed',
          deviceId: result.deviceId,
          inboxId: result.inboxId,
          familyId: result.refresh.familyId,
          ip: req.ip,
          context: { jti: jti.slice(0, 8) + '…' },
        });
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
    const revoked = await revokeFamilyByToken(parsed.data.refreshToken);
    emitSecurityEvent(req.log, {
      event: 'auth.logout',
      ip: req.ip,
      context: { revoked },
    });
    return reply.code(204).send();
  });
}
