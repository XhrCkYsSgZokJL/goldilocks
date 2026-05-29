// Membership-tier computation. Mirrors the iOS `GoldilocksMembershipTier`
// init so the backend (reports-watcher, admin endpoints, audit log
// labels) reaches the same tier the iOS UI would for any given client.
//
// Rules, in priority order:
//
//   1. Emerald if the admin-controlled flag is on. Overrides everything
//      below — a Emerald client is purely Emerald, not also B / S / G.
//   2. Bronze if the client has no active prepaid coverage. Without
//      coverage there's no billable headcount, so Silver / Gold can't
//      apply regardless of how many seats they bought in the past.
//   3. Gold if seats >= 4.
//   4. Silver if seats >= 1.
//   5. Bronze otherwise.

export type MembershipTier = 'bronze' | 'silver' | 'gold' | 'emerald';

export const SILVER_MEMBER_THRESHOLD = 1;
export const GOLD_MEMBER_THRESHOLD = 4;

export function computeTier(
  billingSeats: number,
  hasActiveCoverage: boolean,
  emeraldEnabled: boolean,
): MembershipTier {
  if (emeraldEnabled) return 'emerald';
  if (!hasActiveCoverage) return 'bronze';
  if (billingSeats >= GOLD_MEMBER_THRESHOLD) return 'gold';
  if (billingSeats >= SILVER_MEMBER_THRESHOLD) return 'silver';
  return 'bronze';
}

// Plural noun used in audit-log prefaces and broadcast log lines.
// "Sent to Bronze clients" / "Sent to Emerald clients" etc.
export function tierLabel(tier: MembershipTier): string {
  switch (tier) {
    case 'bronze': return 'Bronze';
    case 'silver': return 'Silver';
    case 'gold': return 'Gold';
    case 'emerald': return 'Emerald';
  }
}
