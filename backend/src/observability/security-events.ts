// Structured security event logging.
//
// Every interesting security event in the backend funnels through this
// module so that:
//   1. The shape of each log record is consistent (a single greppable
//      `security: <kind>` message, a `security: true` tag for filters,
//      and the same set of canonical fields).
//   2. Identifiers (deviceId, inboxId, ethAddress) are *truncated*
//      before they hit the log stream. We carry enough prefix to
//      correlate events in a single investigation, but not enough to
//      reconstruct an identity from logs alone.
//   3. Nothing secret ever lands in a log record. Tokens, signatures,
//      and SIWE messages are flagged in src/observability/redact-paths.ts
//      as defense-in-depth — the emitters here additionally never
//      accept those fields at the API boundary.
//
// Severity legend:
//   info      — routine, expected, useful for usage analytics
//   warn      — anomalous but not necessarily malicious; investigate if
//               the rate is unusually high
//   critical  — security incident; page a human

import type { FastifyBaseLogger } from 'fastify';

/**
 * Return the first `prefix` characters of an identifier with an ellipsis
 * marker — safe to log. Returns 'none' for null/undefined so the absence
 * is visible in the record rather than the field disappearing.
 */
export function safeId(id: string | null | undefined, prefix: number = 8): string {
  if (id === null || id === undefined) return 'none';
  if (id.length <= prefix) return id;
  return `${id.slice(0, prefix)}…`;
}

/**
 * The catalog of event kinds. Add to this union when you introduce a
 * new security event, then add the emit point at the right place.
 *
 * Naming convention: `<area>.<noun>.<verb>` for routine events,
 * `<area>.<incident>` for anomalies.
 */
export type SecurityEventKind =
  // --- authentication ---
  | 'auth.token.issued'
  | 'auth.token.refreshed'
  | 'auth.refresh.invalid'
  | 'auth.refresh.expired'
  | 'auth.refresh.reused_family_revoked'     // critical: theft detection
  | 'auth.logout'
  | 'auth.jwt.revoked_token_used'            // someone presented a revoked JTI
  // --- SIWE ---
  | 'siwe.challenge.issued'
  | 'siwe.challenge.verified'
  | 'siwe.challenge.failed'
  | 'siwe.device_inbox_mismatch'             // critical: impersonation guard
  // --- admin ---
  | 'admin.upgrade.success'
  | 'admin.upgrade.invalid_code'             // possible brute-force signal
  | 'admin.upgrade.disabled_code'
  | 'admin.promote_self'
  | 'admin.downgrade'
  // --- device ---
  | 'device.registered'
  | 'device.push_token_updated'
  // --- stripe ---
  | 'stripe.webhook.missing_signature'
  | 'stripe.webhook.invalid_signature'       // critical: forged webhook
  // --- crypto ---
  | 'crypto.at_rest.decrypt_failed'
  | 'crypto.lookup_hash.derive_failed';

export interface SecurityEventInput {
  event: SecurityEventKind;
  severity?: 'info' | 'warn' | 'critical';
  /** Truncated automatically by safeId. Pass the raw value; never the JWT. */
  deviceId?: string | null;
  /** Truncated automatically by safeId. */
  inboxId?: string | null;
  /** Truncated automatically by safeId. Ethereum addresses are public,
   *  but we still truncate so logs aren't trivially pivot-able. */
  ethAddress?: string | null;
  /** Refresh-token family id (UUID). Truncated by safeId. Useful to
   *  correlate a `reused_family_revoked` event back to the originating
   *  `token.issued`. */
  familyId?: string | null;
  /** Source IP, when relevant for rate-limit / brute-force analysis. */
  ip?: string | null;
  /** Free-form structured context. NEVER put secrets here — anything
   *  matching REDACT_PATHS would be censored by Pino anyway, but treat
   *  this as the place for small string / number / boolean labels
   *  (e.g. `{ jti: '<truncated>', reason: 'expired' }`). */
  context?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Emit a structured security event. The logger argument is whatever
 * Fastify gives you (`req.log` inside a handler, `app.log` outside).
 *
 * The record produced looks like:
 *   {
 *     "level": 30,                           // info
 *     "security": true,
 *     "event": "auth.refresh.reused_family_revoked",
 *     "deviceId": "5f8c7a3d…",
 *     "familyId": "0e1f2a…",
 *     "ip": "203.0.113.4",
 *     "msg": "security: auth.refresh.reused_family_revoked"
 *   }
 *
 * Filter on `security: true` or grep for `security:` in pretty mode.
 */
export function emitSecurityEvent(
  log: FastifyBaseLogger,
  input: SecurityEventInput,
): void {
  const { severity = 'info', deviceId, inboxId, ethAddress, familyId, ip, context, event } = input;
  const record = {
    security: true,
    event,
    deviceId: deviceId === undefined ? undefined : safeId(deviceId),
    inboxId: inboxId === undefined ? undefined : safeId(inboxId),
    ethAddress: ethAddress === undefined ? undefined : safeId(ethAddress, 10),
    familyId: familyId === undefined ? undefined : safeId(familyId),
    ip: ip ?? undefined,
    context,
  };
  const msg = `security: ${event}`;
  switch (severity) {
    case 'critical':
    case 'warn':
      log.warn(record, msg);
      return;
    case 'info':
    default:
      log.info(record, msg);
      return;
  }
}
