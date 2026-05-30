// Shared XMTP helper functions for both admins-agent and reports-agent.
//
// Centralizes installation diagnostics, inbox state refresh, and group
// sync logic so both agents use identical implementations and stay in
// sync with the current @xmtp/node-sdk v6 API surface.

import { Client, Group } from '@xmtp/node-sdk';

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
    console.warn(`[agent] refreshInboxStates failed (non-fatal): ${(err as Error).message}`);
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
    console.warn(`${label} refreshGroupInstallations failed (non-fatal): ${(err as Error).message}`);
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

export function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}
