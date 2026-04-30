// AdminsAgent
//
// Owns two things:
//
//   1. The cross-admin "Admins" group. Membership tracks `admin_inboxes`
//      one-for-one. Persisted in `server_groups` (kind='admins'). Created
//      lazily on first reconcile.
//
//   2. Every client's "Advisory" group. Created on `client_registered`
//      with [client_inbox, all current admin inboxes, agent_inbox] and
//      promoting all admin inboxes to super-admin. Persisted in
//      `client_channels` (role='advisory'). Membership reconciled to the
//      current admin set whenever `admin_inboxes` changes.
//
// The agent is itself a super-admin in every group it owns so it can
// add/remove members later without ceremony. It is a *member* of every
// group too — that's a real privacy implication (the agent can read all
// Advisory traffic). Documented as the trade-off of central management.

import { eq, and, sql } from 'drizzle-orm';
import { Client, Group, MetadataField, PermissionPolicy, PermissionUpdateType } from '@xmtp/node-sdk';
import { db } from '../db/client.js';
import {
  adminInboxes,
  clients,
  clientChannels,
  serverGroups,
} from '../db/schema.js';
import type { AgentIdentity } from './store.js';
import { WorkQueue } from './work-queue.js';

const ADMINS_GROUP_NAME = 'Admins';
const ADMINS_GROUP_DESCRIPTION = 'Channel for all admins';
// Cross-admin "Audit Log" feed. Same membership shape as the Admins
// group (every admin + agent), but a separate channel so the
// report-posting firehose is segregated from coordination chatter.
// ReportsAgent's tickReportJobs will look up this group's xmtpGroupId
// from `server_groups.kind='alerts'` (legacy DB identifier — kept as
// 'alerts' to avoid a follow-up migration) and post a copy of every
// report here in addition to the per-client Reports #N group.
const ALERTS_GROUP_NAME = 'Audit Log';
const ALERTS_GROUP_DESCRIPTION = 'Goldilocks Digital Audit Log';
// Per-client Advisory naming: "Advisory #N" so admins can tell each
// client's row apart at a glance in the channels list. Description is
// shared brand copy — the per-client identifier already lives in the
// name, no need to repeat it.
const advisoryName = (clientNumber: number): string => `Advisory #${clientNumber}`;
const ADVISORY_GROUP_DESCRIPTION = 'Goldilocks Digital Concierge';

export class AdminsAgent {
  constructor(
    private readonly client: Client,
    private readonly identity: AgentIdentity,
  ) {}

  get inboxId(): string {
    return this.client.inboxId;
  }

