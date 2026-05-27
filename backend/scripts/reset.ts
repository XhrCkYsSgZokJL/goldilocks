// Reset the dev environment back to a clean slate.
//
// What this does, and why:
//
//   1. Wipes ./.agent-data/                — libxmtp local stores for both
//                                            server agents. Forces fresh
//                                            installation keys.
//   2. DELETE FROM server_groups           — agent-owned XMTP groups
//                                            (cross-admin Admins + Alerts).
//                                            Forces recreation under the
//                                            new agent inboxes.
//   3. DELETE FROM server_agents           — agent identities. Next boot
//                                            generates fresh eth keys →
//                                            fresh inboxes.
//   4. UPDATE client_channels …            — clears each client's per-role
//                                            xmtp_group_id and marks the
//                                            row exploded, so Advisory and
//                                            Reports get re-provisioned
//                                            against the new agents.
//   5. (optional) wipes ./reports/sent/    — clears the local report audit
//             and ./reports/failed/         trail. Off by default; pass
//                                            --reports to include.
//   6. (optional) wipes ./.attachments/    — clears local attachment
//                                            blobs. Off by default; pass
//                                            --attachments to include.
//   7. (--hard only) wipes user identity   — DELETE FROM clients, devices,
//                                            sessions, auth_challenges,
//                                            admin_inboxes. iOS's cached
//                                            JWT then 401s and the app is
//                                            forced through full SIWE
//                                            re-onboarding, which fires
//                                            client_registered NOTIFY and
//                                            cleanly provisions channels.
//
// What this does NOT do:
//   - touch the iOS app. You still need to delete + reinstall (or use
//     the in-app "Delete all data") so the device forgets the old groups
//     and keychain state.
//
// Usage:
//   npm run reset                       — DB + .agent-data only
//   npm run reset -- --reports          — also wipe reports/sent + failed
//   npm run reset -- --attachments      — also wipe .attachments
//   npm run reset -- --hard             — also wipe user identity tables
//                                          (clients/devices/sessions/etc)
//   npm run reset -- --all              — DB + everything above

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from '../src/config.js';
import { db, pool } from '../src/db/client.js';

interface Flags {
  reports: boolean;
  attachments: boolean;
  hard: boolean;
}

function parseFlags(argv: string[]): Flags {
  const all = argv.includes('--all');
  return {
    reports: all || argv.includes('--reports'),
    attachments: all || argv.includes('--attachments'),
    hard: all || argv.includes('--hard'),
  };
}

function warnIfDangerousEnv(): void {
  // Production safety: refuse to run unless explicitly forced. The dev
  // env file defaults to 'local' XMTP; production lives on the 'production'
  // network. We only check for a clearly-prod marker.
  if (config.XMTP_NETWORK === 'production' && !process.argv.includes('--force-production')) {
    console.error(
      '\n⛔  XMTP_NETWORK=production detected. Refusing to reset.\n' +
      '   Pass --force-production if you really mean it.\n',
    );
    process.exit(2);
  }
}

function wipeDir(label: string, path: string): void {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    console.log(`  • ${label}: ${abs} (already gone)`);
    return;
  }
  rmSync(abs, { recursive: true, force: true });
  console.log(`  • ${label}: ${abs} (wiped)`);
}

async function wipeDatabaseRows(flags: Flags): Promise<void> {
  console.log('\n2. Database — clearing agent + channel state…');
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM server_groups`);
    await tx.execute(sql`DELETE FROM server_agents`);
    await tx.execute(sql`UPDATE client_channels
                         SET xmtp_group_id = NULL,
                             status = 'exploded',
                             exploded_at = COALESCE(exploded_at, NOW())`);
    if (flags.hard) {
      // Scorched earth: also drop user identity so iOS is forced
      // through full SIWE re-onboarding on its next launch. Order
      // matters — children before parents — to satisfy FK constraints.
      await tx.execute(sql`DELETE FROM client_channels`);
      await tx.execute(sql`DELETE FROM client_people_list`);
      await tx.execute(sql`DELETE FROM billing_checkouts`);
      await tx.execute(sql`DELETE FROM clients`);
      await tx.execute(sql`DELETE FROM sessions`);
      await tx.execute(sql`DELETE FROM auth_challenges`);
      await tx.execute(sql`DELETE FROM subscriptions`);
      await tx.execute(sql`DELETE FROM installations`);
      await tx.execute(sql`DELETE FROM devices`);
      await tx.execute(sql`DELETE FROM admin_inboxes`);
    }
  });
  console.log('   • server_groups        — cleared');
  console.log('   • server_agents        — cleared (fresh identities on next boot)');
  console.log('   • client_channels      — xmtp_group_id NULLed, status=exploded');
  if (flags.hard) {
    console.log('   • client_channels      — fully cleared (--hard)');
    console.log('   • client_people_list   — cleared (--hard)');
    console.log('   • billing_checkouts    — cleared (--hard)');
    console.log('   • clients              — cleared (--hard)');
    console.log('   • sessions             — cleared (--hard)');
    console.log('   • auth_challenges      — cleared (--hard)');
    console.log('   • subscriptions        — cleared (--hard)');
    console.log('   • installations        — cleared (--hard)');
    console.log('   • devices              — cleared (--hard)');
    console.log('   • admin_inboxes        — cleared (--hard)');
  }
}

function detectIsAgentRunning(): boolean {
  // Best-effort: look for a process command line containing the agent
  // entry point. Not foolproof — Docker / different ps tools vary.
  try {
    const out = execSync('ps -A -o pid=,command= 2>/dev/null', { encoding: 'utf8' });
    return /tsx.*src\/agent\/index\.ts|node.*dist\/agent\/index\.js/.test(out);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('\n🧹 Goldilocks reset\n');
  warnIfDangerousEnv();

  if (detectIsAgentRunning()) {
    console.warn(
      '⚠️  An agent process appears to be running. Stop `npm run agents:dev`\n' +
      '   before running reset, otherwise the wiped .agent-data/ will be\n' +
      '   re-populated mid-run and you\'ll need to reset again.\n',
    );
  }

  const flags = parseFlags(process.argv.slice(2));

  console.log('1. Local stores — wiping agent libxmtp data…');
  wipeDir('AGENT_DB_DIR', config.AGENT_DB_DIR);
  if (flags.attachments) {
    wipeDir('LOCAL_STORAGE_DIR', config.LOCAL_STORAGE_DIR);
  }
  if (flags.reports) {
    wipeDir('REPORTS_DIR/sent', resolve(config.REPORTS_DIR, 'sent'));
    wipeDir('REPORTS_DIR/failed', resolve(config.REPORTS_DIR, 'failed'));
  }

  try {
    await wipeDatabaseRows(flags);
  } catch (err) {
    console.error(`\n✗ database wipe failed: ${(err as Error).message}`);
    process.exit(1);
  }

  await pool.end();

  console.log('\n✓ Reset complete.\n');
  console.log('Next steps:');
  console.log('  1. Start the server + agent fresh:');
  console.log('     npm run server:dev');
  console.log('     npm run agents:dev');
  console.log('  2. On iOS, open the app → Settings → Debug → Delete all data,');
  console.log('     then sign back in. The backend will re-provision Advisory + Reports');
  console.log('     under the new agent inboxes and welcomes will go to the current');
  console.log('     installation.');
  console.log('  3. Drop a fresh PDF in goldilocks-backend/reports/ to verify');
  console.log('     end-to-end delivery.\n');
}

main().catch((err) => {
  console.error('\n✗ reset failed:', err);
  process.exit(1);
});
