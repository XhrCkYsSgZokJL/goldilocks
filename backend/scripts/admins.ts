// Goldilocks admin management CLI.
//
//   npm run admins                  interactive menu
//   npm run admins -- list          print the admin registry and exit
//   npm run admins -- add morgan    create an admin slot named "morgan"
//   npm run admins -- remove 2      delete admin #2 (or: remove morgan)
//   npm run admins -- disable 2     revoke admin #2 (their phone auto-downgrades)
//   npm run admins -- enable 2      re-enable admin #2
//
// Each admin slot carries a uniquely-generated 10-digit upgrade code.
// Hand that code to the person — they install the app, register as a
// client, then enter the code in the iOS debug area ("Upgrade to Admin")
// to claim the slot.
//
// Every add / remove / enable / disable mutates `admin_inboxes`, which
// fires the `admin_changed` NOTIFY (trigger from migration 003). The
// goldilocks-agent reconciles cross-admin group + Advisory membership off
// that notification, and the iOS app re-checks `/v2/me` on each launch —
// so disabling a slot here auto-downgrades that person's phone the next
// time it checks in.

import 'dotenv/config';
import { randomInt } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pg from 'pg';

const { Client } = pg;

interface AdminRow {
  id: string;
  name: string;
  upgrade_code: string;
  inbox_id: string | null;
  disabled: boolean;
}

async function loadAdmins(client: pg.Client): Promise<AdminRow[]> {
  const res = await client.query<AdminRow>(
    `SELECT id, name, upgrade_code, inbox_id, disabled
       FROM admin_inboxes
       ORDER BY created_at ASC`,
  );
  return res.rows;
}

function printAdmins(admins: AdminRow[]): void {
  console.log('\nGoldilocks admins:');
  if (admins.length === 0) {
    console.log('  (none yet — use "add <name>")');
    return;
  }
  admins.forEach((a, i) => {
    const num = String(i + 1).padStart(2, ' ');
    const status = a.disabled ? 'DISABLED' : 'enabled ';
    const name = a.name.padEnd(16, ' ');
    const claimed = a.inbox_id ? `claimed ${a.inbox_id.slice(0, 12)}…` : 'unclaimed';
    console.log(`  [${num}] ${status}  ${name} code ${a.upgrade_code}  ${claimed}`);
  });
}

function generateCode(): string {
  // 10-digit numeric — matches the iOS debug area's numpad entry field.
  return String(randomInt(0, 10_000_000_000)).padStart(10, '0');
}

async function uniqueCode(client: pg.Client): Promise<string> {
  for (let i = 0; i < 25; i += 1) {
    const code = generateCode();
    const res = await client.query('SELECT 1 FROM admin_inboxes WHERE upgrade_code = $1', [code]);
    if (res.rows.length === 0) return code;
  }
  throw new Error('could not generate a unique upgrade code');
}

// Map a comma-separated selection ("2", "1,3", "morgan", "all") onto rows.
function resolveTargets(arg: string, admins: AdminRow[]): AdminRow[] {
  if (arg.trim().toLowerCase() === 'all') return [...admins];
  const targets: AdminRow[] = [];
  for (const raw of arg.split(',')) {
    const piece = raw.trim();
    if (!piece) continue;
    const idx = Number.parseInt(piece, 10);
    const byIndex = Number.isInteger(idx) && String(idx) === piece ? admins[idx - 1] : undefined;
    const row = byIndex ?? admins.find((a) => a.name.toLowerCase() === piece.toLowerCase());
    if (!row) {
      console.log(`  ! no admin matches "${piece}"`);
    } else if (!targets.includes(row)) {
      targets.push(row);
    }
  }
  return targets;
}

async function addAdmin(client: pg.Client, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    console.log('  ! a name is required, e.g. "add morgan"');
    return;
  }
  const code = await uniqueCode(client);
  await client.query('INSERT INTO admin_inboxes (name, upgrade_code) VALUES ($1, $2)', [
    trimmed,
    code,
  ]);
  console.log(`\n  + added admin "${trimmed}"`);
  console.log(`    upgrade code: ${code}`);
  console.log('    hand this to the person; they enter it in the app to become admin.');
}

