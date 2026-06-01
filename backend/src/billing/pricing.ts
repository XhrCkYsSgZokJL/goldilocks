// Pricing constants and helpers.
//
// One Goldilocks plan: $100 per person when enabled, then $100/person
// on the 1st of every month. Coverage rounds up to the 1st of the
// month after next (e.g. join Jan 14 → covered through Mar 1).

// Price per covered person per month, in cents.
export const MONTHLY_PRICE_CENTS = 100_00;

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
