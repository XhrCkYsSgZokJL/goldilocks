// Goldilocks agent process.
//
// Boots two server-side XMTP agents (admins-agent, reports-agent) and
// wires them to Postgres NOTIFY events:
//
//   admin_changed     -> AdminsAgent.reconcile()
//   client_registered -> AdminsAgent.onClientRegistered() + ReportsAgent.onClientRegistered()
//
// On startup each agent runs a full reconcile pass to catch up on any
// state changes that happened while the process was down.
//
// Run with `npm run agent:dev` (watcher) or `npm run agent:start` (built).

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { getOrCreateAgentIdentity } from './store.js';
import { bootAgentClient } from './xmtp-runtime.js';
import { AdminsAgent } from './admins-agent.js';
import { ReportsAgent } from './reports-agent.js';
import { startListener } from './listener.js';

/**
 * Block until Postgres accepts a query. The dev stack can start the
 * agent before — or in parallel with — the database container, so on a
 * cold boot the very first query (getOrCreateAgentIdentity) would hit
 * ECONNREFUSED and the process would exit. Under `tsx watch` the watcher
 * then keeps a dead shell alive, so nothing restarts the agent and no
 * client ever gets its channels provisioned. Retry for ~60s so a normal
 * container boot is absorbed silently; only give up if the database is
 * genuinely unreachable.
 */
async function waitForDatabase(): Promise<void> {
  const maxAttempts = 30;
  const retryDelayMs = 2_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await db.execute(sql`select 1`);
      if (attempt > 1) {
        console.log(`[agent] database ready (after ${attempt} attempts)`);
      }
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        throw new Error(
          `database unreachable after ${maxAttempts} attempts: ${(err as Error).message}`,
        );
      }
      console.log(
        `[agent] database not ready, retrying in ${retryDelayMs / 1000}s ` +
          `(attempt ${attempt}/${maxAttempts})…`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function main(): Promise<void> {
  console.log('[agent] starting goldilocks-agent…');

  await waitForDatabase();

  const adminsIdentity = await getOrCreateAgentIdentity('admins');
  const reportsIdentity = await getOrCreateAgentIdentity('reports');

  console.log(`[agent] admins-agent eth=${adminsIdentity.ethAddress}`);
  console.log(`[agent] reports-agent eth=${reportsIdentity.ethAddress}`);

  const adminsClient = await bootAgentClient(adminsIdentity);
  const reportsClient = await bootAgentClient(reportsIdentity);

  console.log(`[agent] admins-agent inbox=${adminsClient.inboxId.slice(0, 8)}…`);
  console.log(`[agent] reports-agent inbox=${reportsClient.inboxId.slice(0, 8)}…`);

  const adminsAgent = new AdminsAgent(adminsClient, adminsIdentity);
  const reportsAgent = new ReportsAgent(reportsClient, reportsIdentity);

  // Catch up on anything that happened while the process was down.
  await adminsAgent.reconcile();
  await reportsAgent.reconcile();

  // Periodic reconcile tick. Runs every 60s as a self-healing safety
  // net for client-side state drift the agent can't observe directly:
  // a client deleting Advisory/Reports locally, exploding a channel
  // (which removes them from the MLS group), or rotating installations
  // mid-session. NOTIFY-driven reconciles cover the explicit events;
  // this tick covers everything else.
  const RECONCILE_INTERVAL_MS = 60_000;
  let reconcileInFlight = false;
  const tick = async (): Promise<void> => {
    if (reconcileInFlight) {
      console.log('[agent] periodic reconcile skipped (previous tick still running)');
      return;
    }
    reconcileInFlight = true;
    try {
      await Promise.all([
        adminsAgent.reconcile(),
        reportsAgent.reconcile(),
      ]);
    } catch (err) {
      console.warn('[agent] periodic reconcile error:', (err as Error).message);
    } finally {
      reconcileInFlight = false;
    }
  };
  const reconcileInterval = setInterval(() => { void tick(); }, RECONCILE_INTERVAL_MS);

  const stopListener = await startListener({
    onAdminChanged: async (payload) => {
      const who = payload.inbox_id ? `${payload.inbox_id.slice(0, 8)}…` : (payload.name ?? 'unclaimed');
      console.log(`[agent] admin_changed op=${payload.op} ${who}`);
      await adminsAgent.reconcile();
    },
    onClientRegistered: async (payload) => {
      // pg_notify payload is snake_case; the agents take camelCase.
      const event = {
        clientId: payload.client_id,
        clientNumber: payload.client_number,
        inboxId: payload.inbox_id,
      };
      console.log(`[agent] client_registered #${event.clientNumber} inbox=${event.inboxId.slice(0, 8)}…`);
      await Promise.all([
        adminsAgent.onClientRegistered(event),
        reportsAgent.onClientRegistered(event),
      ]);
    },
    onUserActive: async (payload) => {
      // iOS just hit GET /v2/me — likely a relaunch. Re-run reconcile on
      // both agents so any newly-rotated MLS installation gets folded
      // into the user's existing groups via updateInstallations(). Cheap
      // for dev; in prod we'd narrow this to "groups containing inbox X".
      console.log(`[agent] user_active inbox=${payload.inbox_id.slice(0, 8)}… isAdmin=${payload.is_admin}`);
      await Promise.all([
        adminsAgent.reconcile(),
        reportsAgent.reconcile(),
      ]);
    },
    onChannelsRecover: async (payload) => {
      // iOS noticed it has fewer Goldilocks-managed conversations than
      // /v2/me/channels reports. Force a fresh welcome on each role by
      // removing + re-adding the client to their MLS groups.
      console.log(`[agent] channels_recover inbox=${payload.inbox_id.slice(0, 8)}…`);
      const event = { clientId: payload.client_id, inboxId: payload.inbox_id };
      await Promise.all([
        adminsAgent.recoverChannelsFor(event),
        reportsAgent.recoverChannelsFor(event),
      ]);
    },
    onPeopleListChanged: async (payload) => {
      // A client's encrypted people list changed. Once the third-party
      // service is defined, the agent will read the blob, decrypt it
      // with the client's Advisory group key, diff the per-member
      // `enabled` flags against what has been onboarded, and subscribe
      // or unsubscribe each changed member. That integration is
      // intentionally not built yet — only the trigger is wired.
      console.log(`[agent] people_list_changed client=${payload.client_id.slice(0, 8)}… — third-party onboarding re-evaluation not yet wired (service undefined)`);
    },
  });

  // Auto-reply to clients who write into their Reports feed — Reports is
  // a one-way notification channel with no human on the other side.
  const stopAutoResponder = await reportsAgent.startAutoResponder();

  // Graceful shutdown — stop LISTEN + the message stream, then exit. The
  // XMTP clients hold a SQLCipher connection that node-sdk releases on
  // process exit.
  const shutdown = async (signal: string) => {
    console.log(`[agent] received ${signal}, shutting down`);
    clearInterval(reconcileInterval);
    try { await stopAutoResponder(); } catch {}
    try { await stopListener(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log('[agent] ready.');
}

main().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
