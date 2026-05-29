import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planRotation, type RefreshTokenLookup } from './refresh-tokens.js';

// Pure-decision tests for the RFC 6819 §5.2.2.3 theft-detection branch.
// The DB-touching layer that actually applies the decision is exercised
// by an integration test under `./dev/test` against the running
// Postgres; this suite covers the algebra so a regression here can't
// hide behind a missing local Postgres.

const baseRow = (overrides: Partial<RefreshTokenLookup> = {}): RefreshTokenLookup => ({
  id: 'row-1',
  familyId: 'family-1',
  deviceId: 'device-1',
  inboxId: 'inbox-1',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
  usedAt: null,
  revokedAt: null,
  ...overrides,
});

describe('auth/refresh-tokens — planRotation', () => {
  it('returns `rotate` for a fresh, unused, unexpired row', () => {
    const plan = planRotation(baseRow(), new Date());
    assert.equal(plan.kind, 'rotate');
  });

  it('returns `invalid` when no row matches the supplied token', () => {
    const plan = planRotation(undefined, new Date());
    assert.deepEqual(plan, { kind: 'invalid' });
  });

  it('returns `invalid` when the row is already revoked', () => {
    const plan = planRotation(baseRow({ revokedAt: new Date() }), new Date());
    assert.deepEqual(plan, { kind: 'invalid' });
  });

  it('returns `expired` when expiresAt is now or in the past', () => {
    const past = new Date(Date.now() - 1);
    const plan = planRotation(baseRow({ expiresAt: past }), new Date());
    assert.equal(plan.kind, 'expired');
  });

  it('returns `reused` (with familyId) when usedAt is set — the theft-detection branch', () => {
    const plan = planRotation(
      baseRow({ usedAt: new Date(Date.now() - 1000), familyId: 'fam-stolen' }),
      new Date(),
    );
    assert.deepEqual(plan, { kind: 'reused', familyId: 'fam-stolen' });
  });

  it('treats `usedAt` as higher priority than `expiresAt` — a stolen-then-expired token still revokes the family', () => {
    // If an attacker replays an old token after its TTL passed, we
    // still want to nuke the family (the legitimate user may still
    // have an unused token in the chain). The reused signal wins.
    const past = new Date(Date.now() - 1);
    const plan = planRotation(
      baseRow({ usedAt: new Date(Date.now() - 5000), expiresAt: past }),
      new Date(),
    );
    assert.equal(plan.kind, 'reused');
  });

  it('treats `revokedAt` as higher priority than `usedAt` — already-revoked tokens just look invalid', () => {
    // After we already nuked the family, the (now-revoked, formerly-
    // used) row should not trigger another reused-→-revoke loop; it
    // just reports `invalid` so the caller returns 401.
    const plan = planRotation(
      baseRow({ usedAt: new Date(Date.now() - 5000), revokedAt: new Date() }),
      new Date(),
    );
    assert.deepEqual(plan, { kind: 'invalid' });
  });
});

describe('auth/refresh-tokens — full-lifecycle scenarios (state machine)', () => {
  // These reconstruct a representative interaction by walking
  // planRotation across the state mutations the real code applies.
  // They aren't a substitute for the DB-backed integration test, but
  // they pin the algebra: "what should the system decide at step N
  // given the state at step N-1?"

  it('legitimate rotate → rotate → rotate chain', () => {
    let row = baseRow({ id: 'r1' });
    let plan = planRotation(row, new Date());
    assert.equal(plan.kind, 'rotate');

    // Step 2: parent is now used; child r2 is the new "current".
    row = baseRow({ id: 'r2' });
    plan = planRotation(row, new Date());
    assert.equal(plan.kind, 'rotate');

    // Step 3: r2 used; child r3 is the current.
    row = baseRow({ id: 'r3' });
    plan = planRotation(row, new Date());
    assert.equal(plan.kind, 'rotate');
  });

  it('attacker steals r1, legitimate client rotates r1 → r2, attacker replays r1 → family revoked', () => {
    // r1 is fresh, unused.
    const r1Fresh = baseRow({ id: 'r1', familyId: 'F' });
    assert.equal(planRotation(r1Fresh, new Date()).kind, 'rotate');

    // Legitimate client rotates r1 → r2. r1.used_at gets set by the
    // application layer; the on-disk row now looks like:
    const r1Used = baseRow({ id: 'r1', familyId: 'F', usedAt: new Date() });

    // Attacker replays the original r1 token. The lookup hits the
    // same row, but it's now used. → revoke family.
    const attackerPlan = planRotation(r1Used, new Date());
    assert.deepEqual(attackerPlan, { kind: 'reused', familyId: 'F' });

    // After the application layer revokes the family, any subsequent
    // attempt against r1, r2, or any other family member reads back
    // as revoked → invalid (no further family nuke happens).
    const r1AfterRevoke = baseRow({
      id: 'r1',
      familyId: 'F',
      usedAt: new Date(),
      revokedAt: new Date(),
    });
    const r2AfterRevoke = baseRow({
      id: 'r2',
      familyId: 'F',
      revokedAt: new Date(),
    });
    assert.deepEqual(planRotation(r1AfterRevoke, new Date()), { kind: 'invalid' });
    assert.deepEqual(planRotation(r2AfterRevoke, new Date()), { kind: 'invalid' });
  });

  it('expired-but-unused token returns expired (not reused)', () => {
    const past = new Date(Date.now() - 1);
    const plan = planRotation(baseRow({ expiresAt: past }), new Date());
    assert.equal(plan.kind, 'expired');
  });
});
