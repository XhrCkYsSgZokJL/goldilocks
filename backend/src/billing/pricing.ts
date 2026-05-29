// Seat pricing and billing-shape helpers.
//
// There is exactly one Goldilocks plan today, priced per person. The iOS
// app sends only the seat count it wants, never an amount, so a client
// can't talk the backend into charging itself the wrong total. This value
// mirrors the iOS `GoldilocksPlan.monthlyPricePerPerson` constant; keep
// them in sync.

// Monthly price per seat, in cents.
export const SEAT_PRICE_CENTS = 125_00;

// Top-up lengths offered, in months. Capped at 6 so a pro-rata refund on
// cancellation always falls within Stripe's refund-to-card window.
export const ALLOWED_DURATION_MONTHS = [1, 3, 6] as const;
export type DurationMonths = (typeof ALLOWED_DURATION_MONTHS)[number];

export function isAllowedDuration(n: number): n is DurationMonths {
  return (ALLOWED_DURATION_MONTHS as readonly number[]).includes(n);
}

// Monthly price for `seats` people, in cents.
export function monthlyTotalCents(seats: number): number {
  return seats * SEAT_PRICE_CENTS;
}
