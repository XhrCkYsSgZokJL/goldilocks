import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export interface Claims {
  sub: string;     // deviceId
  jti: string;     // unique token id, used for revocation
  iat: number;
  exp: number;
}

export function issueToken(deviceId: string): { token: string; jti: string; expiresAt: Date } {
  const jti = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.JWT_TTL_SECONDS;
  const token = jwt.sign(
    { sub: deviceId, jti, iat: now, exp } satisfies Claims,
    config.JWT_SECRET,
    { algorithm: 'HS256' },
  );
  return { token, jti, expiresAt: new Date(exp * 1000) };
}

export function verifyToken(token: string): Claims {
  const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  if (typeof decoded === 'string' || !decoded || typeof (decoded as Claims).sub !== 'string') {
    throw new Error('Invalid token shape');
  }
  return decoded as Claims;
}
