// Postgres LISTEN/NOTIFY plumbing for the agent process.
//
// The triggers in migration 003 fire pg_notify on:
//   - 'admin_changed'      INSERT/UPDATE/DELETE on admin_inboxes
//   - 'client_registered'  INSERT on clients
//
// We hold a *dedicated* pg client (separate from the Drizzle pool, which
// rotates connections and breaks LISTEN). On a notification, we hand the
// payload off to the relevant agent.

import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { emitOpsEvent } from '../observability/ops-events.js';

const { Client: PgClient } = pg;
const log = logger.child({ module: 'agent.listener' });

export interface AdminChangedPayload {
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  // Null when the CLI creates/removes an admin slot before it's claimed.
  inbox_id: string | null;
  name: string | null;
}

export interface ClientRegisteredPayload {
  client_id: string;        // uuid
  client_number: number;
  inbox_id: string;
}

export interface UserActivePayload {
  client_id: string;        // uuid
  inbox_id: string;
  is_admin: boolean;
}

export interface ChannelsRecoverPayload {
  client_id: string;        // uuid
  inbox_id: string;
}

export interface PeopleListChangedPayload {
  client_id: string;        // uuid
}

// Audit events come from /v2/admin/* HTTP routes when an admin makes
// a tracked change. The admins-agent formats the payload into a
// narrative line and posts it to the alerts group.
export interface AuditEventPayload {
  kind: 'emerald_enable' | 'emerald_disable' | 'people_enable' | 'people_disable';
  admin_number: number;
  client_number: number;
}

export interface AdvisoryMessagePayload {
  client_id: string;
  message: string;
}

export interface ListenerHandlers {
  onAdminChanged: (payload: AdminChangedPayload) => Promise<void>;
  onClientRegistered: (payload: ClientRegisteredPayload) => Promise<void>;
  onUserActive: (payload: UserActivePayload) => Promise<void>;
  onChannelsRecover: (payload: ChannelsRecoverPayload) => Promise<void>;
  onPeopleListChanged: (payload: PeopleListChangedPayload) => Promise<void>;
  onAuditEvent: (payload: AuditEventPayload) => Promise<void>;
  onAdvisoryMessage: (payload: AdvisoryMessagePayload) => Promise<void>;
}

/**
 * Open a dedicated connection, LISTEN on both channels, dispatch.
 * Returns a stop() callback for graceful shutdown.
 */
export async function startListener(handlers: ListenerHandlers): Promise<() => Promise<void>> {
  const pgc = new PgClient({ connectionString: config.DATABASE_URL });
  await pgc.connect();

  pgc.on('notification', (msg) => {
    if (!msg.payload) return;
    void dispatch(msg.channel, msg.payload, handlers);
  });

  pgc.on('error', (err) => {
    emitOpsEvent(log, { event: 'agent.listener.error', severity: 'error', context: { error: (err as Error).message } });
  });

  await pgc.query('LISTEN admin_changed');
  await pgc.query('LISTEN client_registered');
  await pgc.query('LISTEN user_active');
  await pgc.query('LISTEN channels_recover');
  await pgc.query('LISTEN people_list_changed');
  await pgc.query('LISTEN audit_event');
  await pgc.query('LISTEN advisory_message');
  emitOpsEvent(log, { event: 'agent.listener.connected', context: { channels: 'admin_changed,client_registered,user_active,channels_recover,people_list_changed,audit_event,advisory_message' } });

  return async () => {
    try { await pgc.query('UNLISTEN *'); } catch {}
    await pgc.end();
  };
}

// Exported so tests can drive the channel→handler routing without
// standing up a real Postgres LISTEN connection.
export async function dispatch(channel: string, payload: string, handlers: ListenerHandlers): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    log.error({ channel }, 'malformed notify payload');
    return;
  }

  try {
    if (channel === 'admin_changed') {
      await handlers.onAdminChanged(parsed as AdminChangedPayload);
    } else if (channel === 'client_registered') {
      await handlers.onClientRegistered(parsed as ClientRegisteredPayload);
    } else if (channel === 'user_active') {
      await handlers.onUserActive(parsed as UserActivePayload);
    } else if (channel === 'channels_recover') {
      await handlers.onChannelsRecover(parsed as ChannelsRecoverPayload);
    } else if (channel === 'people_list_changed') {
      await handlers.onPeopleListChanged(parsed as PeopleListChangedPayload);
    } else if (channel === 'audit_event') {
      await handlers.onAuditEvent(parsed as AuditEventPayload);
    } else if (channel === 'advisory_message') {
      await handlers.onAdvisoryMessage(parsed as AdvisoryMessagePayload);
    } else {
      log.warn({ channel }, 'unknown notify channel');
    }
  } catch (err) {
    emitOpsEvent(log, { event: 'agent.event.handler_error', severity: 'error', context: { channel, error: (err as Error).message } });
  }
}
