// Lightweight migration runner — reads ./migrations/*.sql in lexicographic order
// and applies any not yet recorded in schema_migrations. After SQL migrations
// finish, runs any application-level backfills that need to keep up with
// schema changes (e.g. the deterministic lookup column added in 019).
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client.js';
import { backfillAdminUpgradeLookups } from './backfill-admin-upgrade-lookups.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

async function ensureLogTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function applied(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

async function main() {
  await ensureLogTable();
  const done = await applied();
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (done.has(file)) {
      console.log(`[skip] ${file}`);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[apply] ${file}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  console.log('Migrations complete.');

  // Application-level backfills. These run on every invocation because
  // they're idempotent and the work is bounded by the number of rows
  // that haven't already been backfilled.
  await backfillAdminUpgradeLookups();

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
