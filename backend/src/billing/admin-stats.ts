// Pure aggregation for the admin Stats dashboard (GET /v2/admin/stats).
//
// Kept free of any DB/Fastify dependency so it can be unit-tested in
// isolation. The route layer fetches the rows and revenue/referral
// totals, then hands them here to be folded into the response shape.

import { isCoverageActive } from './balance.js';
import { monthlyTotalCents } from './pricing.js';
import { computeTier, type MembershipTier } from './tier.js';

// The subset of `clients` columns the aggregation needs. Matches what the
// route selects.
export interface AdminStatsClientRow {
  createdAt: Date;
  billingBalanceCents: number;
  referralCreditCents: number;
  billingSeats: number;
  coveredPeople: number;
  lastBalanceTickAt: Date | null;
  emeraldMembershipEnabled: boolean;
  coverageEnabled: boolean;
}

// Per-day screening counts (from screening_events), keyed by UTC day.
export interface ScreeningDayCount {
  // UTC calendar day, 'YYYY-MM-DD'.
  date: string;
  count: number;
}

export interface AdminStatsInput {
  clients: AdminStatsClientRow[];
  now: Date;
  // Sum of completed checkouts and refunds (from billing_checkouts).
  lifetimeRevenueCents: number;
  refundedCents: number;
  // Referral counts (from the referrals table).
  referralsTotal: number;
  referralsPaying: number;
  // Daily screening counts over (at least) the trailing 90 days.
  screeningDays: ScreeningDayCount[];
}

// Number of trailing days the screening trend covers.
export const SCREENING_TREND_DAYS = 90;

interface TierCounts {
  bronze: number;
  silver: number;
  gold: number;
  emerald: number;
}

export interface AdminStats {
  totalClients: number;
  newClientsThisMonth: number;
  clientsWithActiveCoverage: number;
  totalCoveredPeople: number;
  membershipsTotal: number;
  mrrCents: number;
  totalBalanceCents: number;
  clientsByTier: TierCounts;
  mrrByTierCents: TierCounts;
  lifetimeRevenueCents: number;
  refundedCents: number;
  seatDistribution: { seats: number; clients: number }[];
  coverage: { active: number; paused: number; none: number };
  referrals: { total: number; paying: number; creditIssuedCents: number };
  screeningTrend: { date: string; cumulative: number }[];
  asOf: string;
}

function isoDay(ms: number): string {
  const date = new Date(ms);
  const year: number = date.getUTCFullYear();
  const month: string = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day: string = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Build a dense, ascending 90-day series of running-total screenings,
// filling days with no events as zero so the line is continuous.
export function buildScreeningTrend(
  now: Date,
  days: ScreeningDayCount[],
): { date: string; cumulative: number }[] {
  const counts = new Map<string, number>();
  for (const entry of days) {
    counts.set(entry.date, entry.count);
  }

  const msPerDay = 86_400_000;
  const todayUTC: number = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const trend: { date: string; cumulative: number }[] = [];
  let cumulative = 0;
  for (let offset = SCREENING_TREND_DAYS - 1; offset >= 0; offset -= 1) {
    const dayKey: string = isoDay(todayUTC - offset * msPerDay);
    cumulative += counts.get(dayKey) ?? 0;
    trend.push({ date: dayKey, cumulative });
  }
  return trend;
}

export function aggregateAdminStats(input: AdminStatsInput): AdminStats {
  const monthStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), 1));

  const clientsByTier: TierCounts = { bronze: 0, silver: 0, gold: 0, emerald: 0 };
  const mrrByTierCents: TierCounts = { bronze: 0, silver: 0, gold: 0, emerald: 0 };
  const coverage = { active: 0, paused: 0, none: 0 };
  // Seat count (capped at 4 for the "4+" bucket) -> number of clients.
  const seatBuckets = new Map<number, number>();

  let totalCoveredPeople = 0;
  let membershipsTotal = 0;
  let mrrCents = 0;
  let totalBalanceCents = 0;
  let totalReferralCreditCents = 0;
  let clientsWithActiveCoverage = 0;
  let newClientsThisMonth = 0;

  for (const c of input.clients) {
    const active: boolean = isCoverageActive(c);
    const tier: MembershipTier = computeTier(c.billingSeats, active, c.emeraldMembershipEnabled);
    clientsByTier[tier] += 1;

    totalBalanceCents += c.billingBalanceCents;
    totalReferralCreditCents += c.referralCreditCents;
    totalCoveredPeople += c.coveredPeople;
    membershipsTotal += c.billingSeats;
    if (c.createdAt >= monthStart) {
      newClientsThisMonth += 1;
    }

    if (active) {
      clientsWithActiveCoverage += 1;
      const rateCents: number = monthlyTotalCents(c.coveredPeople);
      mrrCents += rateCents;
      mrrByTierCents[tier] += rateCents;
      coverage.active += 1;
    } else if (!c.coverageEnabled) {
      coverage.paused += 1;
    } else {
      coverage.none += 1;
    }

    const bucket: number = c.billingSeats >= 4 ? 4 : c.billingSeats;
    seatBuckets.set(bucket, (seatBuckets.get(bucket) ?? 0) + 1);
  }

  const seatDistribution = [...seatBuckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seats, count]) => ({ seats, clients: count }));

  return {
    totalClients: input.clients.length,
    newClientsThisMonth,
    clientsWithActiveCoverage,
    totalCoveredPeople,
    membershipsTotal,
    mrrCents,
    totalBalanceCents,
    clientsByTier,
    mrrByTierCents,
    lifetimeRevenueCents: input.lifetimeRevenueCents,
    refundedCents: input.refundedCents,
    seatDistribution,
    coverage,
    referrals: {
      total: input.referralsTotal,
      paying: input.referralsPaying,
      creditIssuedCents: totalReferralCreditCents,
    },
    screeningTrend: buildScreeningTrend(input.now, input.screeningDays),
    asOf: input.now.toISOString(),
  };
}
