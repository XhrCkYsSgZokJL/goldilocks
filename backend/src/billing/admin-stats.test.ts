import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateAdminStats,
  buildScreeningTrend,
  SCREENING_TREND_DAYS,
  type AdminStatsClientRow,
} from './admin-stats.js';

// Pure aggregation behind GET /v2/admin/stats. We verify tier mix, MRR
// (driven by covered people, not seats), the active/paused/none coverage
// split, seat-distribution bucketing (4+ collapsed), new-this-month, and
// pass-through of revenue/referral totals.

const NOW = new Date('2026-06-15T12:00:00.000Z');

function client(overrides: Partial<AdminStatsClientRow> = {}): AdminStatsClientRow {
  return {
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    billingBalanceCents: 0,
    referralCreditCents: 0,
    billingSeats: 0,
    coveredPeople: 0,
    lastBalanceTickAt: null,
    emeraldMembershipEnabled: false,
    coverageEnabled: true,
    ...overrides,
  };
}

describe('billing/admin-stats', () => {
  it('returns an all-zero snapshot for no clients', () => {
    const stats = aggregateAdminStats({
      clients: [],
      now: NOW,
      lifetimeRevenueCents: 0,
      refundedCents: 0,
      referralsTotal: 0,
      referralsPaying: 0,
      screeningDays: [],
    });
    assert.strictEqual(stats.totalClients, 0);
    assert.strictEqual(stats.membershipsTotal, 0);
    assert.strictEqual(stats.mrrCents, 0);
    assert.deepStrictEqual(stats.clientsByTier, { bronze: 0, silver: 0, gold: 0, emerald: 0 });
    assert.deepStrictEqual(stats.seatDistribution, []);
    // A dense, zero-filled 90-day window even with no events.
    assert.strictEqual(stats.screeningTrend.length, SCREENING_TREND_DAYS);
    const lastPoint = stats.screeningTrend.at(-1);
    assert.ok(lastPoint);
    assert.strictEqual(lastPoint.cumulative, 0);
    assert.strictEqual(stats.asOf, NOW.toISOString());
  });

  it('computes tier mix and MRR from covered people', () => {
    const clients: AdminStatsClientRow[] = [
      // Bronze: no coverage.
      client({ coverageEnabled: false }),
      // Silver: 2 seats, active coverage, 2 covered people -> $200/mo.
      client({ billingSeats: 2, coveredPeople: 2, billingBalanceCents: 50_000 }),
      // Gold: 5 seats, active coverage, 4 covered people -> $400/mo.
      client({ billingSeats: 5, coveredPeople: 4, billingBalanceCents: 100_000 }),
      // Emerald: admin flag, 0 people -> $0/mo, still active.
      client({ emeraldMembershipEnabled: true }),
    ];

    const stats = aggregateAdminStats({
      clients,
      now: NOW,
      lifetimeRevenueCents: 1_000_000,
      refundedCents: 25_000,
      referralsTotal: 4,
      referralsPaying: 2,
      screeningDays: [],
    });

    assert.strictEqual(stats.totalClients, 4);
    // Memberships = sum of billing seats (0 + 2 + 5 + 0).
    assert.strictEqual(stats.membershipsTotal, 7);
    assert.deepStrictEqual(stats.clientsByTier, { bronze: 1, silver: 1, gold: 1, emerald: 1 });
    // MRR = silver(200) + gold(400) + emerald(0) = $600.
    assert.strictEqual(stats.mrrCents, 60_000);
    assert.strictEqual(stats.mrrByTierCents.silver, 20_000);
    assert.strictEqual(stats.mrrByTierCents.gold, 40_000);
    assert.strictEqual(stats.clientsWithActiveCoverage, 3);
    assert.strictEqual(stats.totalCoveredPeople, 6);
    assert.strictEqual(stats.totalBalanceCents, 150_000);
    assert.strictEqual(stats.lifetimeRevenueCents, 1_000_000);
    assert.strictEqual(stats.refundedCents, 25_000);
    assert.deepStrictEqual(stats.referrals, { total: 4, paying: 2, creditIssuedCents: 0 });
  });

  it('splits coverage into active / paused / none', () => {
    const clients: AdminStatsClientRow[] = [
      // active
      client({ billingSeats: 1, coveredPeople: 1, billingBalanceCents: 20_000 }),
      // paused: client turned coverage off
      client({ coverageEnabled: false }),
      // none: enabled but no balance / no people
      client({ coverageEnabled: true, coveredPeople: 0 }),
    ];
    const stats = aggregateAdminStats({
      clients,
      now: NOW,
      lifetimeRevenueCents: 0,
      refundedCents: 0,
      referralsTotal: 0,
      referralsPaying: 0,
      screeningDays: [],
    });
    assert.deepStrictEqual(stats.coverage, { active: 1, paused: 1, none: 1 });
  });

  it('buckets seats with 4+ collapsed and sorted ascending', () => {
    const clients: AdminStatsClientRow[] = [
      client({ billingSeats: 0 }),
      client({ billingSeats: 1 }),
      client({ billingSeats: 4 }),
      client({ billingSeats: 7 }),
      client({ billingSeats: 9 }),
    ];
    const stats = aggregateAdminStats({
      clients,
      now: NOW,
      lifetimeRevenueCents: 0,
      refundedCents: 0,
      referralsTotal: 0,
      referralsPaying: 0,
      screeningDays: [],
    });
    assert.deepStrictEqual(stats.seatDistribution, [
      { seats: 0, clients: 1 },
      { seats: 1, clients: 1 },
      { seats: 4, clients: 3 },
    ]);
  });

  it('counts clients created in the current calendar month', () => {
    const clients: AdminStatsClientRow[] = [
      client({ createdAt: new Date('2026-06-01T00:00:00.000Z') }),
      client({ createdAt: new Date('2026-06-30T23:59:59.000Z') }),
      client({ createdAt: new Date('2026-05-31T23:59:59.000Z') }),
    ];
    const stats = aggregateAdminStats({
      clients,
      now: NOW,
      lifetimeRevenueCents: 0,
      refundedCents: 0,
      referralsTotal: 0,
      referralsPaying: 0,
      screeningDays: [],
    });
    assert.strictEqual(stats.newClientsThisMonth, 2);
  });

  it('sums referral credit issued across clients', () => {
    const clients: AdminStatsClientRow[] = [
      client({ referralCreditCents: 10_000 }),
      client({ referralCreditCents: 5_000 }),
    ];
    const stats = aggregateAdminStats({
      clients,
      now: NOW,
      lifetimeRevenueCents: 0,
      refundedCents: 0,
      referralsTotal: 2,
      referralsPaying: 1,
      screeningDays: [],
    });
    assert.strictEqual(stats.referrals.creditIssuedCents, 15_000);
  });

  it('builds a dense ascending 90-day cumulative screening trend', () => {
    const trend = buildScreeningTrend(NOW, [
      { date: '2026-06-15', count: 3 }, // today
      { date: '2026-06-14', count: 2 }, // yesterday
      { date: '2026-01-01', count: 9 }, // outside the window — ignored
    ]);

    assert.strictEqual(trend.length, SCREENING_TREND_DAYS);
    const first = trend.at(0);
    const penultimate = trend.at(-2);
    const last = trend.at(-1);
    assert.ok(first);
    assert.ok(penultimate);
    assert.ok(last);
    // Ascending dates, last day is "today".
    assert.strictEqual(last.date, '2026-06-15');
    assert.strictEqual(first.date, '2026-03-18');
    // Cumulative is monotonically non-decreasing.
    const cumulatives: number[] = trend.map((p) => p.cumulative);
    for (let i = 1; i < cumulatives.length; i += 1) {
      assert.ok((cumulatives[i] ?? 0) >= (cumulatives[i - 1] ?? 0));
    }
    // Only the two in-window days contribute: 2 (yesterday) then +3 (today).
    assert.strictEqual(penultimate.cumulative, 2);
    assert.strictEqual(last.cumulative, 5);
  });
});
