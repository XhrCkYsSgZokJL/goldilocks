import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => {
    let dbOk = false;
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return { ok: true, db: dbOk, ts: new Date().toISOString() };
  });
}
