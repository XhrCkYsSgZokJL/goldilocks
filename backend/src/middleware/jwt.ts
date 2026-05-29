import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../auth/jwt.js';
import { db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { emitSecurityEvent } from '../observability/security-events.js';

declare module 'fastify' {
  interface FastifyRequest {
    deviceId?: string;
    jti?: string;
  }
}

export async function requireJwt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = req.headers.authorization;
  // The iOS client uses a custom header `X-Convos-AuthToken` for JWT.
  // We accept either Bearer or that header for compatibility.
  const headerToken = req.headers['x-convos-authtoken'];
  const token = (typeof headerToken === 'string' && headerToken)
    || (auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '');

  if (!token) {
    return reply.code(401).send({ error: 'missing_token' });
  }

  let claims;
  try {
    claims = verifyToken(token);
  } catch {
    return reply.code(401).send({ error: 'invalid_token' });
  }

  // Cheap revocation check — only blocks if explicitly revoked.
  // Skip the lookup if you don't need revocation in dev.
  const [row] = await db.select().from(sessions).where(eq(sessions.jti, claims.jti)).limit(1);
  if (row?.revoked) {
    emitSecurityEvent(req.log, {
      event: 'auth.jwt.revoked_token_used',
      deviceId: claims.sub,
      ip: req.ip,
      severity: 'warn',
      context: { jti: claims.jti.slice(0, 8) + '…' },
    });
    return reply.code(401).send({ error: 'token_revoked' });
  }

  req.deviceId = claims.sub;
  req.jti = claims.jti;
}
