// Prepaid-balance accounting — monthly model.
//
// A client holds a prepaid balance (in cents). $125 is deducted per
// person when they are enabled (handled by person-activation.ts), then
// $125/person is charged on the 1st of every month (handled by
// monthly-tick.ts). Between charges the balance is static.
//
// Emerald clients can go negative — coverage never lapses for them.
// Non-Emerald clients stop at zero and coverage lapses.

import { monthlyTotalCents } from './pricing.js';

export interface BalanceState {
  billingBalanceCents: number;
  referralCreditCents: number;
  billingSeats: number;
  coveredPeople: number;
  lastBalanceTickAt: Date | null;
  emeraldMembershipEnabled: boolean;
  coverageEnabled: boolean;
}

// Monthly burn rate based on seats (used for top-up cost display).
export function monthlyRateCents(state: { billingSeats: number }): number {
  return monthlyTotalCents(state.billingSeats);
}

// The stored balance.
export function liveBalanceCents(state: { billingBalanceCents: number }): number {
  return state.billingBalanceCents;
}

// Whether the client currently has active coverage.
export function isCoverageActive(state: BalanceState): boolean {
  if (!state.coverageEnabled) return false;
  if (state.emeraldMembershipEnabled) return true;
  if (state.coveredPeople <= 0) return false;
  return (state.referralCreditCents + state.billingBalanceCents) >= 0;
}

// Projected date when coverage will run out, or null if coverage is
// inactive or infinite (Emerald). In the monthly model, coverage
// extends through the end of the current paid period.
export function activeUntil(state: BalanceState): Date | null {
  if (!state.coverageEnabled) return null;
  if (state.emeraldMembershipEnabled) return null;
  if (state.coveredPeople <= 0) return null;
  const totalBalance: number = state.referralCreditCents + state.billingBalanceCents;
  if (totalBalance < 0) return null;

  const monthlyBurn = monthlyTotalCents(state.coveredPeople);
  if (monthlyBurn <= 0) return null;
  const monthsRemaining = totalBalance / monthlyBurn;
  const now = new Date();
  return new Date(now.getTime() + monthsRemaining * 30 * 24 * 60 * 60 * 1000);
}

// Compute the monthly charge for all covered persons. Returns the new
// balance after deduction. Emerald clients can go negative; others
// floor at zero.
export interface MonthlyTickResult {
  newBalanceCents: number;
  newReferralCreditCents: number;
  deductedCents: number;
  coverageLapsed: boolean;
}

export function computeMonthlyTick(state: BalanceState): MonthlyTickResult {
  const deduction = monthlyTotalCents(state.coveredPeople);
  if (deduction <= 0) {
    return { newBalanceCents: state.billingBalanceCents, newReferralCreditCents: state.referralCreditCents, deductedCents: 0, coverageLapsed: false };
  }

  // Draw from referral credit first, then prepaid balance.
  let remaining: number = deduction;
  let referralCredit: number = state.referralCreditCents;
  let balance: number = state.billingBalanceCents;

  const fromReferral: number = Math.min(referralCredit, remaining);
  referralCredit -= fromReferral;
  remaining -= fromReferral;

  balance -= remaining;

  if (state.emeraldMembershipEnabled) {
    return { newBalanceCents: balance, newReferralCreditCents: referralCredit, deductedCents: deduction, coverageLapsed: false };
  }

  if (balance < 0) {
    return { newBalanceCents: 0, newReferralCreditCents: 0, deductedCents: state.billingBalanceCents + state.referralCreditCents, coverageLapsed: true };
  }

  return { newBalanceCents: balance, newReferralCreditCents: referralCredit, deductedCents: deduction, coverageLapsed: false };
}

// Snapshot the balance at a point in time before applying a mutation.
export function settle(state: { billingBalanceCents: number }): { balanceCents: number; asOf: Date } {
  return { balanceCents: state.billingBalanceCents, asOf: new Date() };
}
