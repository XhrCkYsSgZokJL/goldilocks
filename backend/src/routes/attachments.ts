import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { attachments } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { makeStorageProvider } from '../storage/index.js';
import { LighthouseStorageProvider } from '../storage/lighthouse.js';
import { LocalStorageProvider } from '../storage/local.js';

const Query = z.object({
  contentType: z.string().min(1),
  filename: z.string().min(1),
});

interface UploadTicket {
  contentType: string;
  filename: string;
  uploadedBy?: string;
  exp: number;
}

interface LocalUploadTicket {
  objectKey: string;
  contentType: string;
  filename: string;
  uploadedBy?: string;
  exp: number;
}

// These routes are mounted under this prefix (see server.ts).
const API_PREFIX = '/api';

// Absolute API base (origin + prefix) the iOS client reached this server
// at, e.g. https://xxx.trycloudflare.com/api. Derived per-request so the
// local storage provider's URLs track the current tunnel hostname with no
// configuration; PUBLIC_BASE_URL overrides the origin if set.
function attachmentBaseUrl(req: FastifyRequest): string {
  const origin = (config.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`).replace(/\/+$/, '');
  return `${origin}${API_PREFIX}`;
}

export default async function attachmentRoutes(app: FastifyInstance, opts: { publicBaseUrl: string }) {
  const storage = makeStorageProvider(opts.publicBaseUrl);

  // GET /v2/attachments/presigned?contentType=...&filename=...
  app.get('/v2/attachments/presigned', { preHandler: requireJwt }, async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
    }
    const { contentType, filename } = parsed.data;

    const result = await storage.presignedUpload(
      { contentType, filename, uploadedBy: req.deviceId },
      attachmentBaseUrl(req),
    );

    return reply.code(200).send({
      objectKey: result.objectKey,
      uploadUrl: result.uploadUrl,
      assetUrl: result.assetUrl,
    });
  });

  // POST /v2/assets/renew-batch
  const RenewBody = z.object({ assetKeys: z.array(z.string()).max(1000) });
  app.post('/v2/assets/renew-batch', { preHandler: requireJwt }, async (req, reply) => {
    const parsed = RenewBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const results = await storage.renew(parsed.data.assetKeys);
    const renewed = results.filter((r) => r.success).length;
    const failed = results.length - renewed;
    return reply.code(200).send({ renewed, failed, results });
  });

  // PUT /v2/_mock-upload/:objectKey  — used by the mock storage provider
  app.put<{ Params: { objectKey: string } }>('/v2/_mock-upload/:objectKey', async (req, reply) => {
    // Discard body. In real use we'd write to disk or stream to storage.
    return reply.code(200).send({});
  });

  // GET /v2/_mock-asset/:objectKey  — used by the mock storage provider
  app.get<{ Params: { objectKey: string } }>('/v2/_mock-asset/:objectKey', async (req, reply) => {
    return reply.code(200).send({ note: 'mock asset, real bytes not stored' });
  });

  // PUT /v2/_lighthouse-upload?ticket=...  — proxy upload for LighthouseStorageProvider
  app.put('/v2/_lighthouse-upload', async (req: FastifyRequest, reply) => {
    const ticketParam = (req.query as Record<string, unknown>)['ticket'];
    if (typeof ticketParam !== 'string' || !ticketParam) {
      return reply.code(400).send({ error: 'missing_ticket' });
    }
    let ticket: UploadTicket;
    try {
      ticket = jwt.verify(ticketParam, config.JWT_SECRET, { algorithms: ['HS256'] }) as UploadTicket;
    } catch {
      return reply.code(401).send({ error: 'invalid_ticket' });
    }

    if (!(storage instanceof LighthouseStorageProvider)) {
      return reply.code(400).send({ error: 'lighthouse_not_active' });
    }

    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return reply.code(400).send({ error: 'empty_body' });
    }

    const { objectKey, assetUrl } = await storage.uploadBytes({
      bytes: buf,
      filename: ticket.filename,
      contentType: ticket.contentType,
    });

    await db
      .insert(attachments)
      .values({
        objectKey,
        uploadedBy: ticket.uploadedBy ?? null,
        contentType: ticket.contentType,
        filename: ticket.filename,
        assetUrl,
      })
      .onConflictDoNothing();

    // Keep `cid` in the response — existing iOS callers read that name;
    // it's just the lighthouse CID by another name.
    return reply.code(200).send({ cid: objectKey, assetUrl });
  });

  // PUT /v2/_local-upload?ticket=...  — upload handler for LocalStorageProvider
  app.put('/v2/_local-upload', async (req: FastifyRequest, reply) => {
    const ticketParam = (req.query as Record<string, unknown>)['ticket'];
    if (typeof ticketParam !== 'string' || !ticketParam) {
      return reply.code(400).send({ error: 'missing_ticket' });
    }
    let ticket: LocalUploadTicket;
    try {
      ticket = jwt.verify(ticketParam, config.JWT_SECRET, { algorithms: ['HS256'] }) as LocalUploadTicket;
    } catch {
      return reply.code(401).send({ error: 'invalid_ticket' });
    }

    if (!(storage instanceof LocalStorageProvider)) {
      return reply.code(400).send({ error: 'local_storage_not_active' });
    }

    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return reply.code(400).send({ error: 'empty_body' });
    }

    await storage.writeBytes(ticket.objectKey, buf);
    const assetUrl = storage.assetUrlFor(attachmentBaseUrl(req), ticket.objectKey);

    await db
      .insert(attachments)
      .values({
        objectKey: ticket.objectKey,
        uploadedBy: ticket.uploadedBy ?? null,
        contentType: ticket.contentType,
        filename: ticket.filename,
        assetUrl,
      })
      .onConflictDoNothing();

    return reply.code(200).send({ cid: ticket.objectKey, objectKey: ticket.objectKey, assetUrl });
  });

  // GET /v2/_local-asset/:objectKey  — serve handler for LocalStorageProvider.
  // Unauthenticated and rate-limit-exempt: bytes are end-to-end encrypted and
  // the object key is unguessable, and one chat screen can request many
  // assets at once.
  app.get<{ Params: { objectKey: string } }>(
    '/v2/_local-asset/:objectKey',
    { config: { rateLimit: false } },
    async (req, reply) => {
      const { objectKey } = req.params;
      if (!LocalStorageProvider.isValidObjectKey(objectKey)) {
        return reply.code(400).send({ error: 'invalid_object_key' });
      }
      if (!(storage instanceof LocalStorageProvider)) {
        return reply.code(400).send({ error: 'local_storage_not_active' });
      }

      const bytes = await storage.readBytes(objectKey);
      if (!bytes) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const rows = await db
        .select({ contentType: attachments.contentType })
        .from(attachments)
        .where(eq(attachments.objectKey, objectKey))
        .limit(1);
      const contentType = rows[0]?.contentType ?? 'application/octet-stream';

      return reply
        .header('Content-Type', contentType)
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .send(bytes);
    },
  );
}
