// Structured operations event logging.
//
// Covers non-security, non-billing backend events: channels, notifications,
// attachments, people-list, and agent lifecycle. Same pattern as
// security-events.ts — consistent shape, truncated IDs, no PII.

import type { FastifyBaseLogger } from 'fastify';
import { safeId } from './security-events.js';
import type { Logger } from './logger.js';

export type OpsEventKind =
  // --- channels ---
  | 'channel.registered'
  | 'channel.exploded'
  | 'channel.recreated'
  | 'channel.recover_requested'
  // --- notifications ---
  | 'notification.subscribed'
  | 'notification.unsubscribed'
  | 'notification.unregistered'
  // --- attachments ---
  | 'attachment.presigned'
  | 'attachment.uploaded'
  // --- people list ---
  | 'people_list.updated'
  | 'people_list.version_conflict'
  // --- agent ---
  | 'agent.started'
  | 'agent.ready'
  | 'agent.shutdown'
  | 'agent.reconcile.started'
  | 'agent.reconcile.completed'
  | 'agent.reconcile.failed'
  | 'agent.listener.connected'
  | 'agent.listener.error'
  | 'agent.event.dispatched'
  | 'agent.event.handler_error';

export interface OpsEventInput {
  event: OpsEventKind;
  severity?: 'info' | 'warn' | 'error';
  clientId?: string | null;
  inboxId?: string | null;
  deviceId?: string | null;
  context?: Record<string, string | number | boolean | null | undefined>;
}

export function emitOpsEvent(
  log: FastifyBaseLogger | Logger,
  input: OpsEventInput,
): void {
  const { severity = 'info', clientId, inboxId, deviceId, context, event } = input;
  const record = {
    ops: true,
    event,
    clientId: clientId === undefined ? undefined : safeId(clientId),
    inboxId: inboxId === undefined ? undefined : safeId(inboxId),
    deviceId: deviceId === undefined ? undefined : safeId(deviceId),
    context,
  };
  const msg = `ops: ${event}`;
  switch (severity) {
    case 'error':
      log.error(record, msg);
      return;
    case 'warn':
      log.warn(record, msg);
      return;
    case 'info':
    default:
      log.info(record, msg);
      return;
  }
}
