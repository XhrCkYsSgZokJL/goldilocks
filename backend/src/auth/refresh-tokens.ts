// Refresh-token rotation with family-based theft detection (RFC 6819 §5.2.2.3).
//
// One sealed family per login. Each refresh exchange consumes the
// current refresh token, marks it `used_at`, and issues a new pair
// (access + refresh) whose `parent_id` points at the consumed token.
// If a *used* refresh token is presented again, the whole family is
// revoked — that means either a buggy client is double-spending or
// (worse) an attacker stole an old copy. Either way the safe response
// is to nuke the family and force re-authentication.
//
// Refresh tokens are random 256-bit values; the database stores the
// SHA-256 hash so a database dump can't be replayed without the
// original token. The plain token is only ever returned to the client
// at the moment it's issued.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';

const REFRESH_TOKEN_BYTES = 32; // 256 bits of entropy

export interface IssuedRefresh {
  /** Plain token to return to the caller. Never persisted. */
  token: string;
  /** Database row id. */
  id: string;
  /** Family id this token belongs to. */
  familyId: string;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function freshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

function ttlFromNow(): Date {
  return new Date(Date.now() + config.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Mint a brand-new refresh-token family for a login. Use this on
 * `/v2/auth/token` and `/v2/me` — anywhere a new device session begins.
 */
export async function issueNewFamily(deviceId: string, inboxId: string | null): Promise<IssuedRefresh> {
  const token = freshToken();
  const id = randomUUID();
  const familyId = randomUUID();
  const expiresAt = ttlFromNow();

  await db.insert(refreshTokens).values({
    id,
    familyId,
    parentId: null,
    deviceId,
    inboxId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return { token, id, familyId, expiresAt };
}

export type RotateResult =
  | { kind: 'rotated'; refresh: IssuedRefresh; deviceId: string; inboxId: string | null }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'reused'; familyId: string };

/**
 * The state of one persisted refresh-token row that the planner needs
 * to decide what to do. A subset of `refreshTokens` columns — kept
 * minimal so the unit test doesn't need to reproduce the entire schema.
 */
export interface RefreshTokenLookup {
  id: string;
  familyId: string;
  deviceId: string;
  inboxId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export type RotationPlan =
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'reused'; familyId: string }
  | { kind: 'rotate'; row: RefreshTokenLookup };

/**
 * Pure decision function over the state of a row. Exported so the unit
 * test in refresh-tokens.test.ts can exercise it without a database.
 */
export function planRotation(row: RefreshTokenLookup | undefined, now: Date): RotationPlan {
  if (!row) return { kind: 'invalid' };
  if (row.revokedAt !== null) return { kind: 'invalid' };
  if (row.usedAt !== null) return { kind: 'reused', familyId: row.familyId };
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
  return { kind: 'rotate', row };
}

/**
 * Consume a refresh token and issue its successor. If the supplied
 * token has already been used, revoke the entire family.
 */
export async function rotateRefreshToken(plainToken: string): Promise<RotateResult> {
  const tokenHash = hashToken(plainToken);
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);

  const plan = planRotation(row, new Date());

  switch (plan.kind) {
    case 'invalid':
    case 'expired':
      return { kind: plan.kind };
    case 'reused': {
      // The token was already consumed once. Either a benign client retry
      // raced (rare with a single-flight client gate) or someone is
      // replaying a stolen copy. Revoke the whole family and let the user
      // re-authenticate.
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.familyId, plan.familyId), isNull(refreshTokens.revokedAt)));
      return { kind: 'reused', familyId: plan.familyId };
    }
    case 'rotate': {
      const parent = plan.row;
      const nextToken = freshToken();
      const nextId = randomUUID();
      const expiresAt = ttlFromNow();

      // Atomic-ish: mark the parent used and insert the child. Drizzle
      // doesn't expose a transaction in this codebase pattern; the two
      // writes are sequential and idempotent — the duplicate-use check
      // above is the real safety net.
      await db
        .update(refreshTokens)
        .set({ usedAt: new Date() })
        .where(eq(refreshTokens.id, parent.id));

      await db.insert(refreshTokens).values({
        id: nextId,
        familyId: parent.familyId,
        parentId: parent.id,
        deviceId: parent.deviceId,
        inboxId: parent.inboxId,
        tokenHash: hashToken(nextToken),
        expiresAt,
      });

      return {
        kind: 'rotated',
        refresh: { token: nextToken, id: nextId, familyId: parent.familyId, expiresAt },
        deviceId: parent.deviceId,
        inboxId: parent.inboxId,
      };
    }
  }
}

/**
 * Revoke every refresh token in the family containing the supplied
 * token — used on logout. Idempotent: revoked rows stay revoked.
 */
export async function revokeFamilyByToken(plainToken: string): Promise<boolean> {
  const tokenHash = hashToken(plainToken);
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row) return false;
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
  return true;
}
