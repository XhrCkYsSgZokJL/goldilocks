// Coverage + pricing helpers (subscription model).
//
// The prepaid-balance model has been replaced by Stripe subscriptions
// (see billing/subscriptions.ts). Coverage is now a function of the
// client's coverage toggle and enabled headcount; Stripe owns the money.
// These helpers remain as the single source of truth for "is this client
// covered" and "what's their monthly rate", read by the billing status,
// admin stats, channels, and reports paths.

import { monthlyTotalCents } from './pricing.js';

// Monthly burn rate based on enabled seats, in cents.
export function monthlyRateCents(state: { billingSeats: number }): number {
  return monthlyTotalCents(state.billingSeats);
}

// Whether the client currently has active coverage. In the subscription
// model a client is covered when coverage is enabled and they have at
// least one enabled person. Stripe keeps the subscription paid; a lapse
// is reflected by turning coverage off (via webhook) rather than by a
// balance hitting zero.
export function isCoverageActive(state: {
  coverageEnabled: boolean;
  coveredPeople: number;
  emeraldMembershipEnabled: boolean;
}): boolean {
  if (!state.coverageEnabled) return false;
  if (state.emeraldMembershipEnabled) return true;
  return state.coveredPeople > 0;
}

// Auto-renewing subscriptions have no fixed end date, so "active until"
// is open-ended. Retained for billing-status response shape compatibility.
export function activeUntil(_state: unknown): Date | null {
  return null;
}

// The prepaid balance is gone — always zero. Retained so existing read
// paths (billing status, channels) keep compiling until they drop the
// field entirely.
export function liveBalanceCents(_state: { billingBalanceCents: number }): number {
  return 0;
}

// No-op settle retained for the legacy deposit/reconcile path. Returns a
// zero balance snapshot.
export function settle(_state: { billingBalanceCents: number }): { balanceCents: number; asOf: Date } {
  return { balanceCents: 0, asOf: new Date() };
}
