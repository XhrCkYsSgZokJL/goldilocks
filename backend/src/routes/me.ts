// /v2/auth/challenge  — issues a one-time SIWE nonce
// /v2/me              — accepts a SIWE message + signature, verifies the
//                       caller is the inbox owner, returns client_number + isAdmin.
//
// These two endpoints are the new identity boundary for the Goldilocks
// backend. After a successful /v2/me call, the device is permanently
// bound to the inbox_id (and the eth_address used to prove it). Subsequent
// calls re-verify on every /v2/me hit.

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { adminInboxes, authChallenges, clients, devices, serverAgents, serverGroups } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { buildSiweMessage, verifyChallenge } from '../auth/siwe.js';

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
  app.post('/v2/auth/challenge', async (req, reply) => {
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
      return reply.code(409).send({ error: 'device_inbox_locked' });
    }
    if (device?.ethAddress && device.ethAddress.toLowerCase() !== ethAddress.toLowerCase()) {
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
    const [adminRow] = await db.select().from(adminInboxes).where(eq(adminInboxes.inboxId, device.inboxId)).limit(1);

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

    return reply.code(200).send({
      clientNumber: client.clientNumber,
      isAdmin: !!adminRow,
      inboxId: client.inboxId,
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
    const rows = await db
      .select({ inboxId: adminInboxes.inboxId, name: adminInboxes.name })
      .from(adminInboxes);
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
  app.post('/v2/admin/promote-self', async (req, reply) => {
    if (!config.GOLDILOCKS_ALLOW_SELF_PROMOTE) {
      return reply.code(403).send({ error: 'self_promote_disabled' });
    }
    const deviceId = req.deviceId!;

    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (!device?.inboxId) {
      return reply.code(409).send({ error: 'device_not_registered' });
    }

    await db
      .insert(adminInboxes)
      .values({ inboxId: device.inboxId, name: 'Self-promoted (dev)' })
      .onConflictDoNothing();

    return reply.code(200).send({ ok: true, inboxId: device.inboxId });
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
      await db
        .insert(adminInboxes)
        .values({ inboxId, name: 'Self-promoted (dev)' })
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

    // Admin allowlist lookup (post-claim, so a fresh admin shows
    // isAdmin=true on the very first /v2/me response).
    const [adminRow] = await db
      .select()
      .from(adminInboxes)
      .where(eq(adminInboxes.inboxId, inboxId))
      .limit(1);

    return reply.code(200).send({
      clientNumber: client.clientNumber,
      isAdmin: !!adminRow,
      inboxId: client.inboxId,
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
