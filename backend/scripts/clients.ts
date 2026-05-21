// Goldilocks client subscription management CLI.
//
//   npm run clients                     interactive menu
//   npm run clients -- list             print every client + their plan
//   npm run clients -- tier 5 active    put client #5 on the Active plan
//   npm run clients -- tier 5 none      clear client #5's plan
//   npm run clients -- custom 5 on      unlock the Custom tier for #5
//   npm run clients -- approve 5        apply #5's pending plan request
//   npm run clients -- deny 5           discard #5's pending request
//
// Clients pick a plan in the iOS Settings screen; the choice lands in
// `requested_tier` as a pending request — it does not change the active
// plan. `approve` copies the request into `subscription_tier`. The Custom
// tier ($199/hr) is gated: a client can only request or be placed on it
// once `custom` has been turned on for them here.

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pg from 'pg';

const { Client } = pg;

type Tier = 'light' | 'active' | 'custom';
const TIERS: readonly Tier[] = ['light', 'active', 'custom'];

interface ClientRow {
  id: string;
  client_number: number;
  subscription_tier: Tier | null;
  requested_tier: string | null; // a Tier, or 'none' (requested no plan)
  custom_tier_enabled: boolean;
}

async function loadClients(client: pg.Client): Promise<ClientRow[]> {
  const res = await client.query<ClientRow>(
    `SELECT id, client_number, subscription_tier, requested_tier, custom_tier_enabled
       FROM clients
       ORDER BY client_number ASC`,
  );
  return res.rows;
}

function printClients(rows: ClientRow[]): void {
  console.log('\nGoldilocks clients:');
  if (rows.length === 0) {
    console.log('  (no clients registered yet)');
    return;
  }
  for (const c of rows) {
    const num = `#${c.client_number}`.padEnd(6, ' ');
    const tier = (c.subscription_tier ?? 'no plan').padEnd(8, ' ');
    const custom = c.custom_tier_enabled ? 'custom:on ' : 'custom:off';
    const reqLabel = c.requested_tier === 'none' ? 'no plan' : c.requested_tier;
    const pending = c.requested_tier ? `   → requested: ${reqLabel}` : '';
    console.log(`  ${num} ${tier}  ${custom}${pending}`);
  }
}

