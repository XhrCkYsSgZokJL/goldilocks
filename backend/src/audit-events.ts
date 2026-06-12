// API-server → agent audit-event plumbing.
//
// HTTP route handlers in /src/routes mutate the database but can't post
// XMTP messages directly — the XMTP client lives in the agent process.
// When a route makes a change worth auditing (admin toggles Emerald,
// admin enables / disables a person on a client's plan, etc.) it
// publishes an `audit_event` NOTIFY here; the admins-agent LISTENs,
// formats the change into a narrative line, and posts it to the alerts
// group via `AuditLog`.
//
// Payloads are intentionally minimal — they identify the actor + target
// by admin number / client number rather than carrying any text. The
// agent does the formatting so the wording stays consistent and changes
// don't require coordinated route + agent updates.

import { sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { adminInboxes } from './db/schema.js';

export type AuditEventKind =
  | 'emerald_enable'
  | 'emerald_disable'
  | 'people_enable'
  | 'people_disable'
  | 'review_requested'
  | 'review_closed';

export interface AuditEventPayload {
  kind: AuditEventKind;
  admin_number: number;
  client_number: number;
}

// Fire-and-forget pg_notify on the `audit_event` channel. The route
// handler doesn't await any agent-side work — the audit post is
// best-effort and never blocks the underlying admin action.
export async function emitAuditEvent(payload: AuditEventPayload): Promise<void> {
  const json: string = JSON.stringify(payload);
  await db.execute(sql`SELECT pg_notify('audit_event', ${json})`);
}

// Numbering admins by creation order keeps the number stable across
// disable / re-enable cycles (a disabled admin keeps their slot in the
// sequence). Returns null when the caller's inbox isn't on any admin
// row — caller is expected to have already verified `isAdmin`, so this
// only really happens during a race between deleting an admin and
// firing the audit event.
export async function adminNumberForInbox(inboxId: string): Promise<number | null> {
  const rows = await db
    .select({ inboxId: adminInboxes.inboxId })
    .from(adminInboxes)
    .orderBy(adminInboxes.createdAt);
  const index: number = rows.findIndex((r) => r.inboxId === inboxId);
  return index >= 0 ? index + 1 : null;
}
