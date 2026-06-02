// Structured billing event logging.
//
// Mirrors the pattern of security-events.ts but for payment lifecycle
// events. Every billing action funnels through here so that:
//   1. Log shape is consistent and filterable via `billing: true`.
//   2. Identifiers are truncated (no full Stripe IDs, no full client UUIDs).
//   3. No PII — amounts, seat counts, and durations only.
//
// This module covers:
//   - Stripe card payments (checkout, webhook credit, refund)
//   - Apple subscription events (purchase, renewal, cancellation, grace)
//   - Hopscotch crypto deposits (initiated, confirmed, failed)

import type { FastifyBaseLogger } from 'fastify';
import { safeId } from './security-events.js';
import type { Logger } from './logger.js';

export type BillingEventKind =
  // --- stripe card ---
  | 'billing.checkout.initiated'
  | 'billing.checkout.completed'
  | 'billing.checkout.abandoned'
  | 'billing.refund.initiated'
  | 'billing.refund.completed'
  | 'billing.refund.failed'
  | 'billing.customer.created'
  // --- apple subscriptions ---
  | 'billing.apple.purchase'
  | 'billing.apple.renewal'
  | 'billing.apple.cancellation'
  | 'billing.apple.grace_period'
  | 'billing.apple.revoked'
  | 'billing.apple.notification_received'
  // --- hopscotch crypto ---
  | 'billing.crypto.deposit_initiated'
  | 'billing.crypto.deposit_confirmed'
  | 'billing.crypto.deposit_failed'
  | 'billing.crypto.deposit_expired'
  // --- balance ---
  | 'billing.balance.credited'
  | 'billing.balance.settled'
  | 'billing.balance.zeroed'
  // --- seats ---
  | 'billing.seats.updated'
  // --- coverage toggle ---
  | 'billing.coverage.toggled'
  // --- referrals ---
  | 'billing.referral.credit'
  | 'billing.referral.discount';

export interface BillingEventInput {
  event: BillingEventKind;
  severity?: 'info' | 'warn' | 'error';
  clientId?: string | null;
  inboxId?: string | null;
  context?: Record<string, string | number | boolean | null | undefined>;
}

export function emitBillingEvent(
  log: FastifyBaseLogger | Logger,
  input: BillingEventInput,
): void {
  const { severity = 'info', clientId, inboxId, context, event } = input;
  const record = {
    billing: true,
    event,
    clientId: clientId === undefined ? undefined : safeId(clientId),
    inboxId: inboxId === undefined ? undefined : safeId(inboxId),
    context,
  };
  const msg = `billing: ${event}`;
  switch (severity) {
    case 'error':
      log.error(record, msg);
      return;
    case 'warn':
      log.warn(record, msg);
      return;
    case 'info':
    default:
      log.info(record, msg);
      return;
  }
}
