// ReportsAgent
//
// Owns each client's "Reports" group. Created on `client_registered` with
// just [client_inbox, agent_inbox]. The agent is the sole super-admin so
// it can post reports without the client being able to remove it.
//
// Eventually the agent will scan `report_jobs` on a tick and post any
// (status='pending' AND scheduled_at <= now()) entries to the relevant
// client's Reports group. That worker is not wired up yet — only the
// table + group ownership are in place.

import { eq, and, lte, sql } from 'drizzle-orm';
import { Client, Group, MetadataField, PermissionPolicy, PermissionUpdateType } from '@xmtp/node-sdk';
import { db } from '../db/client.js';
import { clients, clientChannels, reportJobs } from '../db/schema.js';
import type { AgentIdentity } from './store.js';
import { WorkQueue } from './work-queue.js';

// Per-client Reports naming: "Reports #N" so the iOS list and admin
// grid can disambiguate clients without an extra subtitle.
//
// Membership invariant: Reports has only [client + agent]. Admins are
// NOT added — Reports is the client-private feed where the agent posts
// scheduled reports. Anything below that adds members deliberately
// preserves this; reconcile() never calls syncMembership() on Reports
// groups, only refreshGroupInstallations(), so admin-set changes can't
// leak into Reports membership.
const reportsName = (clientNumber: number): string => `Reports #${clientNumber}`;
const REPORTS_GROUP_DESCRIPTION = 'Goldilocks Digital Audit Log';
// Minimum gap between recreating the same channel. A recreate issues a
// fresh welcome that takes a moment to reach the client; recreating
// faster than this just churns dead groups.
const RECOVER_MIN_INTERVAL_MS = 30_000;
// Hard cap: if this many recreates inside the window have not let the
// client see the channel, the failure is at the MLS layer (stale
// installations / key-package corruption) and recreating again cannot
// fix it. Stop and log loudly instead of churning groups forever.
const RECOVER_MAX_RECREATES = 3;
const RECOVER_CAP_WINDOW_MS = 600_000;

export class ReportsAgent {
  constructor(
    private readonly client: Client,
    private readonly identity: AgentIdentity,
  ) {}

  get inboxId(): string {
    return this.client.inboxId;
  }

