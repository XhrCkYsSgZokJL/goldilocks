import { config as loadEnv } from 'dotenv';
import { randomInt } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { decryptAtRest, encryptAtRest, isEncryptedAtRest } from '../src/crypto/at-rest.js';
import { lookupHash } from '../src/crypto/lookup-hash.js';

const ADMIN_UPGRADE_CODE_LABEL = 'admin_inboxes.upgrade_code';
const ADMIN_UPGRADE_CODE_LOOKUP_LABEL = 'admin_inboxes.upgrade_code.lookup';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');
const ENV = (process.env.GOLDILOCKS_ENV ?? 'dev') as 'dev' | 'prod';
loadEnv({ path: join(REPO_ROOT, `.env.${ENV}`) });

function decodeUpgradeCode(stored: string): string {
  return isEncryptedAtRest(stored) ? decryptAtRest(stored, ADMIN_UPGRADE_CODE_LABEL) : stored;
}

function encodeUpgradeCode(plain: string): { stored: string; lookup: string } {
  const shouldEncrypt = process.env.ENCRYPT_AT_REST_V1 === 'true';
  const stored = shouldEncrypt ? encryptAtRest(plain, ADMIN_UPGRADE_CODE_LABEL) : plain;
  const lookup = lookupHash(plain, ADMIN_UPGRADE_CODE_LOOKUP_LABEL);
  return { stored, lookup };
}

function generateCode(): string {
  const half = (): string => String(randomInt(0, 100_000_000)).padStart(8, '0');
  return `${half()}${half()}`;
}

function formatCode(code: string): string {
  return code.replace(/\D/g, '').replace(/(.{4})(?=.)/g, '$1-');
}

async function uniqueCode(client: pg.Client): Promise<string> {
  for (let i = 0; i < 25; i += 1) {
    const code = generateCode();
    const hash = lookupHash(code, ADMIN_UPGRADE_CODE_LOOKUP_LABEL);
    const res = await client.query(
      'SELECT 1 FROM admin_inboxes WHERE upgrade_code_lookup = $1',
      [hash],
    );
    if (res.rows.length === 0) return code;
  }
  throw new Error('could not generate a unique upgrade code');
}

interface AdminRow {
  id: string;
  name: string;
  upgrade_code: string;
  inbox_id: string | null;
}

async function listAdmins(client: pg.Client): Promise<void> {
  const res = await client.query<AdminRow>(
    'SELECT id, name, upgrade_code, inbox_id FROM admin_inboxes ORDER BY created_at ASC',
  );
  const admins = res.rows.map((row) => ({
    ...row,
    upgrade_code: decodeUpgradeCode(row.upgrade_code),
  }));
  console.log('Admin slots');
  if (admins.length === 0) {
    console.log('  (none)');
    return;
  }
  for (let i = 0; i < admins.length; i += 1) {
    const a = admins[i]!;
    const num = String(i + 1).padStart(2, ' ');
    const name = a.name.padEnd(16, ' ');
    const claimed = a.inbox_id ? `claimed ${a.inbox_id.slice(0, 12)}…` : 'unclaimed';
    console.log(`  [${num}] ${name} code ${formatCode(a.upgrade_code)}  ${claimed}`);
  }
}

async function addAdmin(client: pg.Client, name: string): Promise<void> {
  const code = await uniqueCode(client);
  const { stored, lookup } = encodeUpgradeCode(code);
  await client.query(
    'INSERT INTO admin_inboxes (name, upgrade_code, upgrade_code_lookup) VALUES ($1, $2, $3)',
    [name, stored, lookup],
  );
  console.log(`Added admin slot "${name}"`);
  console.log(`Upgrade code: ${formatCode(code)}`);
}

async function removeAdmin(client: pg.Client, name: string): Promise<void> {
  const res = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM admin_inboxes WHERE name = $1',
    [name],
  );
  const row = res.rows[0];
  if (!row) {
    console.error(`No admin slot named "${name}"`);
    process.exit(1);
  }
  await client.query('DELETE FROM admin_inboxes WHERE id = $1', [row.id]);
  console.log(`Removed admin slot "${name}"`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const name = process.argv[3];

  if (!command || !['list', 'add', 'remove'].includes(command)) {
    console.error('Usage: ./dev/admins <command>\n');
    console.error('Commands:');
    console.error('  list               List all admin slots');
    console.error('  add <name>         Add an admin slot (prints upgrade code)');
    console.error('  remove <name>      Remove an admin slot');
    process.exit(1);
  }

  if ((command === 'add' || command === 'remove') && !name) {
    console.error(`Usage: ./dev/admins ${command} <name>`);
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL not set (check .env.' + ENV + ')');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    if (command === 'list') await listAdmins(client);
    else if (command === 'add') await addAdmin(client, name!);
    else if (command === 'remove') await removeAdmin(client, name!);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
