// Goldilocks channel lifecycle endpoints.
//
//   POST   /v2/me/channels                  register an XMTP group as
//                                            (this caller, role)
//   PATCH  /v2/me/channels/:role             mark a channel exploded
//   POST   /v2/me/channels/:role/recreate    new xmtp_group_id; status='active'
//   GET    /v2/me/channels                   list this caller's channels
//   GET    /v2/admin/channels                admin-only: all clients' channels
//
// All endpoints require the caller to have completed /v2/me first
// (we resolve their `clientId` via deviceId → inbox_id → clients).

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isCoverageActive, liveBalanceCents } from '../billing/balance.js';
import { monthlyTotalCents } from '../billing/pricing.js';
import { db } from '../db/client.js';
import { adminInboxes, clients, clientChannels, devices } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { adminNumberForInbox, emitAuditEvent } from '../audit-events.js';
import { emitOpsEvent } from '../observability/ops-events.js';

const ROLE = z.enum(['advisory', 'reports']);

const RegisterBody = z.object({
  role: ROLE,
  xmtpGroupId: z.string().min(1).max(256),
});

const RecreateBody = z.object({
  xmtpGroupId: z.string().min(1).max(256),
});

interface CallerContext {
  clientId: string;
  clientNumber: number;
  inboxId: string;
  isAdmin: boolean;
}