async function removeAdmins(client: pg.Client, rows: AdminRow[]): Promise<void> {
  for (const r of rows) {
    await client.query('DELETE FROM admin_inboxes WHERE id = $1', [r.id]);
    console.log(`  - removed "${r.name}" (code ${r.upgrade_code} is now dead)`);
  }
}

async function setDisabled(client: pg.Client, rows: AdminRow[], disabled: boolean): Promise<void> {
  for (const r of rows) {
    await client.query('UPDATE admin_inboxes SET disabled = $1 WHERE id = $2', [disabled, r.id]);
    console.log(`  ${disabled ? 'disabled' : 'enabled '} "${r.name}"`);
  }
}

const USAGE = [
  'Commands:',
  '  add <name>        create an admin slot + generate an upgrade code',
  '  remove <sel>      delete admin slot(s)            (alias: rm)',
  '  disable <sel>     revoke admin(s)                 (alias: off)',
  '  enable <sel>      re-enable admin(s)              (alias: on)',
  '  list              re-print the registry           (alias: r)',
  '  quit              exit                            (alias: q)',
  '',
  '  <sel> is a comma-separated list of numbers or names, or "all".',
].join('\n');

// Run one verb. Returns false when the verb means "stop the loop".
async function runCommand(
  client: pg.Client,
  rl: readline.Interface | null,
  verb: string,
  arg: string,
  admins: AdminRow[],
): Promise<boolean> {
  switch (verb) {
    case 'add':
    case 'a':
      await addAdmin(client, arg);
      return true;
    case 'remove':
    case 'rm': {
      const rows = resolveTargets(arg, admins);
      if (rows.length === 0) {
        console.log('  nothing selected');
        return true;
      }
      if (rl) {
        const names = rows.map((r) => `"${r.name}"`).join(', ');
        const yn = (await rl.question(`  permanently delete ${names}? (y/N): `)).trim().toLowerCase();
        if (yn !== 'y' && yn !== 'yes') {
          console.log('  cancelled');
          return true;
        }
      }
      await removeAdmins(client, rows);
      console.log('  → admin_changed fired; the agent will reconcile membership.');
      return true;
    }
    case 'disable':
    case 'off': {
      const rows = resolveTargets(arg, admins);
      if (rows.length === 0) {
        console.log('  nothing selected');
        return true;
      }
      await setDisabled(client, rows, true);
      console.log('  → admin_changed fired; disabled phones auto-downgrade on next check-in.');
      return true;
    }
    case 'enable':
    case 'on': {
      const rows = resolveTargets(arg, admins);
      if (rows.length === 0) {
        console.log('  nothing selected');
        return true;
      }
      await setDisabled(client, rows, false);
      console.log('  → admin_changed fired; the agent will reconcile membership.');
      return true;
    }
    case 'list':
    case 'l':
    case 'r':
      // The caller re-prints the (reloaded) list after every command.
      return true;
    case 'quit':
    case 'exit':
    case 'q':
    case '':
      return false;
    default:
      console.log(`  ! unknown command: "${verb}"`);
      console.log(USAGE);
      return true;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — check your .env');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  const argv = process.argv.slice(2);

  try {
    if (argv.length > 0) {
      // One-shot mode: `npm run admins -- <verb> <arg...>`. No confirm
      // prompt — passing the command is the confirmation.
      const verb = argv[0].toLowerCase();
      const arg = argv.slice(1).join(' ');
      const admins = await loadAdmins(client);
      await runCommand(client, null, verb, arg, admins);
      printAdmins(await loadAdmins(client));
      return;
    }

    // Interactive mode.
    const rl = readline.createInterface({ input, output });
    try {
      console.log('Goldilocks admin management.');
      console.log(USAGE);
      for (;;) {
        printAdmins(await loadAdmins(client));
        const line = (await rl.question('\n> ')).trim();
        const space = line.indexOf(' ');
        const verb = (space === -1 ? line : line.slice(0, space)).toLowerCase();
        const arg = space === -1 ? '' : line.slice(space + 1);
        const admins = await loadAdmins(client);
        const keepGoing = await runCommand(client, rl, verb, arg, admins);
        if (!keepGoing) break;
      }
    } finally {
      rl.close();
    }
  } finally {
    await client.end();
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('admins CLI error:', err);
  process.exit(1);
});
