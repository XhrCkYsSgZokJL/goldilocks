// /v2/auth/challenge  — issues a one-time SIWE nonce
// /v2/me              — accepts a SIWE message + signature, verifies the
//                       caller is the inbox owner, returns client_number + isAdmin.
//
// These two endpoints are the new identity boundary for the Goldilocks
// backend. After a successful /v2/me call, the device is permanently
// bound to the inbox_id (and the eth_address used to prove it). Subsequent
// calls re-verify on every /v2/me hit.

import type { FastifyInstance } from 'fastify';
import { randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { adminInboxes, authChallenges, clients, devices, referrals, serverAgents, serverGroups } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { deviceKeyGenerator } from '../middleware/rate-limit-keys.js';
import { buildSiweMessage, verifyChallenge } from '../auth/siwe.js';
import { lookupHash } from '../crypto/lookup-hash.js';
import { emitSecurityEvent } from '../observability/security-events.js';

const ADMIN_UPGRADE_CODE_LOOKUP_LABEL = 'admin_inboxes.upgrade_code.lookup';

const ChallengeBody = z.object({
  inboxId: z.string().regex(/^[a-f0-9]{64}$/i, 'inboxId must be 64-char hex'),
  ethAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'ethAddress must be 0x + 40 hex chars'),
});

