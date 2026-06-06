// Shared XMTP helper functions for both admins-agent and reports-agent.
//
// Centralizes installation diagnostics, inbox state refresh, and group
// sync logic so both agents use identical implementations and stay in
// sync with the current @xmtp/node-sdk v6 API surface.

import { Client, Group } from '@xmtp/node-sdk';
import { logger } from '../observability/logger.js';

/**
 * Fetch the latest inbox states for the given inbox IDs from the XMTP
 * network. This ensures that createGroup/addMembers uses up-to-date
 * installation lists instead of whatever was cached locally — critical
 * when a client just rotated installations (common on iOS relaunches).
 */
export async function refreshInboxStates(client: Client, inboxIds: string[]): Promise<void> {
  try {
    await client.preferences.fetchInboxStates(inboxIds);
  } catch (err) {
    agentLog.warn({ err }, 'refreshInboxStates failed (non-fatal)');
  }
}

/**
 * Force the group to sync its MLS state from the network. This pulls
 * in newly-rotated installations for existing members so subsequent
 * messages/welcomes are sealed to the right key packages.
 *
 * In SDK v6, `group.sync()` handles this — the older per-group
 * `updateInstallations()` / `syncInstallations()` methods no longer
 * exist.
 */
export async function refreshGroupInstallations(group: Group, label: string): Promise<void> {
  try {
    await group.sync();
  } catch (err) {
    agentLog.warn({ label, err }, 'refreshGroupInstallations failed (non-fatal)');
  }
}

/**
 * Log how many XMTP installations an inbox currently has, and return
 * that count. A welcome is HPKE-sealed per installation; a pile-up of
 * stale installations (from repeated app reinstalls) is the prime
 * suspect when a client cannot decrypt a welcome. A count of 0 means
 * a group created now would be undeliverable.
 *
 * Returns -1 when the count can't be read (error) so callers can tell
 * "unknown" apart from a genuine 0.
 */
export async function logInboxInstallations(
  client: Client,
  inboxId: string,
  label: string,
): Promise<number> {
  try {
    const states = await client.preferences.fetchInboxStates([inboxId]);
    const state = states[0];
    if (!state) {
      log(`${label} inbox ${inboxId.slice(0, 8)}… installation count unavailable`);
      return -1;
    }
    const installations = state.installations ?? [];
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

/**
 * Returns true iff `clientInboxId` is not currently a member of `group`.
 * Used to detect post-explode state: the agent stays in the group as
 * super-admin while the client is removed, so the group still loads but
 * shouldn't be considered the client's channel anymore.
 */
export async function clientNoLongerMember(
  group: Group,
  clientInboxId: string,
  label: string,
): Promise<boolean> {
  try {
    await group.sync();
    const members = await group.members();
    const target = clientInboxId.toLowerCase();
    return !members.some((m: any) => (m.inboxId as string).toLowerCase() === target);
  } catch (err) {
    log(`${label} clientNoLongerMember check failed (treating as member): ${(err as Error).message}`);
    return false;
  }
}

/**
 * Swallow errors from a promise-returning function and log them under
 * `label`. Used to keep reconcile loops running even if one operation
 * fails.
 */
export async function safe(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log(`${label} failed: ${(err as Error).message}`);
  }
}

/**
 * Enforce that the group's membership matches `desiredInboxIds` exactly.
 * Adds missing members, removes unauthorized ones. Members in
 * `lockedInboxIds` are never removed (e.g. the agent itself).
 * When `superAdminAll` is true, every desired member is promoted to
 * super-admin after sync.
 */
export async function syncMembership(
  group: Group,
  desiredInboxIds: string[],
  label: string,
  superAdminAll: boolean = false,
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
    log(`${label}   add ${toAdd.length} member(s) to ${group.id.slice(0, 8)}…`);
    await safe(() => group.addMembers(toAdd), `${label} addMembers`);
  }
  if (toRemove.length > 0) {
    log(`${label}   remove ${toRemove.length} member(s) from ${group.id.slice(0, 8)}…`);
    await safe(() => group.removeMembers(toRemove), `${label} removeMembers`);
  }
  if (superAdminAll) {
    for (const id of desiredInboxIds) {
      await safe(() => group.addSuperAdmin(id), `${label} addSuperAdmin(${id.slice(0, 8)}…)`);
    }
  }
}

const agentLog = logger.child({ module: 'agent.xmtp' });

export function log(msg: string): void {
  agentLog.info(msg);
}