  /** Per-agent serialization queue. See `WorkQueue` for rationale. */
  private readonly queue = new WorkQueue('reports', (label, err) => {
    log(`[reports] queued ${label} failed: ${err.message}`);
  });
  private enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(label, fn);
  }

  /** Recreate timestamps per clientId, used to cap recover-driven churn. */
  private readonly recreateHistory = new Map<string, number[]>();

  /** Recreates for this client within the cap window. */
  private recentRecreateCount(clientId: string): number {
    const now = Date.now();
    return (this.recreateHistory.get(clientId) ?? []).filter((t) => now - t < RECOVER_CAP_WINDOW_MS).length;
  }

  /** Record a recreate and prune entries outside the cap window. */
  private recordRecreate(clientId: string): void {
    const now = Date.now();
    const recent = (this.recreateHistory.get(clientId) ?? []).filter((t) => now - t < RECOVER_CAP_WINDOW_MS);
    recent.push(now);
    this.recreateHistory.set(clientId, recent);
  }

  /**
   * Provision Reports for every client without one (backfill), then
   * re-assert canonical name + description on every existing Reports
   * group so renames by anyone with super-admin rights get reverted.
   * Idempotent.
   */
  async reconcile(): Promise<void> {
    return this.enqueue('reconcile', () => this.reconcileInner());
  }

  private async reconcileInner(): Promise<void> {
    // Reports is a per-client feed, role-agnostic. Every client gets one,
    // including those who later upgrade to admin — an admin is just a
    // client whose inbox is also on the admin allowlist. iOS shows the
    // admin's own Reports in their sidebar alongside the cross-admin
    // groups, so the agent never special-cases admins here.
    const orphans = await db
      .select({
        clientId: clients.id,
        clientNumber: clients.clientNumber,
        inboxId: clients.inboxId,
      })
      .from(clients)
      .leftJoin(
        clientChannels,
        and(eq(clientChannels.clientId, clients.id), eq(clientChannels.role, 'reports')),
      )
      .where(sql`${clientChannels.xmtpGroupId} IS NULL`);

    log(`[reports] reconcile: ${orphans.length} client(s) need a Reports group`);
    for (const c of orphans) {
      await this.createReportsFor(c);
    }

    // Enforce metadata on all existing Reports groups, and recreate any
    // groups that are orphaned in the local DB (e.g. .agent-data wiped).
    const existing = await db
      .select({
        clientId: clients.id,
        clientNumber: clients.clientNumber,
        clientInboxId: clients.inboxId,
        xmtpGroupId: clientChannels.xmtpGroupId,
      })
      .from(clientChannels)
      .innerJoin(clients, eq(clients.id, clientChannels.clientId))
      .where(eq(clientChannels.role, 'reports'));

    log(`[reports] refreshing ${existing.length} existing Reports group(s)`);
    for (const row of existing) {
      if (!row.xmtpGroupId) continue;
      const group = await this.tryLoadGroup(row.xmtpGroupId);
      if (!group) {
        log(`[reports] Reports #${row.clientNumber} group ${row.xmtpGroupId.slice(0, 8)}… orphaned. Recreating.`);
        await this.createReportsFor({
          clientId: row.clientId,
          clientNumber: row.clientNumber,
          inboxId: row.clientInboxId,
        });
        continue;
      }
      // Post-explode: client is no longer in the MLS group. Reprovision
      // a fresh Reports for them.
      if (await clientNoLongerMember(group, row.clientInboxId)) {
        log(`[reports] Reports #${row.clientNumber} ${row.xmtpGroupId.slice(0, 8)}… client no longer a member (exploded?). Recreating.`);
        await this.createReportsFor({
          clientId: row.clientId,
          clientNumber: row.clientNumber,
          inboxId: row.clientInboxId,
        });
        continue;
      }
      log(`[reports]   Reports #${row.clientNumber} ${row.xmtpGroupId.slice(0, 8)}… refreshing installations`);
      await this.enforceGroupMetadata(
        group,
        reportsName(row.clientNumber),
        REPORTS_GROUP_DESCRIPTION,
      );
      // Pick up any new installations the client has rotated in.
      await refreshGroupInstallations(group);
      await lockGroupMetadata(group);
    }
  }

  /**
   * Force a fresh welcome to the given client's Reports by removing
   * them from the MLS group and re-adding them. Mirrors AdminsAgent's
   * recoverChannelsFor — iOS triggers via `channels_recover` NOTIFY
   * when its local conversation count is short.
   */
  async recoverChannelsFor(payload: { clientId: string; inboxId: string }): Promise<void> {
    return this.enqueue(`recover ${payload.inboxId.slice(0, 8)}`, () => this.recoverChannelsForInner(payload));
  }

  private async recoverChannelsForInner(payload: { clientId: string; inboxId: string }): Promise<void> {
    const [row] = await db
      .select({
        clientNumber: clients.clientNumber,
        xmtpGroupId: clientChannels.xmtpGroupId,
        createdAt: clientChannels.createdAt,
        recreatedAt: clientChannels.recreatedAt,
      })
      .from(clients)
      .innerJoin(clientChannels, eq(clientChannels.clientId, clients.id))
      .where(and(eq(clients.id, payload.clientId), eq(clientChannels.role, 'reports')))
      .limit(1);

    const clientNumber = row?.clientNumber ?? 0;

    // Dedup: a recreate issues a fresh welcome that takes a moment to
    // reach the client. If we just provisioned this channel, let that
    // welcome land instead of churning yet another group.
    if (row?.xmtpGroupId) {
      const lastProvisioned = (row.recreatedAt ?? row.createdAt).getTime();
      const ageMs = Date.now() - lastProvisioned;
      if (ageMs < RECOVER_MIN_INTERVAL_MS) {
        log(`[reports] recover: Reports #${clientNumber} provisioned ${Math.round(ageMs / 1000)}s ago — letting that welcome land, skipping`);
        return;
      }
    }

    // Hard cap. If repeated recreates have not let the client see the
    // channel, the welcome is failing at the MLS layer and recreating
    // again will not help — stop churning and log loudly so the cause
    // is visible.
    const recreatesSoFar = this.recentRecreateCount(payload.clientId);
    if (recreatesSoFar >= RECOVER_MAX_RECREATES) {
      log(`[reports] recover: ⚠️ GIVING UP on Reports #${clientNumber} for ${payload.inboxId.slice(0, 8)}… — ${recreatesSoFar} recreates in the last ${Math.round(RECOVER_CAP_WINDOW_MS / 60000)}min and the client still cannot decrypt the welcome. This is an MLS-layer failure; recreating the group cannot fix it. Most likely cause: too many stale XMTP installations on this inbox (repeated reinstalls). Fix: give the device a fresh inbox, or revoke the inbox's stale installations.`);
      return;
    }

    // A welcome that reached the client but failed to decrypt (XMTP
    // installation-rotation / key-package race) is gone for good —
    // libxmtp marks it non-retryable and drops it. addMembers() no-ops
    // for an inbox that is already a member, so it can never re-issue a
    // welcome. Recreating the group with a welcome sealed to the
    // client's current key packages is the only thing that can.
    log(`[reports] recover: recreating Reports #${clientNumber} for ${payload.inboxId.slice(0, 8)}… (recreate ${recreatesSoFar + 1}/${RECOVER_MAX_RECREATES}, fresh welcome)`);
    this.recordRecreate(payload.clientId);
    await this.createReportsFor({
      clientId: payload.clientId,
      clientNumber,
      inboxId: payload.inboxId,
    });
    await db
      .update(clientChannels)
      .set({ recreatedAt: sql`now()` })
      .where(and(eq(clientChannels.clientId, payload.clientId), eq(clientChannels.role, 'reports')));
  }

  /**
   * Provision Reports for a newly-registered client. Idempotent.
   */
  async onClientRegistered(payload: { clientId: string; clientNumber: number; inboxId: string }): Promise<void> {
    return this.enqueue(`onClientRegistered #${payload.clientNumber}`, () => this.onClientRegisteredInner(payload));
  }

  private async onClientRegisteredInner(payload: { clientId: string; clientNumber: number; inboxId: string }): Promise<void> {
    const existing = await db
      .select()
      .from(clientChannels)
      .where(and(eq(clientChannels.clientId, payload.clientId), eq(clientChannels.role, 'reports')))
      .limit(1);

    if (existing[0]?.xmtpGroupId) {
      log(`[reports] client_registered: Reports for ${payload.inboxId.slice(0, 8)}… already exists, skipping`);
      return;
    }
    // Reports is role-agnostic — every client gets one, admins included.
    // The agent doesn't special-case admins.
    await this.createReportsFor(payload);
  }

  // ---- private helpers -------------------------------------------------

  private async loadGroup(xmtpGroupId: string): Promise<Group> {
    const conv = await this.tryLoadGroup(xmtpGroupId);
    if (!conv) {
      throw new Error(`ReportsAgent: group ${xmtpGroupId} not found locally — sync may be incomplete`);
    }
    return conv;
  }

  private async tryLoadGroup(xmtpGroupId: string): Promise<Group | null> {
    await this.client.conversations.sync();
    const conv = await this.client.conversations.getConversationById(xmtpGroupId);
    return (conv as Group | null) ?? null;
  }

  /**
   * Re-assert canonical name + description if drift happened. Only writes
   * when values differ.
   */
  private async enforceGroupMetadata(group: Group, name: string, description: string): Promise<void> {
    if (group.name !== name) {
      log(`[reports]   renaming group ${group.id.slice(0, 8)}…: "${group.name ?? ''}" → "${name}"`);
      try { await group.updateName(name); } catch (e) { log(`[reports] updateName failed: ${(e as Error).message}`); }
    }
    if (group.description !== description) {
      try { await group.updateDescription(description); } catch (e) { log(`[reports] updateDescription failed: ${(e as Error).message}`); }
    }
  }

  /**
   * Future home of the cron loop. Called every tick by index.ts. Right
   * now this is a no-op — the table is in place and ready for a real
   * implementation. The pseudocode is left here on purpose so the wire
   * format is obvious when the loop is wired up.
   *
   * Wiring plan: each due report posts to TWO groups —
   *   1. The client's per-client Reports #N group (private feed).
   *   2. The cross-admin Alerts group (server_groups.kind='alerts')
   *      so every admin sees a stream of incoming reports.
   * The Alerts group is owned by AdminsAgent (membership tracks
   * admin_inboxes one-for-one); ReportsAgent only needs to look up its
   * xmtpGroupId from server_groups and post a copy of each report.
   */
  async tickReportJobs(): Promise<void> {
    // const due = await db
    //   .select()
    //   .from(reportJobs)
    //   .where(and(eq(reportJobs.status, 'pending'), lte(reportJobs.scheduledAt, new Date())))
    //   .limit(50);
    // for (const job of due) {
    //   const ch = ...lookup client_channels for client_id, role='reports'...;
    //   const group = await this.loadGroup(ch.xmtpGroupId!);
    //   await group.send(formatReport(job.payload));
    //   await db.update(reportJobs).set({ status: 'posted', postedAt: new Date() }).where(eq(reportJobs.id, job.id));
    // }
  }

  private async createReportsFor(payload: { clientId: string; clientNumber: number; inboxId: string }): Promise<void> {
    // Refresh client's identity state so the welcome encrypts to the
    // right installation. See AdminsAgent for why this matters.
    await refreshInboxStates(this.client, [payload.inboxId]);
    // Diagnostic: the welcome is HPKE-sealed per installation, so a
    // pile-up of stale installations on this inbox is the prime suspect
    // when the client cannot decrypt it. Log the count + ids.
    const installationCount = await logInboxInstallations(this.client, payload.inboxId, '[reports] diag:');
    // Defer if the client's inbox has no XMTP installation yet: a group
    // created now would have an undeliverable welcome. The reconcile
    // orphan scan (the 60s tick or a user_active event) creates it once an
    // installation has propagated. -1 means "couldn't read" — proceed.
    if (installationCount === 0) {
      log(`[reports] Reports #${payload.clientNumber} for ${payload.inboxId.slice(0, 8)}… deferred — inbox has 0 XMTP installations yet; will retry on the next reconcile.`);
      return;
    }
    log(`[reports] Creating Reports #${payload.clientNumber} for ${payload.inboxId.slice(0, 8)}…`);
    const name = reportsName(payload.clientNumber);
    const description = REPORTS_GROUP_DESCRIPTION;
    // Members = [client]. Agent is the creator and is a member by
    // default. Admins are NOT added — Reports stays a 2-party feed
    // until/unless the client invites others.
    const group = await this.client.conversations.createGroup([payload.inboxId], {
      groupName: name,
      groupDescription: description,
    });
    log(`[reports] Created Reports #${payload.clientNumber} group ${group.id.slice(0, 8)}… — welcome sent to ${payload.inboxId.slice(0, 8)}…`);
    // Defensive metadata write — createGroup options don't always stick.
    await this.enforceGroupMetadata(group, name, description);
    // Lock down name/description/image so the client can't rename a
    // Reports feed they receive.
    await lockGroupMetadata(group);
    // Agent is creator → super-admin by default. Client stays as a regular
    // member; we don't promote the client so they can't remove the agent.
    await db
      .insert(clientChannels)
      .values({
        clientId: payload.clientId,
        role: 'reports',
        xmtpGroupId: group.id,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [clientChannels.clientId, clientChannels.role],
        set: { xmtpGroupId: group.id, status: 'active' },
      });
  }
}

