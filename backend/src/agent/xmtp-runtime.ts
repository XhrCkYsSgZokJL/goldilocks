// XMTP client bootstrap for the server-side agents.
//
// Each agent runs its own XMTP client on top of @xmtp/node-sdk, signed
// with the secp256k1 key persisted in `server_agents`. We point them
// at the same XMTP node the iOS app uses (config.XMTP_API_URL on the
// 'local' network for dev).
//
// We deliberately use @xmtp/node-sdk directly (not @xmtp/agent-sdk's
// event loop) because our agents don't need to react to messages — they
// only manage group membership in response to DB triggers. Group create
// + add/remove + super-admin promotion are all on the Client.

import { Client, type Signer, IdentifierKind } from '@xmtp/node-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import type { AgentIdentity } from './store.js';
import { recordInboxId } from './store.js';

/**
 * Boot an XMTP client for a server agent. On first boot (no inbox_id
 * yet), the client creates a fresh inbox bound to the agent's eth key
 * and we persist the resulting inbox_id back into server_agents.
 */
export async function bootAgentClient(identity: AgentIdentity): Promise<Client> {
  const account = privateKeyToAccount(identity.privateKeyHex as `0x${string}`);

  const signer: Signer = {
    type: 'EOA',
    getIdentifier: async () => ({
      identifier: account.address,
      identifierKind: IdentifierKind.Ethereum,
    }),
    signMessage: async (message: string) => {
      const hex = await account.signMessage({ message });
      // node-sdk wants Uint8Array; strip the 0x and decode hex.
      const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
      const out = new Uint8Array(stripped.length / 2);
      for (let i = 0; i < stripped.length; i += 2) {
        out[i / 2] = parseInt(stripped.substr(i, 2), 16);
      }
      return out;
    },
  };

  const dbEncryptionKey = decodeEncryptionKey(config.AGENT_DB_ENCRYPTION_KEY);

  // Built as a separate object on purpose: node-sdk 6 types
  // `Client.create`'s options as `Omit<ClientOptions, 'codecs'>`, and
  // because `ClientOptions` is a union the `Omit` drops `env` / `apiUrl`
  // from its known keys — so an inline object literal fails the
  // excess-property check. A pre-built object is structurally
  // assignable and passes `env` through to the runtime unchanged.
  const clientOptions = {
    env: config.XMTP_NETWORK,
    apiUrl: config.XMTP_NETWORK === 'local' ? config.XMTP_API_URL : undefined,
    dbPath: identity.xmtpDbPath,
    dbEncryptionKey,
  };
  const client = await Client.create(signer, clientOptions);

  // The first time this runs the inbox_id is fresh — persist it so the
  // listener and other agents can look up which inbox belongs to which
  // kind without instantiating a Client.
  if (client.inboxId !== identity.inboxId) {
    await recordInboxId(identity.kind, client.inboxId);
  }

  // Revoke every installation on this inbox except the one we just
  // booted. Without this, stale installations pile up each time the
  // agent restarts with a fresh local DB (e.g. after `./dev/reset`
  // wipes `.agent-data`). Stale installations are still registered
  // on the XMTP network and receive HPKE-sealed welcomes that nobody
  // decrypts — once the count hits ~10 the network starts dropping
  // welcomes for the newest (live) installation too.
  try {
    const before = await client.preferences.fetchInboxState();
    const staleCount = (before.installations?.length ?? 1) - 1;
    if (staleCount > 0) {
      console.log(`[agent] ${identity.kind}: revoking ${staleCount} stale installation(s) (keeping ${client.installationId.slice(0, 8)}…)`);
      await client.revokeAllOtherInstallations();
      console.log(`[agent] ${identity.kind}: stale installations revoked`);
    }
  } catch (err) {
    console.warn(`[agent] ${identity.kind}: revokeAllOtherInstallations failed (non-fatal): ${(err as Error).message}`);
  }

  return client;
}

/**
 * Decode AGENT_DB_ENCRYPTION_KEY (hex, with or without 0x prefix). If
 * unset, generate a deterministic stand-in derived from the env so dev
 * still works without a key — NOT secure for production.
 */
function decodeEncryptionKey(input: string): Uint8Array {
  let hex = input.trim();
  if (!hex) {
    // Predictable dev fallback. Loud enough that ops will notice in logs.
    console.warn('[agent] AGENT_DB_ENCRYPTION_KEY unset — using dev fallback. Do not use in production.');
    hex = 'a'.repeat(64);
  }
  if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2);
  if (hex.length !== 64) {
    throw new Error(`AGENT_DB_ENCRYPTION_KEY must be 32 bytes (64 hex chars), got ${hex.length}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