async function resolveCaller(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<CallerContext | null> {
  const deviceId = req.deviceId;
  if (!deviceId) {
    reply.code(401).send({ error: 'no_device' });
    return null;
  }

  const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
  if (!device?.inboxId) {
    reply.code(409).send({ error: 'device_not_registered', message: 'Call POST /v2/me first.' });
    return null;
  }

  const [client] = await db.select().from(clients).where(eq(clients.inboxId, device.inboxId)).limit(1);
  if (!client) {
    reply.code(409).send({ error: 'client_missing', message: 'Device claims an inbox with no clients row.' });
    return null;
  }

  // A disabled admin row counts as a non-admin.
  const [adminRow] = await db
    .select()
    .from(adminInboxes)
    .where(and(eq(adminInboxes.inboxId, device.inboxId), eq(adminInboxes.disabled, false)))
    .limit(1);

  return {
    clientId: client.id,
    clientNumber: client.clientNumber,
    inboxId: device.inboxId,
    isAdmin: !!adminRow,
  };
}

export default async function channelRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireJwt);

  // -------------------------------------------------------------------
  // POST /v2/me/channels
  // body: { role, xmtpGroupId }
  // returns: { role, xmtpGroupId, clientNumber, status }
  // -------------------------------------------------------------------
  app.post('/v2/me/channels', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;

    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { role, xmtpGroupId } = parsed.data;

    // Upsert: a previously-exploded channel becomes active again with
    // the new group_id. Otherwise insert fresh. Either way we return
    // the post-state.
    await db
      .insert(clientChannels)
      .values({
        clientId: caller.clientId,
        role,
        xmtpGroupId,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [clientChannels.clientId, clientChannels.role],
        set: {
          xmtpGroupId,
          status: 'active',
          recreatedAt: sql`now()`,
        },
      });

    emitOpsEvent(req.log, {
      event: 'channel.registered',
      clientId: caller.clientId,
      inboxId: caller.inboxId,
      context: { role },
    });

    return reply.code(200).send({
      role,
      xmtpGroupId,
      clientNumber: caller.clientNumber,
      status: 'active',
    });
  });

  // -------------------------------------------------------------------
  // GET /v2/me/channels
  // returns: { clientNumber, expectedRoles, channels: [{role, ...}] }
  // -------------------------------------------------------------------
  app.get('/v2/me/channels', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;

    const rows = await db
      .select()
      .from(clientChannels)
      .where(eq(clientChannels.clientId, caller.clientId));

    return reply.code(200).send({
      clientNumber: caller.clientNumber,
      // Every client is provisioned one channel per role (advisory +
      // reports). The agents create those groups asynchronously after
      // registration, so `channels` can briefly be a partial set — iOS
      // reads `expectedRoles` to know the full target and avoid latching
      // "setup complete" before every channel has landed.
      expectedRoles: [...ROLE.options],
      channels: rows.map((r) => ({
        role: r.role,
        xmtpGroupId: r.xmtpGroupId,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        explodedAt: r.explodedAt?.toISOString() ?? null,
        recreatedAt: r.recreatedAt?.toISOString() ?? null,
      })),
    });
  });

  // -------------------------------------------------------------------
  // PATCH /v2/me/channels/:role
  // body: {}
  // Marks the channel exploded. xmtp_group_id is preserved (audit) but
  // status flips to 'exploded'. Idempotent.
  // -------------------------------------------------------------------
  app.patch<{ Params: { role: string } }>('/v2/me/channels/:role', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;

    const parsedRole = ROLE.safeParse(req.params.role);
    if (!parsedRole.success) {
      return reply.code(400).send({ error: 'invalid_role' });
    }

    const result = await db
      .update(clientChannels)
      .set({ status: 'exploded', explodedAt: sql`now()` })
      .where(and(
        eq(clientChannels.clientId, caller.clientId),
        eq(clientChannels.role, parsedRole.data),
      ))
      .returning();

    if (result.length === 0) {
      return reply.code(404).send({ error: 'channel_not_found' });
    }
    emitOpsEvent(req.log, {
      event: 'channel.exploded',
      clientId: caller.clientId,
      inboxId: caller.inboxId,
      context: { role: parsedRole.data },
    });
    return reply.code(200).send({ ok: true });
  });

  // -------------------------------------------------------------------
  // POST /v2/me/channels/:role/recreate
  // body: { xmtpGroupId }
  // Replaces the xmtp_group_id with a fresh one and flips status back
  // to 'active'. recreated_at is updated.
  // -------------------------------------------------------------------
  app.post<{ Params: { role: string } }>('/v2/me/channels/:role/recreate', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;

    const parsedRole = ROLE.safeParse(req.params.role);
    if (!parsedRole.success) {
      return reply.code(400).send({ error: 'invalid_role' });
    }

    const parsedBody = RecreateBody.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsedBody.error.flatten() });
    }

    const result = await db
      .update(clientChannels)
      .set({
        xmtpGroupId: parsedBody.data.xmtpGroupId,
        status: 'active',
        recreatedAt: sql`now()`,
      })
      .where(and(
        eq(clientChannels.clientId, caller.clientId),
        eq(clientChannels.role, parsedRole.data),
      ))
      .returning();

    if (result.length === 0) {
      return reply.code(404).send({ error: 'channel_not_found' });
    }
    emitOpsEvent(req.log, {
      event: 'channel.recreated',
      clientId: caller.clientId,
      inboxId: caller.inboxId,
      context: { role: parsedRole.data },
    });
    return reply.code(200).send({
      role: parsedRole.data,
      xmtpGroupId: parsedBody.data.xmtpGroupId,
      status: 'active',
    });
  });

  // -------------------------------------------------------------------
  // POST /v2/me/channels/recover
  // Fires pg_notify('channels_recover', { client_id, inbox_id }) so the
  // agent can remove + re-add this client from each of their channels,
  // generating fresh MLS welcomes. iOS calls this when its local
  // conversation count is below the number of active channels the
  // backend reports — typically because a welcome was dropped during
  // initial sync (the old inviteTag UNIQUE bug) or because the
  // installation rotated and the original welcome ciphertext became
  // undecryptable. Idempotent — calling on a healthy state just causes
  // an extra commit cycle that the iOS client will absorb silently.
  // -------------------------------------------------------------------
  app.post('/v2/me/channels/recover', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;

    const payload = JSON.stringify({
      client_id: caller.clientId,
      inbox_id: caller.inboxId,
    });
    // pg_notify takes (channel_name, payload). drizzle's sql tag handles
    // both arguments cleanly here.
    await db.execute(sql`SELECT pg_notify('channels_recover', ${payload})`);

    emitOpsEvent(req.log, {
      event: 'channel.recover_requested',
      clientId: caller.clientId,
      inboxId: caller.inboxId,
    });

    return reply.code(202).send({ accepted: true });
  });

  // -------------------------------------------------------------------
  // GET /v2/admin/channels
  // Admin-only. Returns every client's channels with the client_number
  // so the admin app can render "Advisory #55", "Reports #56" etc.
  // `monthlyRateCents` is the client's current monthly spend, and
  // `coverageActive` says whether they hold a live prepaid balance — both
  // feed the Bronze/Silver/Gold membership tier shown in the admin app.
  // -------------------------------------------------------------------
  app.get('/v2/admin/channels', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;
    if (!caller.isAdmin) {
      return reply.code(403).send({ error: 'not_admin' });
    }

    const rows = await db
      .select({
        clientId: clientChannels.clientId,
        clientNumber: clients.clientNumber,
        clientInboxId: clients.inboxId,
        billingBalanceCents: clients.billingBalanceCents,
        billingSeats: clients.billingSeats,
        billingBalanceAsOf: clients.billingBalanceAsOf,
        emeraldMembershipEnabled: clients.emeraldMembershipEnabled,
        coveredPeople: clients.coveredPeople,
        lastBalanceTickAt: clients.lastBalanceTickAt,
        coverageEnabled: clients.coverageEnabled,
        role: clientChannels.role,
        xmtpGroupId: clientChannels.xmtpGroupId,
        status: clientChannels.status,
        createdAt: clientChannels.createdAt,
        explodedAt: clientChannels.explodedAt,
        recreatedAt: clientChannels.recreatedAt,
      })
      .from(clientChannels)
      .innerJoin(clients, eq(clientChannels.clientId, clients.id));

    return reply.code(200).send({
      channels: rows.map((r) => ({
        clientNumber: r.clientNumber,
        clientInboxId: r.clientInboxId,
        monthlyRateCents: monthlyTotalCents(r.billingSeats),
        coverageActive: isCoverageActive(r),
        emeraldMembershipEnabled: r.emeraldMembershipEnabled,
        role: r.role,
        xmtpGroupId: r.xmtpGroupId,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        explodedAt: r.explodedAt?.toISOString() ?? null,
        recreatedAt: r.recreatedAt?.toISOString() ?? null,
      })),
    });
  });

  // -------------------------------------------------------------------
  // POST /v2/admin/clients/:inboxId/emerald
  // body: { enabled: bool }
  // Admin-only. Flips the admin-controlled Emerald membership flag on
  // the target client. Emerald overrides the automatic B/S/G tier the
  // backend computes from seats + coverage — see src/billing/tier.ts.
  // Posts a "Admin #N enabled/disabled Emerald membership for Client #M"
  // line to the audit log via pg_notify('audit_event').
  // -------------------------------------------------------------------
  const EmeraldBody = z.object({ enabled: z.boolean() });
  app.post<{ Params: { inboxId: string } }>(
    '/v2/admin/clients/:inboxId/emerald',
    async (req, reply) => {
      const caller = await resolveCaller(req, reply);
      if (!caller) return;
      if (!caller.isAdmin) {
        return reply.code(403).send({ error: 'not_admin' });
      }
      const parsed = EmeraldBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const targetInboxId: string = req.params.inboxId;
      const [target] = await db
        .select({ id: clients.id, clientNumber: clients.clientNumber, current: clients.emeraldMembershipEnabled })
        .from(clients)
        .where(eq(clients.inboxId, targetInboxId))
        .limit(1);
      if (!target) {
        return reply.code(404).send({ error: 'client_not_found' });
      }
      // No-op fast path — don't write or audit if nothing actually
      // changes, so a UI that re-submits doesn't double-log.
      if (target.current === parsed.data.enabled) {
        return reply.code(200).send({
          clientNumber: target.clientNumber,
          emeraldMembershipEnabled: parsed.data.enabled,
          changed: false,
        });
      }
      await db
        .update(clients)
        .set({ emeraldMembershipEnabled: parsed.data.enabled })
        .where(eq(clients.id, target.id));

      // Best-effort audit emit. If admin-number resolution fails
      // (e.g. the caller was just demoted in a race), still return
      // success — the DB change has landed.
      const adminNumber: number | null = await adminNumberForInbox(caller.inboxId);
      if (adminNumber !== null) {
        await emitAuditEvent({
          kind: parsed.data.enabled ? 'emerald_enable' : 'emerald_disable',
          admin_number: adminNumber,
          client_number: target.clientNumber,
        });
      }
      return reply.code(200).send({
        clientNumber: target.clientNumber,
        emeraldMembershipEnabled: parsed.data.enabled,
        changed: true,
      });
    },
  );
}
