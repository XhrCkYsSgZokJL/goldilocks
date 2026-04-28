import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { attachments } from '../db/schema.js';
import { requireJwt } from '../middleware/jwt.js';
import { makeStorageProvider } from '../storage/index.js';
import { LighthouseStorageProvider } from '../storage/lighthouse.js';

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

export default async function attachmentRoutes(app: FastifyInstance, opts: { publicBaseUrl: string }) {
  const storage = makeStorageProvider(opts.publicBaseUrl);

  // GET /v2/attachments/presigned?contentType=...&filename=...
  app.get('/v2/attachments/presigned', { preHandler: requireJwt }, async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
    }
    const { contentType, filename } = parsed.data;

    const result = await storage.presignedUpload({
      contentType,
      filename,
      uploadedBy: req.deviceId,
    });

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

    const { cid, assetUrl } = await storage.uploadBytes(buf, ticket.filename);

    await db
      .insert(attachments)
      .values({
        objectKey: cid,
        uploadedBy: ticket.uploadedBy ?? null,
        contentType: ticket.contentType,
        filename: ticket.filename,
        assetUrl,
      })
      .onConflictDoNothing();

    return reply.code(200).send({ cid, assetUrl });
  });
}
