// SIWE (Sign-In with Ethereum, EIP-4361) message construction and
// verification. The canonical pattern for a backend authenticating an
// Ethereum-keyed identity:
//
//   1. Backend issues a one-time nonce via /v2/auth/challenge.
//   2. Client constructs a SIWE message containing the nonce, signs it
//      with their Ethereum private key, sends the message + signature
//      to /v2/me.
//   3. Backend parses the message, verifies the signature recovers to
//      the address embedded in it, validates nonce/domain/issued_at,
//      then checks the recovered address is bound to the claimed
//      XMTP inbox via the IdentityApi.
//
// We use the `siwe` npm package for parse/validate (audited, EIP-4361
// compliant). Signature recovery uses viem.

import { SiweMessage, SiweErrorType } from 'siwe';
import { getAddress } from 'viem';
import { config } from '../config.js';
import { getInboxAddresses } from '../xmtp/identity-client.js';

export interface BuildChallengeArgs {
  /** The XMTP inbox the client is claiming to own. */
  inboxId: string;
  /** The Ethereum address derived from the client's signing key. */
  ethAddress: string;
  /** Single-use nonce issued by /v2/auth/challenge. */
  nonce: string;
}

/**
 * Build the SIWE message bytes a client should sign. Returns the human-
 * readable message text (per EIP-4361). The client signs this *exact*
 * string; any whitespace or ordering deviation will fail signature
 * recovery.
 */
export function buildSiweMessage(args: BuildChallengeArgs): string {
  // EIP-4361 requires the address field to be in EIP-55 checksum form.
  // viem.getAddress() throws on malformed input, normalises lowercase to
  // checksum, and is a no-op on already-checksummed addresses.
  const message = new SiweMessage({
    domain: config.SIWE_DOMAIN,
    address: getAddress(args.ethAddress),
    statement: `I am the owner of XMTP inbox ${args.inboxId}.`,
    uri: config.SIWE_URI,
    version: '1',
    chainId: 1, // Ethereum mainnet — XMTP wallets are mainnet-style addresses
    nonce: args.nonce,
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  return message.prepareMessage();
}

export interface VerifyChallengeArgs {
  /** The SIWE message text the client signed (verbatim). */
  siweMessage: string;
  /** Hex-encoded EIP-191 / personal_sign signature (0x-prefixed, 65 bytes). */
  signature: string;
  /** The XMTP inbox the client is claiming, as it appeared in the body. */
  expectedInboxId: string;
  /** Nonce we issued and now need to confirm matches. */
  expectedNonce: string;
}

export interface VerifyChallengeResult {
  ok: true;
  /** Recovered Ethereum address (lowercase 0x). Confirmed bound to inbox. */
  ethAddress: string;
}

export interface VerifyChallengeFailure {
  ok: false;
  reason:
  | 'invalid_message'
  | 'signature_failed'
  | 'nonce_mismatch'
  | 'inbox_mismatch'
  | 'domain_mismatch'
  | 'expired'
  | 'inbox_unknown'
  | 'address_not_bound';
  details?: string;
}

/**
 * Full verification pipeline:
 *   1. Parse the SIWE message.
 *   2. Verify EIP-191 signature recovers the address inside the message.
 *   3. Confirm domain == our domain (rejects cross-domain replays).
 *   4. Confirm nonce == the one we issued.
 *   5. Confirm inbox_id in statement == expected.
 *   6. Confirm message hasn't expired.
 *   7. Query XMTP node: confirm recovered address is currently bound to inboxId.
 *
 * Fails closed at every step.
 */
export async function verifyChallenge(
  args: VerifyChallengeArgs,
): Promise<VerifyChallengeResult | VerifyChallengeFailure> {
  let parsed: SiweMessage;
  try {
    parsed = new SiweMessage(args.siweMessage);
  } catch (err) {
    return { ok: false, reason: 'invalid_message', details: (err as Error).message };
  }

  // Step 2 + 3 + 4 + 6: let the siwe lib do its thing.
  // It checks signature recovery, domain (against `domain` arg if we pass it),
  // nonce, time-window. We'll cross-check inbox separately.
  let verified;
  try {
    verified = await parsed.verify({
      signature: args.signature,
      domain: config.SIWE_DOMAIN,
      nonce: args.expectedNonce,
    });
  } catch (err) {
    return { ok: false, reason: 'signature_failed', details: (err as Error).message };
  }

  if (!verified.success) {
    const errType = verified.error?.type;
    if (errType === SiweErrorType.NONCE_MISMATCH) return { ok: false, reason: 'nonce_mismatch' };
    if (errType === SiweErrorType.DOMAIN_MISMATCH) return { ok: false, reason: 'domain_mismatch' };
    if (errType === SiweErrorType.EXPIRED_MESSAGE) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'signature_failed', details: errType };
  }

  // Step 5: extract inbox_id from the SIWE statement and confirm it
  // matches the request body's claim. The statement is a fixed format we
  // built, so we can regex it.
  const stmt = parsed.statement ?? '';
  const inboxMatch = stmt.match(/XMTP inbox ([a-f0-9]{64})/i);
  const matchedInbox = inboxMatch?.[1];
  if (!matchedInbox || matchedInbox.toLowerCase() !== args.expectedInboxId.toLowerCase()) {
    return { ok: false, reason: 'inbox_mismatch' };
  }

  // Step 7: ledger check. The address in the SIWE message is the recovered
  // signer (siwe lib already verified that). Confirm it's currently bound
  // to the claimed inbox on the XMTP network.
  const recoveredAddr = parsed.address.toLowerCase();
  const boundAddrs = await getInboxAddresses(args.expectedInboxId);
  if (boundAddrs === null) {
    return { ok: false, reason: 'inbox_unknown' };
  }
  if (!boundAddrs.has(recoveredAddr)) {
    return { ok: false, reason: 'address_not_bound', details: `${recoveredAddr} not in inbox ledger` };
  }

  return { ok: true, ethAddress: recoveredAddr };
}