const MeBody = z.object({
  inboxId: z.string().regex(/^[a-f0-9]{64}$/i),
  siweMessage: z.string().min(1).max(8192),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, 'signature must be 0x + 130 hex chars'),
  /// iOS hint: this device's build-time role is admin. When the
  /// dev-mode self-promote gate is on, the backend inserts
  /// `admin_inboxes` BEFORE `clients` in the same call so the
  /// `admin_changed` NOTIFY fires *before* `client_registered` —
  /// reports-agent's onClientRegistered then sees the inbox is an
  /// admin and skips creating a Reports group entirely. Without this
  /// flag the registration order races: Reports gets briefly created
  /// before the separate /v2/admin/promote-self call lands, leaving
  /// stale MLS welcomes on the network. Ignored in production
  /// (GOLDILOCKS_ALLOW_SELF_PROMOTE=false).
  claimAdminRole: z.boolean().optional(),
});

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export default async function meRoutes(app: FastifyInstance) {
  // All /me endpoints require a JWT — that proves device identity. The
  // SIWE flow on top proves *inbox* identity. Two layers: device + inbox.
  app.addHook('preHandler', requireJwt);

  // ---------------------------------------------------------------------
  // POST /v2/auth/challenge
  // body: { inboxId, ethAddress }
  // returns: { siweMessage, nonce, expiresAt }
  // ---------------------------------------------------------------------
  app.post('/v2/auth/challenge', {
    config: {
      // Tighter than the global limit: a normal app flow does one
      // challenge → me. Repeated challenge fetches are either retries
      // (rare) or someone trying to harvest server-side nonces. Keyed
      // per-device via the JWT — `deviceKeyGenerator` does its own
      // cheap verify because rate-limit's hook runs before
      // requireJwt's preHandler populates `req.deviceId`.
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: deviceKeyGenerator,
      },
    },
  }, async (req, reply) => {
    const parsed = ChallengeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { inboxId, ethAddress } = parsed.data;
    const deviceId = req.deviceId!;

    // If this device has already locked an inbox_id, the claim must match.
    // Refuse mismatched re-registrations — that's the impersonation guard.
    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (device?.inboxId && device.inboxId !== inboxId) {
      // Critical: this device is already bound to a different inbox.
      // Either a real impersonation attempt or the rare case of a user
      // restoring a device backup into a different XMTP install.
      emitSecurityEvent(req.log, {
        event: 'siwe.device_inbox_mismatch',
        deviceId,
        inboxId,
        ip: req.ip,
        severity: 'critical',
        context: { reason: 'inbox_locked', expectedInbox: '<known>' },
      });
      return reply.code(409).send({ error: 'device_inbox_locked' });
    }
    if (device?.ethAddress && device.ethAddress.toLowerCase() !== ethAddress.toLowerCase()) {
      emitSecurityEvent(req.log, {
        event: 'siwe.device_inbox_mismatch',
        deviceId,
        inboxId,
        ethAddress,
        ip: req.ip,
        severity: 'critical',
        context: { reason: 'eth_locked' },
      });
      return reply.code(409).send({ error: 'device_eth_locked' });
    }

    const nonce = generateNonce();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

    await db.insert(authChallenges).values({
      nonce,
      deviceId,
      inboxId,
      expiresAt,
    });

    const siweMessage = buildSiweMessage({ inboxId, ethAddress, nonce });

    emitSecurityEvent(req.log, {
      event: 'siwe.challenge.issued',
      deviceId,
      inboxId,
      ethAddress,
      ip: req.ip,
    });

    return reply.code(200).send({
      siweMessage,
      nonce,
      expiresAt: expiresAt.toISOString(),
    });
  });

  // ---------------------------------------------------------------------
  // GET /v2/me
  // returns the caller's current state without re-doing SIWE. The device
  // must already be bound (via POST /v2/me) for this to return 200.
  // Used after admin promotion so the iOS app can refresh its identity.
  // ---------------------------------------------------------------------
  app.get('/v2/me', async (req, reply) => {
    const deviceId = req.deviceId!;

    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (!device?.inboxId) {
      return reply.code(409).send({ error: 'device_not_registered' });
    }
    const [client] = await db.select().from(clients).where(eq(clients.inboxId, device.inboxId)).limit(1);
    if (!client) {
      return reply.code(409).send({ error: 'client_missing' });
    }
    // A disabled admin row counts as a non-admin.
    const [adminRow] = await db
      .select()
      .from(adminInboxes)
      .where(and(eq(adminInboxes.inboxId, device.inboxId), eq(adminInboxes.disabled, false)))
      .limit(1);

    // Tell the goldilocks-agent that this user is online. The agent uses
    // the notification to call updateInstallations on every group the
    // user is a member of, folding in any new MLS installation iOS may
    // have rotated to since the agent last touched the group. Without
    // this, relaunches of an existing client get stuck on "Setting up
    // your channels..." because the welcome only goes to the last-known
    // installation, which iOS may have replaced.
    const payload = JSON.stringify({
      inbox_id: client.inboxId,
      client_id: client.id,
      is_admin: !!adminRow,
    });
    await db.execute(sql`SELECT pg_notify('user_active', ${payload})`);

    let referralCode: string = client.referralCode ?? '';
    if (!referralCode) {
      const n = randomBytes(4).readUInt32BE() % 1_000_000;
      referralCode = String(n).padStart(6, '0');
      await db.update(clients).set({ referralCode }).where(eq(clients.id, client.id));
    }

    const [referralCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(referrals)
      .where(and(eq(referrals.referrerClientId, client.id), isNotNull(referrals.referrerCreditAppliedAt)));

    const [appliedReferral] = await db
      .select({ id: referrals.id })
      .from(referrals)
      .where(eq(referrals.referredClientId, client.id))
      .limit(1);

    return reply.code(200).send({
      clientNumber: client.clientNumber,
      isAdmin: !!adminRow,
      inboxId: client.inboxId,
      emeraldMembershipEnabled: client.emeraldMembershipEnabled,
      referralCode,
      referralCreditCents: client.referralCreditCents,
      payingReferralCount: referralCount?.count ?? 0,
      hasAppliedReferralCode: !!appliedReferral,
    });
  });

  // ---------------------------------------------------------------------
  // GET /v2/admins
  // Returns the inbox_ids of all admins. Clients use this list as the
  // group members when they create their Goldilocks channels — that's
  // how a customer's "Advisory" group ends up with the Goldilocks team
  // as participants. Requires JWT so we don't leak the admin allowlist.
  // ---------------------------------------------------------------------
  app.get('/v2/admins', async (req, reply) => {
    // Only enabled, *claimed* admins — an unclaimed slot (CLI created a
    // row but nobody's entered the code yet) has a null inbox_id and
    // can't be a group member. Disabled admins are excluded too.
    const rows = await db
      .select({ inboxId: adminInboxes.inboxId, name: adminInboxes.name })
      .from(adminInboxes)
      .where(and(eq(adminInboxes.disabled, false), isNotNull(adminInboxes.inboxId)));
    return reply.code(200).send({ inboxes: rows });
  });

  // ---------------------------------------------------------------------
  // GET /v2/agents
  // Returns the inbox_ids of the long-lived server-side XMTP agents
  // (admins-agent, reports-agent). The iOS app uses these to auto-allow
  // group welcomes that originate from a known agent — bypassing the
  // standard invite/consent flow for first-party-managed groups while
  // leaving stranger DMs / random groups subject to the usual gate.
  // ---------------------------------------------------------------------
  app.get('/v2/agents', async (req, reply) => {
    const rows = await db
      .select({ kind: serverAgents.kind, inboxId: serverAgents.inboxId })
      .from(serverAgents);
    const inboxes = rows
      .filter((r) => r.inboxId)
      .map((r) => ({ kind: r.kind, inboxId: r.inboxId as string }));

    // Surface the cross-admin Admins + Alerts groups so admin iOS
    // clients can include them in `GoldilocksOwnedChannels` and pass
    // the staleness filter. Both null when the admins-agent hasn't
    // created them yet (no admins promoted).
    const groupRows = await db
      .select({ kind: serverGroups.kind, xmtpGroupId: serverGroups.xmtpGroupId })
      .from(serverGroups);
    const adminsGroupId = groupRows.find((r) => r.kind === 'admins')?.xmtpGroupId ?? null;
    const alertsGroupId = groupRows.find((r) => r.kind === 'alerts')?.xmtpGroupId ?? null;

    return reply.code(200).send({ agents: inboxes, adminsGroupId, alertsGroupId });
  });

  // ---------------------------------------------------------------------
  // POST /v2/admin/promote-self    (DEV-ONLY)
  // Adds the caller's currently-bound inbox_id to admin_inboxes. Gated by
  // GOLDILOCKS_ALLOW_SELF_PROMOTE so a stray production deploy can't be
  // self-claimed for admin.
  // ---------------------------------------------------------------------
  app.post('/v2/admin/promote-self', {
    config: {
      // Dev-only, but defensive: tight per-device limit so a stray prod
      // build with the feature flag flipped on is bounded even before
      // the JWT preHandler runs.
      rateLimit: {
        max: 3,
        timeWindow: '1 minute',
        keyGenerator: deviceKeyGenerator,
      },
    },
  }, async (req, reply) => {
    if (!config.GOLDILOCKS_ALLOW_SELF_PROMOTE) {
      return reply.code(403).send({ error: 'self_promote_disabled' });
    }
    const deviceId = req.deviceId!;

    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (!device?.inboxId) {
      return reply.code(409).send({ error: 'device_not_registered' });
    }

    const promoteCode = generateUpgradeCode();
    await db
      .insert(adminInboxes)
      .values({
        inboxId: device.inboxId,
        name: 'Self-promoted (dev)',
        upgradeCode: promoteCode,
        upgradeCodeLookup: lookupHash(promoteCode, ADMIN_UPGRADE_CODE_LOOKUP_LABEL),
        claimedAt: new Date(),
      })
      .onConflictDoNothing();

    return reply.code(200).send({ ok: true, inboxId: device.inboxId });
  });

  // ---------------------------------------------------------------------
  // POST /v2/admin/upgrade
  // body: { code }
  // Claims a CLI-created admin slot. Each admin row carries its own
  // uniquely-generated `upgrade_code` (issued by `./dev/admins add`). The
  // person enters that code in the iOS debug area; we bind their inbox_id
  // to the matching slot. The UPDATE fires `admin_changed` → the agent
  // adds the inbox to the cross-admin groups + every Advisory. A wrong
  // code, or a code whose slot has been disabled by the CLI, is rejected.
  // ---------------------------------------------------------------------
  app.post('/v2/admin/upgrade', {
    config: {
      // The brute-force-sensitive surface: a 16-digit upgrade code
      // unlocks admin. 3 / minute / device holds even an attacker who
      // has stolen a single JWT to a glacial guess rate against the
      // 10^16 code space. Falls back to per-IP keying when the JWT
      // is missing (which `requireJwt` would reject anyway).
      rateLimit: {
        max: 3,
        timeWindow: '1 minute',
        keyGenerator: deviceKeyGenerator,
      },
    },
  }, async (req, reply) => {
    const parsed = z.object({ code: z.string().min(1).max(64) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    // Codes are stored as plain digits; accept them typed with or without
    // the "1234-5678-9012-3456" grouping dashes (or any other separators).
    const code = parsed.data.code.replace(/\D/g, '');

    const deviceId = req.deviceId!;
    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (!device?.inboxId) {
      return reply.code(409).send({ error: 'device_not_registered' });
    }

    // `upgrade_code` is F4-encrypted (fresh AES-GCM nonce per write),
    // so equality filters against the ciphertext column never match.
    // We look the slot up by the deterministic keyed hash sidecar
    // (`upgrade_code_lookup`) instead — O(1) via the unique index.
    //
    // Rows that predate migration 019 may still have a NULL lookup
    // column; the legacy in-app scan is the fallback. Each successful
    // legacy match opportunistically backfills the hash so the next
    // attempt for the same slot is O(1).
    const codeLookup = lookupHash(code, ADMIN_UPGRADE_CODE_LOOKUP_LABEL);
    const [hashedSlot] = await db
      .select()
      .from(adminInboxes)
      .where(eq(adminInboxes.upgradeCodeLookup, codeLookup))
      .limit(1);

    let slot = hashedSlot;
    if (!slot) {
      const legacyRows = await db
        .select()
        .from(adminInboxes)
        .where(isNull(adminInboxes.upgradeCodeLookup));
      const legacyMatch = legacyRows.find((row) => row.upgradeCode === code);
      if (legacyMatch) {
        await db
          .update(adminInboxes)
          .set({ upgradeCodeLookup: codeLookup })
          .where(eq(adminInboxes.id, legacyMatch.id));
        slot = { ...legacyMatch, upgradeCodeLookup: codeLookup };
      }
    }
    if (!slot) {
      // Brute-force signal — combined with the 3/min/device rate limit,
      // a sustained stream of these from a single device is suspicious.
      emitSecurityEvent(req.log, {
        event: 'admin.upgrade.invalid_code',
        deviceId,
        inboxId: device.inboxId,
        ip: req.ip,
        severity: 'warn',
      });
      return reply.code(403).send({ error: 'invalid_code' });
    }
    if (slot.disabled) {
      emitSecurityEvent(req.log, {
        event: 'admin.upgrade.disabled_code',
        deviceId,
        inboxId: device.inboxId,
        ip: req.ip,
        severity: 'warn',
      });
      return reply.code(403).send({ error: 'code_disabled' });
    }

    // Release this inbox from any other slot it already occupies (e.g.
    // the admin switched codes), then bind it to the claimed slot. Both
    // UPDATEs fire `admin_changed` so the agent reconciles membership.
    await db
      .update(adminInboxes)
      .set({ inboxId: null, claimedAt: null })
      .where(and(eq(adminInboxes.inboxId, device.inboxId), ne(adminInboxes.id, slot.id)));

    await db
      .update(adminInboxes)
      .set({ inboxId: device.inboxId, claimedAt: new Date() })
      .where(eq(adminInboxes.id, slot.id));

    emitSecurityEvent(req.log, {
      event: 'admin.upgrade.success',
      deviceId,
      inboxId: device.inboxId,
      ip: req.ip,
      context: { adminName: slot.name },
    });

    return reply.code(200).send({ ok: true, isAdmin: true, inboxId: device.inboxId });
  });

  // ---------------------------------------------------------------------
  // POST /v2/admin/downgrade
  // Self-downgrade: the caller releases the admin slot they claimed. We
  // clear inbox_id + claimed_at so the slot (name + code) returns to the
  // registry — the admin can re-claim it later by re-entering the same
  // code. The UPDATE fires `admin_changed`, and the agent's reconcile
  // removes the inbox from the Admins + Audit Log groups and every
  // Advisory. The CLI's disable/remove are the hard revocations. No-op
  // if the caller wasn't an admin.
  // ---------------------------------------------------------------------
  app.post('/v2/admin/downgrade', async (req, reply) => {
    const deviceId = req.deviceId!;
    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (!device?.inboxId) {
      return reply.code(409).send({ error: 'device_not_registered' });
    }

    await db
      .update(adminInboxes)
      .set({ inboxId: null, claimedAt: null })
      .where(eq(adminInboxes.inboxId, device.inboxId));

    return reply.code(200).send({ ok: true, isAdmin: false, inboxId: device.inboxId });
  });

  // ---------------------------------------------------------------------
  // POST /v2/me
  // body: { inboxId, siweMessage, signature }
  // returns: { clientNumber, isAdmin, inboxId }
  // ---------------------------------------------------------------------
  app.post('/v2/me', async (req, reply) => {
    const parsed = MeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { inboxId, siweMessage, signature, claimAdminRole } = parsed.data;
    const deviceId = req.deviceId!;

    // Pull the matching unconsumed, unexpired challenge.
    const [challenge] = await db
      .select()
      .from(authChallenges)
      .where(and(
        eq(authChallenges.deviceId, deviceId),
        eq(authChallenges.inboxId, inboxId),
      ))
      .orderBy(sql`${authChallenges.issuedAt} DESC`)
      .limit(1);

    if (!challenge) {
      return reply.code(401).send({ error: 'no_challenge_for_device' });
    }
    if (challenge.consumedAt) {
      return reply.code(401).send({ error: 'challenge_already_consumed' });
    }
    if (challenge.expiresAt.getTime() < Date.now()) {
      return reply.code(401).send({ error: 'challenge_expired' });
    }

    const verification = await verifyChallenge({
      siweMessage,
      signature,
      expectedInboxId: inboxId,
      expectedNonce: challenge.nonce,
    });

    if (!verification.ok) {
      emitSecurityEvent(req.log, {
        event: 'siwe.challenge.failed',
        deviceId,
        inboxId,
        ip: req.ip,
        severity: 'warn',
        context: { reason: verification.reason },
      });
      return reply.code(401).send({ error: 'verification_failed', reason: verification.reason });
    }

    // Mark the challenge consumed before any DB writes so a parallel call
    // can't replay it. Single-use guarantee.
    await db
      .update(authChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(authChallenges.nonce, challenge.nonce));

    // Bind the device to (inbox_id, eth_address) — locked on first
    // successful registration. Idempotent thereafter.
    await db
      .update(devices)
      .set({ inboxId, ethAddress: verification.ethAddress, updatedAt: sql`now()` })
      .where(eq(devices.deviceId, deviceId));

    emitSecurityEvent(req.log, {
      event: 'siwe.challenge.verified',
      deviceId,
      inboxId,
      ethAddress: verification.ethAddress,
      ip: req.ip,
    });

    // If iOS claims the admin role AND the dev-mode gate is on,
    // promote the inbox NOW — *before* the clients insert. This makes
    // the `admin_changed` NOTIFY fire before `client_registered`, so
    // when the agent's reports-agent processes the client_registered
    // event it already sees the inbox in admin_inboxes and skips
    // Reports creation. Without this ordering, Reports gets briefly
    // created and then marked exploded — leaving stranded MLS state
    // on the network. Production (gate off) ignores the flag; admin
    // promotion stays a separate authenticated path.
    if (claimAdminRole && config.GOLDILOCKS_ALLOW_SELF_PROMOTE) {
      const bootstrapCode = generateUpgradeCode();
      await db
        .insert(adminInboxes)
        .values({
          inboxId,
          name: 'Self-promoted (dev)',
          upgradeCode: bootstrapCode,
          upgradeCodeLookup: lookupHash(bootstrapCode, ADMIN_UPGRADE_CODE_LOOKUP_LABEL),
          claimedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    // Find-or-create the client row. The auto-incrementing
    // client_number is what the admin UI displays as "Advisory #55".
    let [client] = await db.select().from(clients).where(eq(clients.inboxId, inboxId)).limit(1);
    if (!client) {
      [client] = await db
        .insert(clients)
        .values({ inboxId })
        .returning();
    }
    if (!client) {
      return reply.code(500).send({ error: 'client_create_failed' });
    }

    // Every client gets a referral code, paying or not. Generate it here
    // at registration and return it on this first response so the iOS
    // identity is populated immediately, rather than waiting for a later
    // GET /v2/me to lazily mint one.
    let referralCode: string = client.referralCode ?? '';
    if (!referralCode) {
      const n = randomBytes(4).readUInt32BE() % 1_000_000;
      referralCode = String(n).padStart(6, '0');
      await db.update(clients).set({ referralCode }).where(eq(clients.id, client.id));
    }

    // Admin allowlist lookup (post-claim, so a fresh admin shows
    // isAdmin=true on the very first /v2/me response). A disabled row
    // counts as a non-admin.
    const [adminRow] = await db
      .select()
      .from(adminInboxes)
      .where(and(eq(adminInboxes.inboxId, inboxId), eq(adminInboxes.disabled, false)))
      .limit(1);

    return reply.code(200).send({
      clientNumber: client.clientNumber,
      isAdmin: !!adminRow,
      inboxId: client.inboxId,
      emeraldMembershipEnabled: client.emeraldMembershipEnabled,
      referralCode,
    });
  });
}

/**
 * 16-byte hex nonce. SIWE spec requires "at least 8 alphanumeric
 * characters"; 32 hex chars is more than that and gives 128 bits of
 * unguessability — well above what's needed for a 5-minute TTL.
 */
function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 16-digit numeric upgrade code, stored as plain digits. Numeric so it
 * matches the iOS numpad entry field, which displays it grouped as
 * "1234-5678-9012-3456". Only used by the dev self-promote paths — real
 * admin slots get their codes from the `admins` CLI, which checks for
 * uniqueness. Collisions here are astronomically unlikely and the
 * inserts that use it are `onConflictDoNothing`.
 */
function generateUpgradeCode(): string {
  // Two 8-digit halves so each stays within Number.MAX_SAFE_INTEGER.
  const half = (): string => String(randomInt(0, 100_000_000)).padStart(8, '0');
  return `${half()}${half()}`;
}
