# Admin Stats Page

**Status:** Implemented
**Date:** 2026-06-03
**Owner:** Morgan

> Built per the decisions below: channel-health was dropped, Swift Charts is
> used for the tier donut and seat histogram. See "What was built" at the end.

## Summary

Add a new admin-only **Stats** row to the app settings page, in the "Settings & Legal"
section directly above **Customize**. Tapping it opens a dashboard giving a Goldilocks
operator an at-a-glance view of the business: client counts, membership tiers, revenue,
coverage/seats, channel health, and a per-client table.

The row is gated to app-level admins (`GoldilocksSession.shared.isAdmin`), the same gate
already used for the **Debug** row. Clients never see it.

## Why

Admins currently have no in-app overview of the application. `/v2/admin/channels`
returns raw per-client rows but nothing aggregated, so there is no way to answer
"how many paying clients do we have", "what's MRR", "how is the tier mix moving",
or "which channels are broken" without going to the database. This page surfaces that.

## Scope

In scope:
- Admin-only Stats row in `AppSettingsView`.
- A `StatsView` dashboard (KPI cards, charts, tables).
- A new aggregation endpoint `GET /v2/admin/stats`.
- Reuse of the existing `GET /v2/admin/channels` for the per-client table.

Out of scope (future):
- Time-series / historical trend storage (no snapshot table exists yet).
- Editing/admin actions from the dashboard (read-only for v1).
- Export / CSV.

## How admin gating works (confirmed)

Admin status is an **app-level operator** flag, not a per-group role.

- Backend: `admin_inboxes` allowlist table. `GET /v2/me` returns `isAdmin: boolean`
  (`backend/src/routes/me.ts`). Admin routes re-check `caller.isAdmin` and return
  `403 not_admin` otherwise (pattern in `backend/src/routes/channels.ts`).
- iOS: parsed into `GoldilocksAuth.Identity.isAdmin`, exposed observably as
  `GoldilocksSession.shared.isAdmin` (`Convos/Config/GoldilocksSession.swift`).

We reuse `GoldilocksSession.shared.isAdmin` for the row and the same `caller.isAdmin`
check on the new endpoint.

## Page design

### Header
Title "Stats", pull-to-refresh, an "as of <timestamp>" caption, loading + error states.

### 1. Overview — KPI cards
A grid of headline numbers from `/v2/admin/stats`:

- Total clients
- Clients with active coverage (paying)
- New clients this month
- MRR (sum of monthly rate across active-coverage clients)
- Total prepaid balance held
- Total covered persons

### 2. Membership tiers
Tiers are `bronze | silver | gold | emerald`, computed by
`computeTier(billingSeats, hasActiveCoverage, emeraldEnabled)`
(`backend/src/billing/tier.ts`; silver ≥1 seat, gold ≥4, emerald = admin flag).

- Donut or horizontal bar chart of client count by tier (use tier colors from `brand.json`).
- Small table: tier, client count, % of total, combined MRR.

### 3. Revenue
- Lifetime completed checkout revenue (sum of `billing_checkouts.amount_cents` where
  `status = 'completed'`), minus refunds.
- MRR (same value as overview, shown in context).
- Refunded total.
- Optional: card vs crypto split (currently card only).

### 4. Coverage & seats
- Coverage active vs paused vs none (counts).
- Seat distribution histogram (how many clients at 1, 2, 3, 4+ seats).
- Total covered persons.

### 5. Referrals
- Total referral credit issued.
- Count of referrals and paying referrals.
- Redemption rate (referrals with discount applied / total).

### 7. Clients table
Scrollable/sortable table driven by `GET /v2/admin/channels` (already exists, already
admin-gated, already has an iOS client method `fetchGoldilocksAdminChannels()`):

| Client # | Tier | Seats | Monthly rate | Balance | Coverage | Created |
|----------|------|-------|--------------|---------|----------|---------|

Tap a row → (future) client detail; v1 can be display-only.

