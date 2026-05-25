// Seat pricing and billing-shape helpers.
//
// Prices are defined here on the server — the iOS app sends only the seat
// counts it wants, never an amount, so a client can't talk the backend
// into charging itself the wrong total. These values mirror the iOS
// `GoldilocksSubscriptionTier.monthlyPrice` constants; keep them in sync.

// Monthly price per seat, in cents.
export const SEAT_PRICE_CENTS = {
  light: 100_00,
  active: 200_00,
} as const;

// Top-up lengths offered, in months. Capped at 6 so a pro-rata refund on
// cancellation always falls within Stripe's refund-to-card window.
export const ALLOWED_DURATION_MONTHS = [1, 3, 6] as const;
export type DurationMonths = (typeof ALLOWED_DURATION_MONTHS)[number];

export function isAllowedDuration(n: number): n is DurationMonths {
  return (ALLOWED_DURATION_MONTHS as readonly number[]).includes(n);
}

// Combined monthly price for a seat mix, in cents.
export function monthlyTotalCents(lightSeats: number, activeSeats: number): number {
  return lightSeats * SEAT_PRICE_CENTS.light + activeSeats * SEAT_PRICE_CENTS.active;
}

// The plan tier reported to the admin grid: 'active' if any Active seat is
// present, otherwise 'light', or null when there are no seats at all.
export function tierForSeats(lightSeats: number, activeSeats: number): 'light' | 'active' | null {
  if (activeSeats > 0) return 'active';
  if (lightSeats > 0) return 'light';
  return null;
}
