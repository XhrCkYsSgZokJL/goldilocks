// Audit log — admin-facing record of every consequential action the
// backend takes against a client.
//
// Implemented as a thin wrapper around the existing `alerts` server
// group (the admins-agent + every admin are members). Any agent that
// holds an XMTP client and wants to record an event imports `AuditLog`,
// constructs one with that client, and calls `postText` or
// `postAttachment`. The wrapper takes care of loading + syncing the
// alerts group on each call so the caller doesn't have to remember.
//
// Two classes of audit entry land here today:
//
//   * Reports broadcasts — the reports-watcher echoes every text /
//     PDF it sends to a client's Reports group, prefaced with
//     "Sent to <scope>:" so admins can see what went out and to whom
//     without having to be in every client's Reports channel.
//
//   * Admin-initiated mutations — toggling a client's Emerald
//     membership, enabling / disabling a person on a client's plan,
//     etc. Each lands as a short narrative line ("Admin #N did X to
//     Client #M") tying the action back to the admin who performed it.
//
// The class deliberately swallows post failures and only logs them —
// the audit is best-effort, never blocking the underlying action.

import type { Client, Group, RemoteAttachment } from '@xmtp/node-sdk';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { serverGroups } from '../db/schema.js';
import { logger } from '../observability/logger.js';

const ALERTS_GROUP_KIND = 'alerts';

export class AuditLog {
  constructor(private readonly client: Client) {}

  async postText(text: string): Promise<void> {
    const group: Group | null = await this.loadAlertsGroup();
    if (!group) {
      auditLog(`postText skipped — alerts group not available; would have said: ${text}`);
      return;
    }
    try {
      await group.sendText(text);
    } catch (err) {
      auditLog(`postText failed: ${(err as Error).message}`);
    }
  }

  async postAttachment(remoteAttachment: RemoteAttachment): Promise<void> {
    const group: Group | null = await this.loadAlertsGroup();
    if (!group) {
      auditLog(`postAttachment skipped — alerts group not available`);
      return;
    }
    try {
      await group.sendRemoteAttachment(remoteAttachment);
    } catch (err) {
      auditLog(`postAttachment failed: ${(err as Error).message}`);
    }
  }

  // Find + sync the alerts group. Returns null when the group hasn't
  // been provisioned yet (admins-agent boots without any admins) or
  // this client isn't a member of it.
  private async loadAlertsGroup(): Promise<Group | null> {
    try {
      const [row] = await db
        .select({ xmtpGroupId: serverGroups.xmtpGroupId })
        .from(serverGroups)
        .where(eq(serverGroups.kind, ALERTS_GROUP_KIND))
        .limit(1);
      if (!row?.xmtpGroupId) return null;
      await this.client.conversations.sync();
      const conv = await this.client.conversations.getConversationById(row.xmtpGroupId);
      if (!conv) return null;
      const group: Group = conv as Group;
      // Refresh the group's local state so the send below sees the
      // latest epoch — same reasoning as in reports-watcher.
      try {
        await group.sync();
      } catch {
        // Non-fatal — the send will retry / surface its own error.
      }
      return group;
    } catch (err) {
      auditLog(`loadAlertsGroup failed: ${(err as Error).message}`);
      return null;
    }
  }
}

const auditLogger = logger.child({ module: 'agent.audit' });

function auditLog(msg: string): void {
  auditLogger.info(msg);
}
