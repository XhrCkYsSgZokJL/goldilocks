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
import { startReportsWatcher } from './reports-watcher.js';
import { AuditLog } from './audit.js';
import { formatAuditLine } from './audit-format.js';
import { logger } from '../observability/logger.js';
import { emitOpsEvent } from '../observability/ops-events.js';
import { safeId } from '../observability/security-events.js';
import { runDailyBalanceTick } from '../billing/daily-tick.js';

// All audit posts (watcher echoes + admin actions) flow through this
// single AuditLog. It's constructed with the admins-agent client
// because that's the agent inbox that's actually a member of the
// alerts group (see `reconcileAlertsGroup` in admins-agent.ts).
// The reports-agent inbox is NOT in the alerts group, so giving the
// reports-watcher its own AuditLog would silently fail every post.

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
const log = logger.child({ module: 'agent' });

async function waitForDatabase(): Promise<void> {
  const maxAttempts = 30;
  const retryDelayMs = 2_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await db.execute(sql`select 1`);
      if (attempt > 1) {
        log.info({ attempts: attempt }, 'database ready');
      }
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        throw new Error(
          `database unreachable after ${maxAttempts} attempts: ${(err as Error).message}`,
        );
      }
      log.warn({ attempt, maxAttempts }, 'database not ready, retrying');
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function main(): Promise<void> {
  emitOpsEvent(log, { event: 'agent.started' });

  await waitForDatabase();

  const adminsIdentity = await getOrCreateAgentIdentity('admins');
  const reportsIdentity = await getOrCreateAgentIdentity('reports');

  log.info({ agent: 'admins', ethAddress: safeId(adminsIdentity.ethAddress, 10) }, 'identity loaded');
  log.info({ agent: 'reports', ethAddress: safeId(reportsIdentity.ethAddress, 10) }, 'identity loaded');

  const adminsClient = await bootAgentClient(adminsIdentity);
  const reportsClient = await bootAgentClient(reportsIdentity);

  log.info({ agent: 'admins', inboxId: safeId(adminsClient.inboxId), installationId: safeId(adminsClient.installationId) }, 'xmtp client booted');
  log.info({ agent: 'reports', inboxId: safeId(reportsClient.inboxId), installationId: safeId(reportsClient.installationId) }, 'xmtp client booted');

  const adminsAgent = new AdminsAgent(adminsClient, adminsIdentity);
  const reportsAgent = new ReportsAgent(reportsClient, reportsIdentity);

  // The audit log lives in the alerts group, which the admins-agent
  // owns + is a member of. Route every audit event through that
  // agent's client so it has the necessary group access.
  const auditLog: AuditLog = new AuditLog(adminsClient);

  // Catch up on anything that happened while the process was down.
  // Wrap each in try/catch so a bad initial reconcile (e.g. a wedged
  // group, MLS sequence drift after the local store was wiped) doesn't
  // crash the entire process before the listener + watcher come up.
  // The periodic tick below retries them on a 60s cadence.
  try { await adminsAgent.reconcile(); } catch (err) {
    emitOpsEvent(log, { event: 'agent.reconcile.failed', severity: 'warn', context: { agent: 'admins', error: (err as Error).message } });
  }
  try { await reportsAgent.reconcile(); } catch (err) {
    emitOpsEvent(log, { event: 'agent.reconcile.failed', severity: 'warn', context: { agent: 'reports', error: (err as Error).message } });
  }

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
      log.debug('periodic reconcile skipped (previous tick still running)');
      return;
    }
    reconcileInFlight = true;
    try {
      await Promise.all([
        adminsAgent.reconcile(),
        reportsAgent.reconcile(),
      ]);
    } catch (err) {
      emitOpsEvent(log, { event: 'agent.reconcile.failed', severity: 'warn', context: { trigger: 'periodic', error: (err as Error).message } });
    } finally {
      reconcileInFlight = false;
    }
  };
  const reconcileInterval = setInterval(() => { void tick(); }, RECONCILE_INTERVAL_MS);

  // Daily balance tick at 00:00 UTC. Schedule the first run for the next
  // midnight, then repeat every 24h. Also run once on startup to catch up
  // if the process was down at midnight.
  void runDailyBalanceTick().catch((err) => {
    log.warn({ err }, 'startup daily tick failed — will retry at midnight');
  });
  const msUntilMidnight = (): number => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return next.getTime() - now.getTime();
  };
  let dailyTickInterval: ReturnType<typeof setInterval> | null = null;
  const dailyTickTimeout = setTimeout(() => {
    void runDailyBalanceTick().catch((err) => log.error({ err }, 'daily tick failed'));
    dailyTickInterval = setInterval(() => {
      void runDailyBalanceTick().catch((err) => log.error({ err }, 'daily tick failed'));
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight());

  const stopListener = await startListener({
    onAdminChanged: async (payload) => {
      emitOpsEvent(log, {
        event: 'agent.event.dispatched',
        inboxId: payload.inbox_id,
        context: { channel: 'admin_changed', op: payload.op },
      });
      await adminsAgent.reconcile();
    },
    onClientRegistered: async (payload) => {
      const event = {
        clientId: payload.client_id,
        clientNumber: payload.client_number,
        inboxId: payload.inbox_id,
      };
      emitOpsEvent(log, {
        event: 'agent.event.dispatched',
        clientId: event.clientId,
        inboxId: event.inboxId,
        context: { channel: 'client_registered', clientNumber: event.clientNumber },
      });
      await Promise.all([
        adminsAgent.onClientRegistered(event),
        reportsAgent.onClientRegistered(event),
      ]);
    },
    onUserActive: async (payload) => {
      emitOpsEvent(log, {
        event: 'agent.event.dispatched',
        inboxId: payload.inbox_id,
        context: { channel: 'user_active', isAdmin: payload.is_admin },
      });
      await Promise.all([
        adminsAgent.reconcile(),
        reportsAgent.reconcile(),
      ]);
    },
    onChannelsRecover: async (payload) => {
      emitOpsEvent(log, {
        event: 'agent.event.dispatched',
        clientId: payload.client_id,
        inboxId: payload.inbox_id,
        context: { channel: 'channels_recover' },
      });
      const event = { clientId: payload.client_id, inboxId: payload.inbox_id };
      await Promise.all([
        adminsAgent.recoverChannelsFor(event),
        reportsAgent.recoverChannelsFor(event),
      ]);
    },
    onPeopleListChanged: async (payload) => {
      emitOpsEvent(log, {
        event: 'agent.event.dispatched',
        clientId: payload.client_id,
        context: { channel: 'people_list_changed' },
      });
    },
    onAuditEvent: async (payload) => {
      const line: string = formatAuditLine(payload);
      emitOpsEvent(log, {
        event: 'agent.event.dispatched',
        context: { channel: 'audit_event', kind: payload.kind, adminNumber: payload.admin_number, clientNumber: payload.client_number },
      });
      await auditLog.postText(line);
    },
    onAdvisoryMessage: async (payload) => {
      emitOpsEvent(log, {
        event: 'agent.event.dispatched',
        clientId: payload.client_id,
        context: { channel: 'advisory_message' },
      });
      await adminsAgent.sendAdvisoryMessage({ clientId: payload.client_id, message: payload.message });
    },
  });

  // Auto-reply to clients who write into their Reports feed — Reports is
  // a one-way notification channel with no human on the other side.
  const stopAutoResponder = await reportsAgent.startAutoResponder();

  // File-drop ingestion: PDFs in REPORTS_DIR with filenames like
  // "<clientNumber>-<title>.pdf" are encrypted and posted to that
  // client's Reports group, then moved to reports/sent/ on success.
  const stopReportsWatcher = await startReportsWatcher({ client: reportsClient, audit: auditLog });

  // Graceful shutdown — stop LISTEN + the message stream, then exit. The
  // XMTP clients hold a SQLCipher connection that node-sdk releases on
  // process exit.
  const shutdown = async (signal: string) => {
    emitOpsEvent(log, { event: 'agent.shutdown', context: { signal } });
    clearInterval(reconcileInterval);
    clearTimeout(dailyTickTimeout);
    if (dailyTickInterval) clearInterval(dailyTickInterval);
    try { stopReportsWatcher(); } catch {}
    try { await stopAutoResponder(); } catch {}
    try { await stopListener(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  emitOpsEvent(log, { event: 'agent.ready' });
}

main().catch((err) => {
  log.fatal({ err }, 'agent process crashed');
  process.exit(1);
});
