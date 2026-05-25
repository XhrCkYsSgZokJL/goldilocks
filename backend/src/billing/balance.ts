// Prepaid-balance accounting.
//
// A client holds a prepaid balance (in cents) that drains at a monthly
// rate set by their seat mix. `billingBalanceAsOf` is the last time the
// balance was settled; between settles the live balance is just
// `balance - rate * elapsed`. Every mutation (top-up, seat change,
// cancel) settles first so the stored balance is always current as of
// `billingBalanceAsOf`.
//
// A "month" here is a fixed 30 days — predictable, and the basis for both
// the burn rate and the durations the client buys.

import { monthlyTotalCents } from './pricing.js';

export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// The billing fields this module reads off a `clients` row.
export interface BalanceState {
  billingBalanceCents: number;
  billingLightSeats: number;
  billingActiveSeats: number;
  billingBalanceAsOf: Date | null;
}

// Monthly burn rate, in cents, from the seat mix.
export function monthlyRateCents(state: BalanceState): number {
  return monthlyTotalCents(state.billingLightSeats, state.billingActiveSeats);
}

// The balance remaining at `at`, after draining the rate for the time
// elapsed since it was last settled. Never negative.
export function liveBalanceCents(state: BalanceState, at: Date = new Date()): number {
  if (!state.billingBalanceAsOf) return state.billingBalanceCents;
  const rate = monthlyRateCents(state);
  if (rate <= 0) return state.billingBalanceCents;
  const elapsedMs = at.getTime() - state.billingBalanceAsOf.getTime();
  if (elapsedMs <= 0) return state.billingBalanceCents;
  const burned = rate * (elapsedMs / MONTH_MS);
  return Math.max(0, Math.round(state.billingBalanceCents - burned));
}

// The instant coverage runs out, or null when there is no active cover
// (no balance, or no seats so nothing is being charged).
export function activeUntil(state: BalanceState, at: Date = new Date()): Date | null {
  const rate = monthlyRateCents(state);
  if (rate <= 0) return null;
  const live = liveBalanceCents(state, at);
  if (live <= 0) return null;
  return new Date(at.getTime() + (live / rate) * MONTH_MS);
}

// Settle the balance to `at`: the stored balance becomes the live balance
// and `asOf` moves to `at`. Callers persist the result, then apply their
// mutation (add a top-up, change seats, or zero it on cancel).
export function settle(state: BalanceState, at: Date = new Date()): { balanceCents: number; asOf: Date } {
  return { balanceCents: liveBalanceCents(state, at), asOf: at };
}
