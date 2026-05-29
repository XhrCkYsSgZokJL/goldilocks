// Persistent identity for the server-side XMTP agents.
//
// We mint each agent's secp256k1 key the first time the agent process
// boots and store the seed in `server_agents`. On every subsequent boot
// we load the same key back so the agent's XMTP inbox is stable across
// restarts (which is what lets the groups it owns keep working).

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { serverAgents } from '../db/schema.js';
import { config } from '../config.js';

export type AgentKind = 'admins' | 'reports';

export interface AgentIdentity {
  kind: AgentKind;
  inboxId: string | null;        // null on first boot, before XMTP says hi
  ethAddress: string;            // 0x + 40 hex
  privateKeyHex: string;         // 0x + 64 hex
  xmtpDbPath: string;            // absolute path the agent should use
}

/**
 * Returns the persisted identity for an agent kind, generating one on
 * first call. The inbox_id is filled in lazily by the agent itself (we
 * don't know it until the XMTP client registers), so callers should
 * call `recordInboxId` once that happens.
 */
export async function getOrCreateAgentIdentity(kind: AgentKind): Promise<AgentIdentity> {
  await mkdir(config.AGENT_DB_DIR, { recursive: true });
  const xmtpDbPath = join(config.AGENT_DB_DIR, `${kind}.db3`);

  const [existing] = await db
    .select()
    .from(serverAgents)
    .where(eq(serverAgents.kind, kind))
    .limit(1);

  if (existing) {
    // Refresh the db path in case AGENT_DB_DIR moved between deploys.
    if (existing.xmtpDbPath !== xmtpDbPath) {
      await db
        .update(serverAgents)
        .set({ xmtpDbPath, updatedAt: sql`now()` })
        .where(eq(serverAgents.kind, kind));
    }
    return {
      kind,
      inboxId: existing.inboxId || null,
      ethAddress: existing.ethAddress,
      privateKeyHex: existing.privateKeyHex,
      xmtpDbPath,
    };
  }

  const privateKey = generatePrivateKey();              // 0x + 64 hex
  const account = privateKeyToAccount(privateKey);
  const ethAddress = account.address;

  await db.insert(serverAgents).values({
    kind,
    inboxId: null,                // filled in by recordInboxId once XMTP registers
    ethAddress,
    privateKeyHex: privateKey,
    xmtpDbPath,
  });

  return {
    kind,
    inboxId: null,
    ethAddress,
    privateKeyHex: privateKey,
    xmtpDbPath,
  };
}

/**
 * Persist the inbox_id once the agent's XMTP client has registered.
 * Idempotent — safe to call on every boot.
 */
export async function recordInboxId(kind: AgentKind, inboxId: string): Promise<void> {
  await db
    .update(serverAgents)
    .set({ inboxId, updatedAt: sql`now()` })
    .where(eq(serverAgents.kind, kind));
}

/**
 * Reads back the inbox_ids of all agents, keyed by kind. Used by other
 * code paths (e.g. listener.ts) that need to know which inbox belongs
 * to which agent without reaching into the agent class instances.
 */
export async function loadAgentInboxes(): Promise<Record<AgentKind, string | null>> {
  const rows = await db.select().from(serverAgents);
  const result: Record<AgentKind, string | null> = { admins: null, reports: null };
  for (const r of rows) {
    if (r.kind === 'admins' || r.kind === 'reports') {
      result[r.kind] = r.inboxId || null;
    }
  }
  return result;
}