/**
 * Lock metadata edits to super-admins. Mirrors the helper in
 * admins-agent.ts. Reports groups are read-only feeds — clients
 * shouldn't be renaming them or swapping the icon.
 */
async function lockGroupMetadata(group: Group): Promise<void> {
  const policySet = group.permissions().policySet;
  if (!policySet) return;

  const checks: { current: PermissionPolicy | undefined; field: MetadataField; label: string }[] = [
    { current: policySet.updateGroupNamePolicy, field: MetadataField.GroupName, label: 'name' },
    { current: policySet.updateGroupDescriptionPolicy, field: MetadataField.Description, label: 'description' },
    { current: policySet.updateGroupImageUrlSquarePolicy, field: MetadataField.GroupImageUrlSquare, label: 'image' },
  ];

  for (const { current, field, label } of checks) {
    if (current === PermissionPolicy.SuperAdmin) continue;
    try {
      await group.updatePermission(
        PermissionUpdateType.UpdateMetadata,
        PermissionPolicy.SuperAdmin,
        field,
      );
      log(`[reports]   locked ${label} edits to super-admins for ${group.id.slice(0, 8)}…`);
    } catch (err) {
      log(`[reports]   lockGroupMetadata(${label}) failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Bring the group's MLS key tree up to date with the current installation
 * set of every member. Mirrors the helper in admins-agent.ts.
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
    const members = await group.members();
    const inboxIds = members.map((m: any) => m.inboxId);
    if (g.addMembers) await g.addMembers(inboxIds);
  } catch (err) {
    log(`[reports] refreshGroupInstallations failed (non-fatal): ${(err as Error).message}`);
  }
}

/**
 * Returns true iff `clientInboxId` is not currently a member of `group`.
 * The agent stays in the group as super-admin after an explode, so the
 * group itself still loads — the only signal is that the client is gone.
 */
async function clientNoLongerMember(group: Group, clientInboxId: string): Promise<boolean> {
  try {
    await group.sync();
    const members = await group.members();
    const target = clientInboxId.toLowerCase();
    return !members.some((m: any) => (m.inboxId as string).toLowerCase() === target);
  } catch (err) {
    log(`[reports] clientNoLongerMember check failed (treating as member): ${(err as Error).message}`);
    return false;
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
 * Log how many XMTP installations an inbox currently has, and return that
 * count. A welcome is HPKE-sealed per installation; a pile-up of stale
 * installations (from repeated app reinstalls) is the prime suspect when a
 * client cannot decrypt the welcome for a freshly created group, and a
 * count of 0 means a group created now would be undeliverable. Returns -1
 * when the count can't be read (SDK surface missing / error) so callers
 * can tell "unknown" apart from a genuine 0. Best-effort: the node-sdk
 * surface for this has shifted across versions.
 */
async function logInboxInstallations(client: Client, inboxId: string, label: string): Promise<number> {
  try {
    const c = client as any;
    const states = await c.preferences?.inboxStateFromInboxIds?.([inboxId], true);
    const state = Array.isArray(states) ? states[0] : states;
    if (!state) {
      // SDK surface unavailable or no state returned. Report -1 ("unknown")
      // so callers don't defer group creation on a read miss.
      log(`${label} inbox ${inboxId.slice(0, 8)}… installation count unavailable`);
      return -1;
    }
    const installations = (state.installations ?? []) as Array<{ id?: string }>;
    const ids = installations.map((i) => (i.id ?? '').slice(0, 8)).filter((s: string) => s.length > 0);
    log(`${label} inbox ${inboxId.slice(0, 8)}… has ${installations.length} XMTP installation(s): [${ids.join(', ')}]`);
    if (installations.length >= 8) {
      log(`${label} ⚠️ ${installations.length} installations is near/over XMTP's ~10-per-inbox limit — welcome delivery to the newest installation becomes unreliable. The inbox needs stale-installation revocation.`);
    }
    return installations.length;
  } catch (err) {
    log(`${label} could not read inbox installations (non-fatal): ${(err as Error).message}`);
    return -1;
  }
}

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}