## Data sources

| Section | Source | Exists today? |
|---------|--------|---------------|
| Per-client table | `GET /v2/admin/channels` | ✅ yes (incl. iOS method) |
| All KPIs / charts | `GET /v2/admin/stats` | ❌ **new endpoint** |
| Admin gate | `GoldilocksSession.shared.isAdmin` | ✅ yes |

The backend has all the raw data (`clients`, `covered_persons`, `billing_checkouts`,
`referrals`, `client_channels`) but **no aggregation endpoint** — that is the main new
backend work.

## New backend endpoint

`GET /v2/admin/stats` — admin-gated (mirror the `caller.isAdmin` → `403 not_admin`
check from `channels.ts`). Single response computed with aggregate SQL queries.

Proposed shape (define in `shared/api-types.ts`, then `npm run codegen` to emit Swift
Codable + Zod):

```ts
/** @swift GoldilocksAdminStatsResponse */
export interface AdminStatsResponse {
  totalClients: number;
  newClientsThisMonth: number;
  clientsWithActiveCoverage: number;
  totalCoveredPeople: number;
  mrrCents: number;
  totalBalanceCents: number;

  clientsByTier: { bronze: number; silver: number; gold: number; emerald: number };
  mrrByTierCents: { bronze: number; silver: number; gold: number; emerald: number };

  lifetimeRevenueCents: number;      // completed checkouts
  refundedCents: number;
  seatDistribution: { seats: number; clients: number }[];

  coverage: { active: number; paused: number; none: number };
  channels: { active: number; exploded: number; recreated: number };
  referrals: { total: number; paying: number; creditIssuedCents: number };

  asOf: string; // ISO8601
}
```

Implementation notes:
- Tier counts: either compute in SQL or fetch the seat/coverage/emerald columns and run
  `computeTier(...)` per row in TS (reuse the existing function to avoid drift).
- MRR = Σ monthly rate over clients with active coverage; reuse `monthlyTotalCents(seats)`
  / `isCoverageActive(...)` helpers already in `channels.ts`.
- All counts are point-in-time (no history table yet).

## iOS implementation

Files to add:
- `Convos/App Settings/StatsView.swift` — SwiftUI dashboard. Follow `CustomizeSettingsView`
  structure (a `List` with sections, brand color tokens like `.colorTextPrimary`,
  `.colorFillMinimal`, `DesignConstants.Spacing`).
- `Convos/App Settings/StatsViewModel.swift` — `@MainActor @Observable`, loads stats +
  channels concurrently, exposes `isLoading`, `error`, `stats`, `clients`, and a
  `refresh()`.

Files to change:
- `ConvosCore/.../API/ConvosAPIClient.swift` — add
  `func fetchGoldilocksAdminStats() async throws -> ConvosAPI.GoldilocksAdminStatsResponse`
  to `ConvosAPIClientProtocol` and the concrete client (GET `/v2/admin/stats`). The
  response type is generated by codegen.
- `Convos/App Settings/AppSettingsView.swift` — insert the gated row immediately above
  the Customize `Section` (~line 230):

```swift
if GoldilocksSession.shared.isAdmin {
    NavigationLink {
        StatsView(session: session)
    } label: {
        HStack(spacing: DesignConstants.Spacing.step2x) {
            Image(systemName: "chart.bar.fill")
                .foregroundStyle(.colorTextPrimary)
                .frame(width: Constant.settingsIconWidth, alignment: .center)
            Text("Stats")
                .foregroundStyle(.colorTextPrimary)
            Spacer()
        }
    }
    .listRowInsets(.init(top: 0, leading: DesignConstants.Spacing.step4x, bottom: 0, trailing: 10.0))
}
```

(The brief says the Stats row is part of the same section as Customize and sits directly
above it. If "above Customize" is meant as a separate section, lift the `if` block into
its own `Section { }` — confirm with design.)