  /**
   * In-process serialization queue. See `WorkQueue` for the rationale —
   * tl;dr: NOTIFY-driven handlers race during fresh-launch storms and
   * end up creating duplicate XMTP groups for the same `(client, role)`
   * slot. Funnel everything through `enqueue()` to make handlers run
   * sequentially.
   */
  private readonly queue = new WorkQueue('admins', (label, err) => {
    log(`[admins] queued ${label} failed: ${err.message}`);
  });
  private enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(label, fn);
  }

  /**
   * Bring all groups the agent owns into the desired state. Idempotent.
   * Called once on boot, then on every admin_changed notification.
   */
  async reconcile(): Promise<void> {
    return this.enqueue('reconcile', () => this.reconcileInner());
  }

  private async reconcileInner(): Promise<void> {
    const adminInboxIds = await loadAdminInboxIds();
    log(`[admins] reconcile: ${adminInboxIds.length} admin(s) in DB`);

    await this.reconcileAdminsGroup(adminInboxIds);
    await this.reconcileAlertsGroup(adminInboxIds);
    await this.backfillMissingAdvisory(adminInboxIds);
    await this.reconcileAdvisoryGroups(adminInboxIds);
  }

  /**
   * Create Advisory groups for any client that doesn't have one yet.
   * Catches clients whose `client_registered` NOTIFY was missed (handler
   * threw, agent down at the time, etc).
   */
  private async backfillMissingAdvisory(adminInboxIds: string[]): Promise<void> {
    const orphans = await db
      .select({
        clientId: clients.id,
        clientNumber: clients.clientNumber,
        inboxId: clients.inboxId,
      })
      .from(clients)
      .leftJoin(
        clientChannels,
        and(eq(clientChannels.clientId, clients.id), eq(clientChannels.role, 'advisory')),
      )
      .where(sql`${clientChannels.xmtpGroupId} IS NULL`);

    if (orphans.length === 0) return;
    log(`[admins] backfill: ${orphans.length} client(s) need an Advisory group`);
    for (const c of orphans) {
      await this.createAdvisoryFor(c, adminInboxIds);
    }
  }

  /**
   * Force a fresh welcome to the given client's Advisory by removing
   * them from the MLS group and re-adding them. iOS calls
   * `POST /v2/me/channels/recover` when its local conversation count
   * is below the number of active channels the backend reports — that
   * fires `channels_recover` NOTIFY which drops here. Idempotent: if
   * there's no Advisory yet we provision one fresh, and if anything
   * goes wrong with the remove we log and let the next reconcile heal.
   */
  async recoverChannelsFor(payload: { clientId: string; inboxId: string }): Promise<void> {
    return this.enqueue(`recover ${payload.inboxId.slice(0, 8)}`, () => this.recoverChannelsForInner(payload));
  }

  private async recoverChannelsForInner(payload: { clientId: string; inboxId: string }): Promise<void> {
    const [row] = await db
      .select({
        clientNumber: clients.clientNumber,
        xmtpGroupId: clientChannels.xmtpGroupId,
      })
      .from(clients)
      .innerJoin(clientChannels, eq(clientChannels.clientId, clients.id))
      .where(and(eq(clients.id, payload.clientId), eq(clientChannels.role, 'advisory')))
      .limit(1);

    if (!row || !row.xmtpGroupId) {
      log(`[admins] recover: no Advisory row for ${payload.inboxId.slice(0, 8)}…, provisioning fresh`);
      const adminInboxIds = await loadAdminInboxIds();
      await this.createAdvisoryFor(
        { clientId: payload.clientId, clientNumber: row?.clientNumber ?? 0, inboxId: payload.inboxId },
        adminInboxIds,
      );
      return;
    }

    const group = await this.tryLoadGroup(row.xmtpGroupId);
    if (!group) {
      log(`[admins] recover: Advisory group ${row.xmtpGroupId.slice(0, 8)}… not loadable, recreating`);
      const adminInboxIds = await loadAdminInboxIds();
      await this.createAdvisoryFor(
        { clientId: payload.clientId, clientNumber: row.clientNumber, inboxId: payload.inboxId },
        adminInboxIds,
      );
      return;
    }

    log(`[admins] recover: re-welcoming ${payload.inboxId.slice(0, 8)}… to Advisory #${row.clientNumber}`);
    await refreshInboxStates(this.client, [payload.inboxId]);
    // addMembers is the workhorse here: if the inbox isn't a member it
    // welcomes them; if it is, the SDK no-ops without touching the
    // group. We used to remove + re-add to force a fresh welcome, but
    // removeMembers throws weird "synced X messages" errors on small
    // groups and the readd is sufficient on its own — addMembers
    // refreshes the installation list as part of the commit, which is
    // what unsticks a missed welcome.
    await safe(() => group.addMembers([payload.inboxId]), `recover addMembers(${payload.inboxId.slice(0, 8)}…)`);
  }

  /**
   * Provision Advisory for a newly-registered client. Idempotent — if
   * the row already exists with a non-null xmtp_group_id we skip.
   */
  async onClientRegistered(payload: { clientId: string; clientNumber: number; inboxId: string }): Promise<void> {
    return this.enqueue(`onClientRegistered #${payload.clientNumber}`, () => this.onClientRegisteredInner(payload));
  }

  private async onClientRegisteredInner(payload: { clientId: string; clientNumber: number; inboxId: string }): Promise<void> {
    const existing = await db
      .select()
      .from(clientChannels)
      .where(and(eq(clientChannels.clientId, payload.clientId), eq(clientChannels.role, 'advisory')))
      .limit(1);

    if (existing[0]?.xmtpGroupId) {
      log(`[admins] client_registered: Advisory for ${payload.inboxId.slice(0, 8)}… already exists, skipping`);
      return;
    }

    const adminInboxIds = await loadAdminInboxIds();
    await this.createAdvisoryFor(payload, adminInboxIds);
  }

  // ---- private helpers -------------------------------------------------

  private async reconcileAdminsGroup(adminInboxIds: string[]): Promise<void> {
    const [existing] = await db
      .select()
      .from(serverGroups)
      .where(eq(serverGroups.kind, 'admins'))
      .limit(1);

    let group: Group | null = null;
    if (existing) {
      group = await this.tryLoadGroup(existing.xmtpGroupId);
      if (group) {
        log(`[admins] Admins group exists: ${existing.xmtpGroupId.slice(0, 8)}…`);
        await this.enforceGroupMetadata(group, ADMINS_GROUP_NAME, ADMINS_GROUP_DESCRIPTION);
      } else {
        // Local install lost the group (fresh .agent-data, blown away
        // by ops, etc.). The XMTP-level group may still exist on the
        // network but this installation can't access it. Drop the row
        // and fall through to "create new" below — humans on the old
        // group will see a fresh welcome and migrate naturally.
        log(`[admins] Admins group ${existing.xmtpGroupId.slice(0, 8)}… orphaned (not in local DB). Recreating.`);
        await db.delete(serverGroups).where(eq(serverGroups.kind, 'admins'));
      }
    }
    if (!group) {
      if (adminInboxIds.length === 0) {
        // Don't bother creating an empty Admins group — we'll create it
        // on the next admin_changed once the first admin lands.
        log('[admins] No admins yet, skipping Admins group creation');
        return;
      }
      await refreshInboxStates(this.client, adminInboxIds);
      log(`[admins] Creating Admins group with ${adminInboxIds.length} admin(s)`);
      group = await this.client.conversations.newGroup(adminInboxIds, {
        groupName: ADMINS_GROUP_NAME,
        groupDescription: ADMINS_GROUP_DESCRIPTION,
      });
      // Defensive: the option-name shape for newGroup has shifted across
      // node-sdk versions, so the metadata may not have stuck. Always
      // re-assert via the explicit updaters.
      await this.enforceGroupMetadata(group, ADMINS_GROUP_NAME, ADMINS_GROUP_DESCRIPTION);
      await db.insert(serverGroups).values({
        kind: 'admins',
        xmtpGroupId: group.id,
        managedBy: 'admins',
      });
      // The creator (this agent) is super-admin by default — promote
      // every admin too so any of them can add/remove members manually
      // if the agent is ever down.
      const fresh: Group = group;
      for (const inboxId of adminInboxIds) {
        await safe(() => fresh.addSuperAdmin(inboxId), `addSuperAdmin(${inboxId.slice(0, 8)}…)`);
      }
      await lockGroupMetadata(fresh, '[admins]');
      return;
    }

    // Include the agent itself in the desired set + lock it from removal.
    // Without this, syncMembership compares "current = [admins, agent]" to
    // "desired = [admins]" and tries to remove the agent on every pass —
    // MLS quietly rejects the self-removal but the noisy logs come back
    // every reconcile until something else changes.
    const desired = [...adminInboxIds, this.inboxId];
    await this.syncMembership(
      group,
      desired,
      /* superAdminAll */ true,
      /* lockedInboxIds */ new Set([this.inboxId]),
    );
    await refreshGroupInstallations(group);
    await lockGroupMetadata(group, '[admins]');
  }

  /**
   * Maintain the cross-admin "Alerts" group: same membership shape as
   * the Admins group (every admin + agent), but a separate channel that
   * ReportsAgent will post all client report alerts to. Idempotent.
   *
   * This is structurally identical to `reconcileAdminsGroup`; the
   * duplication is intentional — these are two distinct server groups
   * with separate xmtpGroupId rows in `server_groups` and we want clear
   * blast-radius if one ever needs to diverge (different metadata
   * policies, different super-admin set, etc.).
   */
  private async reconcileAlertsGroup(adminInboxIds: string[]): Promise<void> {
    const [existing] = await db
      .select()
      .from(serverGroups)
      .where(eq(serverGroups.kind, 'alerts'))
      .limit(1);

    let group: Group | null = null;
    if (existing) {
      group = await this.tryLoadGroup(existing.xmtpGroupId);
      if (group) {
        log(`[admins] Alerts group exists: ${existing.xmtpGroupId.slice(0, 8)}…`);
        await this.enforceGroupMetadata(group, ALERTS_GROUP_NAME, ALERTS_GROUP_DESCRIPTION);
      } else {
        log(`[admins] Alerts group ${existing.xmtpGroupId.slice(0, 8)}… orphaned (not in local DB). Recreating.`);
        await db.delete(serverGroups).where(eq(serverGroups.kind, 'alerts'));
      }
    }
    if (!group) {
      if (adminInboxIds.length === 0) {
        log('[admins] No admins yet, skipping Alerts group creation');
        return;
      }
      await refreshInboxStates(this.client, adminInboxIds);
      log(`[admins] Creating Alerts group with ${adminInboxIds.length} admin(s)`);
      group = await this.client.conversations.newGroup(adminInboxIds, {
        groupName: ALERTS_GROUP_NAME,
        groupDescription: ALERTS_GROUP_DESCRIPTION,
      });
      await this.enforceGroupMetadata(group, ALERTS_GROUP_NAME, ALERTS_GROUP_DESCRIPTION);
      await db.insert(serverGroups).values({
        kind: 'alerts',
        xmtpGroupId: group.id,
        managedBy: 'admins',
      });
      const fresh: Group = group;
      for (const inboxId of adminInboxIds) {
        await safe(() => fresh.addSuperAdmin(inboxId), `Alerts addSuperAdmin(${inboxId.slice(0, 8)}…)`);
      }
      await lockGroupMetadata(fresh, '[admins]');
      return;
    }

    const desired = [...adminInboxIds, this.inboxId];
    await this.syncMembership(
      group,
      desired,
      /* superAdminAll */ true,
      /* lockedInboxIds */ new Set([this.inboxId]),
    );
    await refreshGroupInstallations(group);
    await lockGroupMetadata(group, '[admins]');
  }

  private async reconcileAdvisoryGroups(adminInboxIds: string[]): Promise<void> {
    const rows = await db
      .select({
        clientUuid: clientChannels.clientId,
        xmtpGroupId: clientChannels.xmtpGroupId,
        clientInboxId: clients.inboxId,
        clientNumber: clients.clientNumber,
      })
      .from(clientChannels)
      .innerJoin(clients, eq(clients.id, clientChannels.clientId))
      .where(eq(clientChannels.role, 'advisory'));

    for (const row of rows) {
      if (!row.xmtpGroupId) continue;
      const group = await this.tryLoadGroup(row.xmtpGroupId);
      if (!group) {
        // Local install lost the group. Drop the xmtp_group_id from the
        // row and recreate from scratch — the new group lands the next
        // time onClientRegistered is invoked or via an explicit replay.
        log(`[admins] Advisory #${row.clientNumber} group ${row.xmtpGroupId.slice(0, 8)}… orphaned. Recreating.`);
        await this.createAdvisoryFor(
          { clientId: row.clientUuid, clientNumber: row.clientNumber, inboxId: row.clientInboxId },
          adminInboxIds,
        );
        continue;
      }
      // The client may have exploded their Advisory or otherwise removed
      // themselves from the MLS group. Detect that and reprovision a
      // fresh Advisory for them — same recovery path as a missing group.
      if (await clientNoLongerMember(group, row.clientInboxId)) {
        log(`[admins] Advisory #${row.clientNumber} ${row.xmtpGroupId.slice(0, 8)}… client no longer a member (exploded?). Recreating.`);
        await this.createAdvisoryFor(
          { clientId: row.clientUuid, clientNumber: row.clientNumber, inboxId: row.clientInboxId },
          adminInboxIds,
        );
        continue;
      }
      await this.enforceGroupMetadata(
        group,
        advisoryName(row.clientNumber),
        ADVISORY_GROUP_DESCRIPTION,
      );
      // Advisory members = client + all admins. We don't add/remove the
      // client, only sync the admin set (everything in the group that's
      // not the client and not us).
      const desired = new Set([row.clientInboxId, ...adminInboxIds, this.inboxId]);
      await this.syncMembership(group, [...desired], /* superAdminAll */ false, /* lockedInboxIds */ new Set([row.clientInboxId, this.inboxId]));
      // Promote (or re-promote) admins as super-admin.
      for (const inboxId of adminInboxIds) {
        await safe(() => group.addSuperAdmin(inboxId), `Advisory #${row.clientNumber} addSuperAdmin(${inboxId.slice(0, 8)}…)`);
      }
      // Fold any new installations of existing members into the group.
      // iOS clients can rotate installations on every relaunch (the
      // "Error building client, trying create..." path); without this
      // their fresh installation can't decrypt the original welcome.
      await refreshGroupInstallations(group);
      await lockGroupMetadata(group, '[admins]');
    }
  }

  private async createAdvisoryFor(
    payload: { clientId: string; clientNumber: number; inboxId: string },
    adminInboxIds: string[],
  ): Promise<void> {
    // Members = client + all current admins. Agent is the creator so
    // it's automatically a member + super-admin.
    const members = [payload.inboxId, ...adminInboxIds];
    // Refresh identity state from the XMTP network for each member
    // before creating the group. Without this, newGroup uses cached
    // installation lists — which can be stale if the iOS client just
    // rotated installations (common: "Error building client, trying
    // create..." path adds a second installation while the agent still
    // has only the first cached). Welcome would then go to a dead
    // installation and the user would never receive it.
    await refreshInboxStates(this.client, members);
    log(`[admins] Creating Advisory #${payload.clientNumber} for ${payload.inboxId.slice(0, 8)}… with ${adminInboxIds.length} admin(s)`);
    const name = advisoryName(payload.clientNumber);
    const description = ADVISORY_GROUP_DESCRIPTION;
    const group = await this.client.conversations.newGroup(members, {
      groupName: name,
      groupDescription: description,
    });
    // Defensive metadata write — newGroup options don't always stick.
    await this.enforceGroupMetadata(group, name, description);
    for (const inboxId of adminInboxIds) {
      await safe(() => group.addSuperAdmin(inboxId), `Advisory #${payload.clientNumber} addSuperAdmin(${inboxId.slice(0, 8)}…)`);
    }
    await lockGroupMetadata(group, '[admins]');
    await db
      .insert(clientChannels)
      .values({
        clientId: payload.clientId,
        role: 'advisory',
        xmtpGroupId: group.id,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [clientChannels.clientId, clientChannels.role],
        set: { xmtpGroupId: group.id, status: 'active' },
      });
  }

  /**
   * Sync the group's member list to `desiredInboxIds`. Members not in
   * the desired set are removed (except those in `lockedInboxIds`, which
   * we never remove — used to protect the client and the agent itself).
   */
  private async syncMembership(
    group: Group,
    desiredInboxIds: string[],
    superAdminAll: boolean,
    lockedInboxIds: Set<string> = new Set(),
  ): Promise<void> {
    await group.sync();
    const current = await group.members();
    const currentSet = new Set(current.map((m) => m.inboxId));
    const desiredSet = new Set(desiredInboxIds);

    const toAdd = desiredInboxIds.filter((id) => !currentSet.has(id));
    const toRemove = current
      .map((m) => m.inboxId)
      .filter((id) => !desiredSet.has(id) && !lockedInboxIds.has(id));

    if (toAdd.length > 0) {
      log(`[admins]   add ${toAdd.length} member(s) to ${group.id.slice(0, 8)}…`);
      await safe(() => group.addMembers(toAdd), 'addMembers');
    }
    if (toRemove.length > 0) {
      log(`[admins]   remove ${toRemove.length} member(s) from ${group.id.slice(0, 8)}…`);
      await safe(() => group.removeMembers(toRemove), 'removeMembers');
    }
    if (superAdminAll) {
      for (const id of desiredInboxIds) {
        await safe(() => group.addSuperAdmin(id), `addSuperAdmin(${id.slice(0, 8)}…)`);
      }
    }
  }

  private async loadGroup(xmtpGroupId: string): Promise<Group> {
    const conv = await this.tryLoadGroup(xmtpGroupId);
    if (!conv) {
      throw new Error(`AdminsAgent: group ${xmtpGroupId} not found locally — sync may be incomplete`);
    }
    return conv;
  }

  /**
   * Same as loadGroup but returns null instead of throwing on miss.
   * Lets callers detect orphaned-by-fresh-install groups and recreate
   * rather than crash the whole reconcile.
   */
  private async tryLoadGroup(xmtpGroupId: string): Promise<Group | null> {
    await this.client.conversations.sync();
    const conv = await this.client.conversations.getConversationById(xmtpGroupId);
    return (conv as Group | null) ?? null;
  }

  /**
   * Ensure the group's name + description match the canonical values.
   * Handles drift if anyone with super-admin rights renamed the group
   * locally — and also covers the case where newGroup's option-name
   * shape didn't take effect on this SDK version.
   *
   * Always calls updateName/updateDescription unless we can confirm the
   * value already matches. (Reading group.name on some SDK versions
   * returns undefined unless you sync first; we'd rather over-write than
   * leave it un-set.)
   */
  private async enforceGroupMetadata(group: Group, name: string, description: string): Promise<void> {
    const currentName = (group as any).name;
    const currentDescription = (group as any).description;
    log(`[admins]   group ${group.id.slice(0, 8)}… current name="${currentName ?? '<unset>'}", desc="${currentDescription ?? '<unset>'}"`);
    if (currentName !== name) {
      log(`[admins]   renaming group ${group.id.slice(0, 8)}…: "${currentName ?? ''}" → "${name}"`);
      await safe(() => (group as any).updateName(name), `updateName(${name})`);
    }
    if (currentDescription !== description) {
      await safe(() => (group as any).updateDescription(description), 'updateDescription');
    }
  }
}

