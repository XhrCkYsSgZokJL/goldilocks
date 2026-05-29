// Rate-limit key helpers.
//
// `@fastify/rate-limit` runs its keyGenerator at the `onRequest` hook,
// which fires BEFORE our `requireJwt` preHandler — so `req.deviceId`
// isn't populated yet at the moment the bucket is chosen. For JWT-
// gated routes we therefore do our own (cheap, stateless) JWT decode
// inside the keyGenerator so we can key per-device instead of per-IP.
//
// The double verify (here + requireJwt) is intentional and benign:
// HS256 verify is microseconds, and keying by device closes the
// "single IP, many devices" / "single device, rotating IPs" gaps.

import type { FastifyRequest } from 'fastify';
import { verifyToken } from '../auth/jwt.js';

/**
 * Read the token from the same headers the app uses (`X-Convos-AuthToken`
 * or `Authorization: Bearer …`). Returns null if no token is present
 * or it doesn't parse.
 */
function extractClaims(req: FastifyRequest): { sub: string } | null {
  const auth = req.headers.authorization;
  const headerToken = req.headers['x-convos-authtoken'];
  const token = (typeof headerToken === 'string' && headerToken)
    || (auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '');
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

/**
 * Per-device rate-limit key for routes that require a valid JWT. Falls
 * back to the request IP when the token is missing or invalid — those
 * requests are about to be rejected by `requireJwt` anyway, but the
 * fallback still bounds them under the normal per-IP budget.
 */
export function deviceKeyGenerator(req: FastifyRequest): string {
  const claims = extractClaims(req);
  return claims ? `device:${claims.sub}` : `ip:${req.ip}`;
}