### Charting
Swift Charts (`import Charts`) is available (min iOS 26) but **not currently used anywhere**
in the app. Recommend adopting it for the tier donut, seat histogram, and coverage/channel
bars. Keep chart bodies small and hoist conditional values to typed `let`s to respect the
project's 100ms type-check budget (see CLAUDE.md). Alternatively, render simple bars with
plain SwiftUI to avoid a new framework dependency.

## Suggested PR stack

1. `admin-stats-plan` — this document.
2. `admin-stats-backend` — `shared/api-types.ts` types + codegen, `GET /v2/admin/stats`
   route + aggregate queries, route tests.
3. `admin-stats-ios-client` — API client method (lands with generated types).
4. `admin-stats-ui` — `StatsView` + `StatsViewModel` + the gated row in `AppSettingsView`.

## Testing / verification

- Backend: unit/integration tests for `/v2/admin/stats` — admin returns data, non-admin
  gets `403`, aggregates correct against seeded fixtures (tier mix, MRR, refunds, coverage).
- iOS: `swift test --package-path ConvosCore` for the client method; SwiftUI preview with
  `.mock` data for `StatsView`; manual check that the row is hidden for clients and shown
  for admins.
- Run `npm run codegen:check`, `/lint`, and the full suite before pushing (per CLAUDE.md).

## What was built

Backend:
- `shared/api-types.ts` — `AdminStatsResponse` + `StatsTierCounts` / `StatsSeatBucket` /
  `StatsCoverage` / `StatsReferrals` (no channel-health field). Generated Swift + Zod
  updated (`GoldilocksAPITypes.generated.swift`, `backend/src/generated/api-schemas.ts`).
- `backend/src/billing/admin-stats.ts` — pure `aggregateAdminStats()` (tier mix, MRR from
  covered people, coverage split, seat buckets with 4+ collapsed, referral credit).
- `backend/src/routes/channels.ts` — `GET /v2/admin/stats`, admin-gated, fetches rows +
  revenue/referral totals and delegates to the pure aggregator.
- `backend/src/billing/admin-stats.test.ts` — 6 passing unit tests.

iOS:
- `ConvosAPI` types + `fetchGoldilocksAdminStats()` on the API client; `fetchAdminStats()`
  on `SessionManagerProtocol` / `SessionManager` (default + mock data).
- `Convos/App Settings/StatsView.swift`, `StatsViewModel.swift`, `StatsFormatting.swift` —
  dashboard with KPI cards, a Swift Charts tier donut and seat histogram, and revenue /
  coverage / referral rows.
- `AppSettingsView.swift` — admin-gated "Stats" row directly above Customize, in the same
  section.

Decisions taken: Stats lives in the same section as Customize (first row); Swift Charts
adopted; v1 is read-only point-in-time (no per-client drill-down yet).

### Revision (post-review)

The page was slimmed to: four KPI boxes — **Clients**, **Memberships** (sum of billing
seats), **MPPC** (memberships per paying client), **Referrals** — then a **90-day
cumulative screenings** line chart, then the **Membership tiers** section. Revenue,
Coverage, and the seat-distribution chart were removed.

"Screenings" needed an event log that didn't exist, so a new append-only `screening_events`
table (migration 028) was added. An event is written on every person activation /
reactivation (`person-activation.ts`) and one per enabled person each month when the
balance tick renews coverage (`daily-tick.ts`); both writes are best-effort and wrapped so
analytics can never break billing. `GET /v2/admin/stats` buckets the last 90 days by UTC
day and `aggregateAdminStats` folds them into a dense, zero-filled cumulative series
(`buildScreeningTrend`, unit-tested). The chart is historical going forward — there's no
back-fill for events before the table existed.

## Open questions / follow-ups

1. v2: deep-link the (future) clients table into a per-client detail.
2. Historical trends would need a periodic snapshot table — out of scope for v1.
3. MRR is computed from covered people (what the monthly tick actually charges), while the
   tier badge uses billing seats — confirm that split reads correctly to admins.