// Map a comma/space-separated selection ("5", "1,2", "all") onto rows by
// their client number.
function resolveTargets(arg: string, rows: ClientRow[]): ClientRow[] {
  if (arg.trim().toLowerCase() === 'all') return [...rows];
  const targets: ClientRow[] = [];
  for (const raw of arg.split(',')) {
    const piece = raw.trim().replace(/^#/, '');
    if (!piece) continue;
    const num = Number.parseInt(piece, 10);
    const row = Number.isInteger(num) ? rows.find((r) => r.client_number === num) : undefined;
    if (!row) {
      console.log(`  ! no client #${piece}`);
    } else if (!targets.includes(row)) {
      targets.push(row);
    }
  }
  return targets;
}

async function setTier(client: pg.Client, rows: ClientRow[], value: string): Promise<void> {
  const tier = value.toLowerCase();
  if (tier !== 'none' && !(TIERS as readonly string[]).includes(tier)) {
    console.log('  ! tier must be one of: light, active, custom, none');
    return;
  }
  for (const r of rows) {
    if (tier === 'none') {
      await client.query(
        'UPDATE clients SET subscription_tier = NULL, requested_tier = NULL WHERE id = $1',
        [r.id],
      );
      console.log(`  #${r.client_number} → no plan`);
    } else if (tier === 'custom') {
      // You can't be on Custom without it being unlocked.
      await client.query(
        `UPDATE clients
           SET subscription_tier = 'custom', custom_tier_enabled = true, requested_tier = NULL
           WHERE id = $1`,
        [r.id],
      );
      console.log(`  #${r.client_number} → custom (Custom unlocked)`);
    } else {
      await client.query(
        'UPDATE clients SET subscription_tier = $1, requested_tier = NULL WHERE id = $2',
        [tier, r.id],
      );
      console.log(`  #${r.client_number} → ${tier}`);
    }
  }
}

async function setCustom(client: pg.Client, rows: ClientRow[], value: string): Promise<void> {
  const on = ['on', 'true', 'yes', '1'].includes(value.toLowerCase());
  const off = ['off', 'false', 'no', '0'].includes(value.toLowerCase());
  if (!on && !off) {
    console.log('  ! custom must be "on" or "off"');
    return;
  }
  for (const r of rows) {
    if (on) {
      await client.query('UPDATE clients SET custom_tier_enabled = true WHERE id = $1', [r.id]);
      console.log(`  #${r.client_number} Custom unlocked`);
    } else {
      // Locking Custom also drops the client off the Custom plan so the
      // "on Custom ⇒ Custom unlocked" invariant holds.
      await client.query(
        `UPDATE clients
           SET custom_tier_enabled = false,
               subscription_tier = CASE WHEN subscription_tier = 'custom'
                                        THEN NULL ELSE subscription_tier END
           WHERE id = $1`,
        [r.id],
      );
      console.log(`  #${r.client_number} Custom locked`);
    }
  }
}

async function resolveRequest(client: pg.Client, rows: ClientRow[], approve: boolean): Promise<void> {
  for (const r of rows) {
    if (!r.requested_tier) {
      console.log(`  #${r.client_number} has no pending request`);
      continue;
    }
    if (approve) {
      const enableCustom = r.requested_tier === 'custom';
      await client.query(
        `UPDATE clients
           SET subscription_tier = CASE WHEN requested_tier = 'none'
                                        THEN NULL ELSE requested_tier END,
               custom_tier_enabled = custom_tier_enabled OR $2,
               requested_tier = NULL
           WHERE id = $1`,
        [r.id, enableCustom],
      );
      const approved = r.requested_tier === 'none' ? 'no plan' : r.requested_tier;
      console.log(`  #${r.client_number} approved → ${approved}`);
    } else {
      await client.query('UPDATE clients SET requested_tier = NULL WHERE id = $1', [r.id]);
      console.log(`  #${r.client_number} request denied (was ${r.requested_tier})`);
    }
  }
}

const USAGE = [
  'Commands:',
  '  tier <sel> <light|active|custom|none>   set a client\'s plan directly',
  '  custom <sel> <on|off>                  unlock / lock the Custom tier',
  '  approve <sel>                          apply a pending plan request',
  '  deny <sel>                             discard a pending plan request',
  '  list                                   re-print the roster      (alias: r)',
  '  quit                                   exit                     (alias: q)',
  '',
  '  <sel> is comma- or space-separated client numbers, or "all".',
].join('\n');

// Run one verb. Returns false when the verb means "stop the loop".
async function runCommand(
  client: pg.Client,
  verb: string,
  args: string[],
  rows: ClientRow[],
): Promise<boolean> {
  switch (verb) {
    case 'tier': {
      if (args.length < 2) {
        console.log('  ! usage: tier <sel> <light|active|custom|none>');
        return true;
      }
      const value = args[args.length - 1] ?? '';
      const targets = resolveTargets(args.slice(0, -1).join(','), rows);
      if (targets.length > 0) await setTier(client, targets, value);
      return true;
    }
    case 'custom': {
      if (args.length < 2) {
        console.log('  ! usage: custom <sel> <on|off>');
        return true;
      }
      const value = args[args.length - 1] ?? '';
      const targets = resolveTargets(args.slice(0, -1).join(','), rows);
      if (targets.length > 0) await setCustom(client, targets, value);
      return true;
    }
    case 'approve': {
      const targets = resolveTargets(args.join(','), rows);
      if (targets.length > 0) await resolveRequest(client, targets, true);
      return true;
    }
    case 'deny': {
      const targets = resolveTargets(args.join(','), rows);
      if (targets.length > 0) await resolveRequest(client, targets, false);
      return true;
    }
    case 'list':
    case 'l':
    case 'r':
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
      // One-shot mode: `npm run clients -- <verb> <args...>`.
      const verb = (argv[0] ?? '').toLowerCase();
      await runCommand(client, verb, argv.slice(1), await loadClients(client));
      printClients(await loadClients(client));
      return;
    }

    // Interactive mode.
    const rl = readline.createInterface({ input, output });
    try {
      console.log('Goldilocks client subscriptions.');
      console.log(USAGE);
      for (;;) {
        printClients(await loadClients(client));
        const line = (await rl.question('\n> ')).trim();
        const tokens = line.split(/\s+/).filter(Boolean);
        const verb = (tokens[0] ?? '').toLowerCase();
        const keepGoing = await runCommand(client, verb, tokens.slice(1), await loadClients(client));
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
  console.error('clients CLI error:', err);
  process.exit(1);
});
