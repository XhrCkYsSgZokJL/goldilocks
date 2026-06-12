// Pricing constants and helpers.
//
// One Goldilocks plan: $100 per person when enabled, then $100/person
// on the 1st of every month. Coverage rounds up to the 1st of the
// month after next (e.g. join Jan 14 → covered through Mar 1).

// Price per covered person per month, in cents.
export const MONTHLY_PRICE_CENTS = 100_00;

// Flat one-time fee charged immediately when a new person is enabled —
// pays for their initial report. Non-refundable. Re-enabling a person who
// already paid this is free.
export const INITIAL_REPORT_FEE_CENTS = 100_00;

// When a newly-enabled person's recurring per-seat billing begins.
//
// The $100 initial fee covers a new person from their enable date through
// the end of *next* month, so their first recurring charge lands on the
// 1st of the month after next (00:00 UTC). e.g. enable Jun 6 → covered
// through Jul 31 → recurring starts Aug 1.
export function recurringStartsAt(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
}

// The last instant the initial $100 fee covers — the day before recurring
// billing begins (i.e. the end of next month). Used for display.
export function initialCoverageThrough(now: Date = new Date()): Date {
  const start = recurringStartsAt(now);
  return new Date(start.getTime() - 1);
}

// Top-up lengths offered, in months.
export const ALLOWED_DURATION_MONTHS = [1, 3, 6] as const;
export type DurationMonths = (typeof ALLOWED_DURATION_MONTHS)[number];

export function isAllowedDuration(n: number): n is DurationMonths {
  return (ALLOWED_DURATION_MONTHS as readonly number[]).includes(n);
}

// Total cost for a top-up: monthly price × people × months.
export function topUpAmountCents(people: number, durationMonths: number): number {
  return people * MONTHLY_PRICE_CENTS * durationMonths;
}

// Monthly total for `people` covered persons, in cents.
export function monthlyTotalCents(people: number): number {
  return people * MONTHLY_PRICE_CENTS;
}
