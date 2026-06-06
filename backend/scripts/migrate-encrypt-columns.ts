// One-shot migration that re-writes every plaintext value in the
// at-rest-encrypted columns through the drizzle codec, so the column
// rollout doesn't have to wait for organic writes.
//
// Idempotent: rows whose value already carries the v1. envelope are
// skipped. Safe to run multiple times and safe to interrupt — every
// row is its own transaction.
//
// Usage:
//   npm run migrate-encrypt-columns               # all target columns
//   npm run migrate-encrypt-columns -- --dry-run  # report counts only
//
// Hooked into the goldilocks CLI as
//   Settings → Keys → Encrypt remaining plaintext columns.
//
// Design: docs/encryption-and-backup-plan.md F4.

import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { isEncryptedAtRest, encryptAtRest } from '../src/crypto/at-rest.js';

interface ColumnTarget {
  table: string;
  column: string;
  label: string; // must match the label used in src/db/schema.ts
}

const TARGETS: readonly ColumnTarget[] = [
  { table: 'server_agents', column: 'private_key_hex', label: 'server_agents.private_key_hex' },
  { table: 'admin_inboxes', column: 'upgrade_code', label: 'admin_inboxes.upgrade_code' },
  { table: 'clients', column: 'stripe_customer_id', label: 'clients.stripe_customer_id' },
  { table: 'billing_checkouts', column: 'stripe_session_id', label: 'billing_checkouts.stripe_session_id' },
  { table: 'billing_checkouts', column: 'stripe_payment_intent_id', label: 'billing_checkouts.stripe_payment_intent_id' },
  { table: 'devices', column: 'push_token', label: 'devices.push_token' },
  // Migration 017 moved hmac_keys from jsonb to text. Existing rows hold
  // plaintext JSON arrays (`[...]`); the codec stringifies on write,
  // parses on read. encryptAtRest treats the JSON text the same as any
  // other UTF-8 string.
  { table: 'subscriptions', column: 'hmac_keys', label: 'subscriptions.hmac_keys' },
] as const;

const DRY_RUN = process.argv.includes('--dry-run');

interface PgRow {
  pk: string | number;
  val: string | null;
}

// Determine the primary-key column for a table by inspecting Postgres
// system catalogs. We do this dynamically so the script doesn't need
// to be updated when new columns are added.
async function primaryKeyColumn(table: string): Promise<string> {
  const result = await db.execute<{ attname: string }>(sql`
    SELECT a.attname
    FROM   pg_index i
    JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE  i.indrelid = ${sql.raw(`'${table}'::regclass`)}
    AND    i.indisprimary
    LIMIT  1
  `);
  const rows = result.rows ?? [];
  const first = rows[0];
  if (!first) {
    throw new Error(`no primary key found for ${table}`);
  }
  return first.attname;
}

async function migrateColumn(target: ColumnTarget): Promise<void> {
  const { table, column, label } = target;
  const pkCol = await primaryKeyColumn(table);

  // Pull every row where the column is non-null and doesn't already
  // carry the v1 envelope. The LIKE pattern is the fastest filter that
  // doesn't need a regex index.
  const fetch = await db.execute<PgRow>(sql`
    SELECT ${sql.raw(`"${pkCol}"`)} AS pk,
           ${sql.raw(`"${column}"`)} AS val
    FROM   ${sql.raw(`"${table}"`)}
    WHERE  ${sql.raw(`"${column}"`)} IS NOT NULL
    AND    ${sql.raw(`"${column}"`)} NOT LIKE 'v1.%'
  `);

  const rows = (fetch.rows ?? []).filter((r) => r.val !== null && !isEncryptedAtRest(r.val));
  if (rows.length === 0) {
    console.log(`  ${table}.${column}: already encrypted (no plaintext rows).`);
    return;
  }

  if (DRY_RUN) {
    console.log(`  ${table}.${column}: ${rows.length} plaintext row(s) would be encrypted.`);
    return;
  }

  let encrypted = 0;
  for (const row of rows) {
    const plain = row.val;
    if (plain === null) continue;
    const ct = encryptAtRest(plain, label);
    await db.execute(sql`
      UPDATE ${sql.raw(`"${table}"`)}
      SET    ${sql.raw(`"${column}"`)} = ${ct}
      WHERE  ${sql.raw(`"${pkCol}"`)} = ${row.pk}
      AND    ${sql.raw(`"${column}"`)} = ${plain}
    `);
    encrypted++;
  }
  console.log(`  ${table}.${column}: encrypted ${encrypted}/${rows.length} row(s).`);
}

async function main(): Promise<void> {
  // The codec also encrypts on writes when the flag is on. Either way
  // works for the script (we're calling encryptAtRest directly), but
  // surface a clear note so the operator knows the configuration.
  if (process.env.ENCRYPT_AT_REST_V1 !== 'true') {
    console.log(
      '[migrate-encrypt-columns] note: ENCRYPT_AT_REST_V1 is not "true" — ' +
        'this script will encrypt existing plaintext, but new writes will ' +
        'stay plaintext until you flip the flag.',
    );
  }

  if (DRY_RUN) console.log('[migrate-encrypt-columns] DRY RUN — no writes.');
  console.log('[migrate-encrypt-columns] scanning target columns:');

  for (const target of TARGETS) {
    try {
      await migrateColumn(target);
    } catch (err) {
      console.error(`  ${target.table}.${target.column}: ${(err as Error).message}`);
      // Don't abort the whole run — one broken table shouldn't stop
      // the others.
    }
  }

  console.log('[migrate-encrypt-columns] done.');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end().finally(() => process.exit(1));
  });
