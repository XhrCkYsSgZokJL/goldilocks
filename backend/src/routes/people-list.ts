// Encrypted people-list storage.
//
//   GET  /v2/me/people-list                       the caller's blob.
//   PUT  /v2/me/people-list                       replace it.
//   GET  /v2/admin/clients/:inboxId/people-list   admin: any client's blob.
//   PUT  /v2/admin/clients/:inboxId/people-list   admin: replace it.
//
// The blob is an AES-256-GCM ciphertext of the client's people list
// (member names, emails, plan tiers, enable/disable flags). The
// backend never holds the key — it lives in the Advisory group's
// MLS-encrypted metadata on members' devices — so this table is opaque
// to anyone who only has database access. Admins can read and write a
// client's blob too; they decrypt with that client's Advisory key,
// which they hold by being a member of the group.
//
// Every successful write fires a `people_list_changed` NOTIFY so the
// agent can re-evaluate the members' third-party onboarding.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { adminInboxes, clients, clientPeopleList, devices } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { adminNumberForInbox, emitAuditEvent } from '../audit-events.js';

const PutBody = z.object({
  ciphertext: z.string().min(1).max(1_000_000),
  salt: z.string().min(1).max(1024),
  nonce: z.string().min(1).max(1024),
  // The version the caller edited. 0 means "I believe there is no list
  // yet." The write is rejected if the stored version differs.
  baseVersion: z.number().int().min(0),
});

// Optional hint the iOS admin client tags on an admin-side people-list
// write so the backend can post a generic narrative line ("Admin #N
// enabled someone on Client #M") to the audit log. The hint is
// deliberately identity-free — the encrypted blob is opaque to the
// backend, and the audit shouldn't expose who was toggled. Omit the
// hint for non-enable/disable writes (initial save, reorder, etc.) to
// keep the audit log signal-to-noise high.
const AdminPutBody = PutBody.extend({
  auditHint: z.object({
    action: z.enum(['enable_person', 'disable_person']),
  }).optional(),
});

interface BlobResponse {
  version: number;
  ciphertext: string | null;
  salt: string | null;
  nonce: string | null;
}

// Read a client's people-list blob, or an empty shell (version 0).
async function fetchBlob(clientId: string): Promise<BlobResponse> {
  const [row] = await db
    .select()
    .from(clientPeopleList)
    .where(eq(clientPeopleList.clientId, clientId))
    .limit(1);
  if (!row) {
    return { version: 0, ciphertext: null, salt: null, nonce: null };
  }
  return { version: row.version, ciphertext: row.ciphertext, salt: row.salt, nonce: row.nonce };
}

// Replace a client's blob, optimistic-concurrency on `baseVersion`. On a
// successful write, fires `people_list_changed` so the agent re-checks
// the members' onboarding.
async function writeBlob(
  clientId: string,
  body: z.infer<typeof PutBody>,
): Promise<{ ok: true; version: number } | { ok: false; currentVersion: number }> {
  const nextVersion = body.baseVersion + 1;
  const written = await db
    .insert(clientPeopleList)
    .values({
      clientId,
      ciphertext: body.ciphertext,
      salt: body.salt,
      nonce: body.nonce,
      version: nextVersion,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: clientPeopleList.clientId,
      set: {
        ciphertext: body.ciphertext,
        salt: body.salt,
        nonce: body.nonce,
        version: nextVersion,
        updatedAt: new Date(),
      },
      where: eq(clientPeopleList.version, body.baseVersion),
    })
    .returning({ version: clientPeopleList.version });

  if (written.length === 0) {
    const [current] = await db
      .select({ version: clientPeopleList.version })
      .from(clientPeopleList)
      .where(eq(clientPeopleList.clientId, clientId))
      .limit(1);
    return { ok: false, currentVersion: current?.version ?? 0 };
  }

  const payload = JSON.stringify({ client_id: clientId });
  await db.execute(sql`SELECT pg_notify('people_list_changed', ${payload})`);

  return { ok: true, version: nextVersion };
}

// Resolve the caller's own clientId from their device's bound inbox.
// Sends the error response itself and returns null on any failure.
async function resolveClientId(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
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
    reply.code(409).send({ error: 'client_missing' });
    return null;
  }
  return client.id;
}

interface AdminTarget {
  clientId: string;
  clientNumber: number;
  adminInboxId: string;
}

// Confirm the caller is an admin, then resolve the target client's id
// from their inbox id. Sends the error response itself, returns null.
async function resolveTargetForAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  targetInboxId: string,
): Promise<AdminTarget | null> {
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
  const [adminRow] = await db
    .select()
    .from(adminInboxes)
    .where(and(eq(adminInboxes.inboxId, device.inboxId), eq(adminInboxes.disabled, false)))
    .limit(1);
  if (!adminRow) {
    reply.code(403).send({ error: 'not_admin' });
    return null;
  }
  const [client] = await db.select().from(clients).where(eq(clients.inboxId, targetInboxId)).limit(1);
  if (!client) {
    reply.code(404).send({ error: 'client_not_found' });
    return null;
  }
  return { clientId: client.id, clientNumber: client.clientNumber, adminInboxId: device.inboxId };
}

export default async function peopleListRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireJwt);

  // GET /v2/me/people-list — { version, ciphertext, salt, nonce }.
  app.get('/v2/me/people-list', async (req, reply) => {
    const clientId = await resolveClientId(req, reply);
    if (!clientId) return;
    return reply.code(200).send(await fetchBlob(clientId));
  });

  // PUT /v2/me/people-list — { version }, or 409 on a stale write.
  app.put('/v2/me/people-list', async (req, reply) => {
    const clientId = await resolveClientId(req, reply);
    if (!clientId) return;
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const result = await writeBlob(clientId, parsed.data);
    if (!result.ok) {
      return reply.code(409).send({ error: 'version_conflict', currentVersion: result.currentVersion });
    }
    return reply.code(200).send({ version: result.version });
  });

  // GET /v2/admin/clients/:inboxId/people-list — admin reads any client's blob.
  app.get<{ Params: { inboxId: string } }>(
    '/v2/admin/clients/:inboxId/people-list',
    async (req, reply) => {
      const target = await resolveTargetForAdmin(req, reply, req.params.inboxId);
      if (!target) return;
      return reply.code(200).send(await fetchBlob(target.clientId));
    },
  );

  // PUT /v2/admin/clients/:inboxId/people-list — admin replaces a client's blob.
  // Accepts an optional `auditHint` so the iOS admin client can tag the
  // write as a per-person enable / disable, producing a corresponding
  // narrative line in the audit log.
  app.put<{ Params: { inboxId: string } }>(
    '/v2/admin/clients/:inboxId/people-list',
    async (req, reply) => {
      const target = await resolveTargetForAdmin(req, reply, req.params.inboxId);
      if (!target) return;
      const parsed = AdminPutBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const result = await writeBlob(target.clientId, parsed.data);
      if (!result.ok) {
        return reply.code(409).send({ error: 'version_conflict', currentVersion: result.currentVersion });
      }
      if (parsed.data.auditHint) {
        const adminNumber: number | null = await adminNumberForInbox(target.adminInboxId);
        if (adminNumber !== null) {
          await emitAuditEvent({
            kind: parsed.data.auditHint.action === 'enable_person' ? 'people_enable' : 'people_disable',
            admin_number: adminNumber,
            client_number: target.clientNumber,
          });
        }
      }
      return reply.code(200).send({ version: result.version });
    },
  );
}