async function loadAdminInboxIds(): Promise<string[]> {
  const rows = await db.select({ inboxId: adminInboxes.inboxId }).from(adminInboxes);
  return rows.map((r) => r.inboxId);
}

/**
 * Force a fresh fetch of identity associations for the given inboxIds
 * from the XMTP network. Without this, newGroup encrypts welcomes to
 * whatever installations the agent's local cache last saw, and a freshly
 * rotated installation on the recipient side will never receive its
 * welcome.
 *
 * Tries the well-known node-sdk surfaces in order (the API name has
 * shifted across versions) and falls back to a global syncAll.
 */
/**
 * Restrict who can change the group's name / description / image to
 * super-admins only. Without this, MLS's default policy lets any member
 * (including the client) edit metadata; we want the bot to be the
 * single source of truth for those fields. Idempotent — checks the
 * current policy before publishing a commit, so re-running on every
 * reconcile is cheap once the lock is in place.
 */
async function lockGroupMetadata(group: Group, agentLabel: string): Promise<void> {
  const policySet = group.permissions?.policySet;
  if (!policySet) return;

  const checks: { current: PermissionPolicy | undefined; field: MetadataField; label: string }[] = [
    { current: policySet.updateGroupNamePolicy, field: MetadataField.GroupName, label: 'name' },
    { current: policySet.updateGroupDescriptionPolicy, field: MetadataField.Description, label: 'description' },
    { current: policySet.updateGroupImageUrlSquarePolicy, field: MetadataField.ImageUrlSquare, label: 'image' },
  ];

  for (const { current, field, label } of checks) {
    if (current === PermissionPolicy.SuperAdmin) continue;
    try {
      await group.updatePermission(
        PermissionUpdateType.UpdateMetadata,
        PermissionPolicy.SuperAdmin,
        field,
      );
      log(`${agentLabel}   locked ${label} edits to super-admins for ${group.id.slice(0, 8)}…`);
    } catch (err) {
      log(`${agentLabel}   lockGroupMetadata(${label}) failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Force the group to update its key tree with the latest installations
 * of every current member. This is what lets a freshly-rotated installation
 * (e.g. iOS recreates its installation on every launch via the "Error
 * building client, trying create..." fallback) actually decrypt the
 * group's welcome and start receiving traffic.
 *
 * The method name has shifted across @xmtp/node-sdk versions; try the
 * known surfaces in order.
 */
async function refreshGroupInstallations(group: Group): Promise<void> {
  const g = group as any;
  try {
    if (g.updateInstallations) {
      await g.updateInstallations();
      return;
    }
    if (g.syncInstallations) {
      await g.syncInstallations();
      return;
    }
    if (g.update_installations) {
      await g.update_installations();
      return;
    }
    // Fallback: re-add the same members. In V3 this triggers an
    // installation refresh as a side effect.
    const members = await group.members();
    const inboxIds = members.map((m: any) => m.inboxId);
    if (g.addMembers) await g.addMembers(inboxIds);
  } catch (err) {
    log(`[admins] refreshGroupInstallations failed (non-fatal): ${(err as Error).message}`);
  }
}

async function refreshInboxStates(client: Client, inboxIds: string[]): Promise<void> {
  const c = client as any;
  try {
    if (c.preferences?.inboxStateFromInboxIds) {
      await c.preferences.inboxStateFromInboxIds(inboxIds, true);
      return;
    }
    if (c.preferences?.syncAll) {
      await c.preferences.syncAll();
      return;
    }
    if (c.conversations?.syncAll) {
      await c.conversations.syncAll();
      return;
    }
    if (c.conversations?.sync) {
      await c.conversations.sync();
      return;
    }
  } catch (err) {
    console.warn(`[agent] refreshInboxStates failed (non-fatal): ${(err as Error).message}`);
  }
}

/**
 * Returns true iff `clientInboxId` is not currently a member of `group`.
 * Used to detect post-explode state: the agent stays in the group as
 * super-admin while the client is removed, so the group still loads but
 * shouldn't be considered the client's Advisory anymore.
 */
async function clientNoLongerMember(group: Group, clientInboxId: string): Promise<boolean> {
  try {
    await group.sync();
    const members = await group.members();
    const target = clientInboxId.toLowerCase();
    return !members.some((m: any) => (m.inboxId as string).toLowerCase() === target);
  } catch (err) {
    log(`[admins] clientNoLongerMember check failed (treating as member): ${(err as Error).message}`);
    return false;
  }
}

async function safe(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log(`[admins] ${label} failed: ${(err as Error).message}`);
  }
}

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}
