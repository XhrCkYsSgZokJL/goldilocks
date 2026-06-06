import Charts
import ConvosCore
import SwiftUI

/// Admin-only dashboard reached from App Settings (above Customize). Shows
/// an aggregate snapshot of the application — headline counts, a 90-day
/// cumulative-screenings chart, and the membership-tier mix — from
/// `GET /v2/admin/stats`. Read-only.
struct StatsView: View {
    @State private var viewModel: StatsViewModel

    private let gridColumns: [GridItem] = [
        GridItem(.flexible(), spacing: DesignConstants.Spacing.step2x),
        GridItem(.flexible()),
    ]

    init(session: any SessionManagerProtocol) {
        _viewModel = State(initialValue: StatsViewModel(session: session))
    }

    var body: some View {
        List {
            switch viewModel.state {
            case .loading:
                loadingRow
            case .failed(let message):
                failedRow(message)
            case .loaded(let stats):
                content(stats)
            }
        }
        .scrollContentBackground(.hidden)
        .background(.colorBackgroundRaisedSecondary)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await viewModel.load() }
        .task { await viewModel.load() }
    }

    @ViewBuilder
    private func content(_ stats: ConvosAPI.GoldilocksAdminStatsResponse) -> some View {
        headerSection(stats)
        overviewSection(stats)
        screeningsSection(stats)
        tiersSection(stats)
    }

    // MARK: - Sections

    @ViewBuilder
    private func headerSection(_ stats: ConvosAPI.GoldilocksAdminStatsResponse) -> some View {
        Section {
            VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepX) {
                Text("Stats")
                    .font(.convosTitle)
                    .tracking(Font.convosTitleTracking)
                    .foregroundStyle(.colorTextPrimary)
                Text(StatsFormat.asOf(stats.asOf))
                    .font(.subheadline)
                    .foregroundStyle(.colorTextSecondary)
            }
            .padding(.horizontal, DesignConstants.Spacing.step2x)
            .listRowBackground(Color.clear)
        }
        .listRowSeparator(.hidden)
        .listRowInsets(.all, DesignConstants.Spacing.step2x)
        .listSectionSeparator(.hidden)
    }

    @ViewBuilder
    private func overviewSection(_ stats: ConvosAPI.GoldilocksAdminStatsResponse) -> some View {
        let kpis: [StatsKPI] = StatsFormat.kpis(stats)
        Section {
            LazyVGrid(columns: gridColumns, spacing: DesignConstants.Spacing.step2x) {
                ForEach(kpis) { kpi in
                    StatsCard(value: kpi.value, label: kpi.label)
                }
            }
            .padding(.horizontal, DesignConstants.Spacing.step4x)
            .padding(.vertical, DesignConstants.Spacing.step2x)
            .listRowInsets(.all, 0.0)
            .listRowBackground(Color.clear)
        }
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private func screeningsSection(_ stats: ConvosAPI.GoldilocksAdminStatsResponse) -> some View {
        let days: [StatsTrendDay] = StatsFormat.trend(stats.screeningTrend)
        Section("Screenings · last 90 days") {
            StatsScreeningChart(days: days)
                .frame(height: 220.0)
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.colorFillMinimal)
        }
    }

    @ViewBuilder
    private func tiersSection(_ stats: ConvosAPI.GoldilocksAdminStatsResponse) -> some View {
        let tiers: [StatsTierStat] = StatsFormat.tiers(stats)
        Section("Membership tiers") {
            StatsTierDonut(tiers: tiers)
                .frame(height: 200.0)
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.colorFillMinimal)
            ForEach(tiers) { tier in
                StatsTierRow(tier: tier)
                    .listRowBackground(Color.colorFillMinimal)
            }
        }
    }

    // MARK: - State rows

    private var loadingRow: some View {
        Section {
            HStack {
                Spacer()
                ProgressView()
                Spacer()
            }
            .padding(.vertical, DesignConstants.Spacing.step8x)
            .listRowBackground(Color.clear)
        }
        .listRowSeparator(.hidden)
    }

    private func failedRow(_ message: String) -> some View {
        let retry: () -> Void = { Task { await viewModel.load() } }
        return Section {
            VStack(spacing: DesignConstants.Spacing.step2x) {
                Text("Couldn't load stats")
                    .font(.headline)
                    .foregroundStyle(.colorTextPrimary)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.colorTextSecondary)
                    .multilineTextAlignment(.center)
                Button("Try again", action: retry)
                    .padding(.top, DesignConstants.Spacing.stepX)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, DesignConstants.Spacing.step4x)
            .listRowBackground(Color.clear)
        }
        .listRowSeparator(.hidden)
    }
}

// MARK: - Components

private struct StatsCard: View {
    let value: String
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
            Text(value)
                .font(.title2.weight(.semibold))
                .foregroundStyle(.colorTextPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(.footnote)
                .foregroundStyle(.colorTextSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(DesignConstants.Spacing.step3x)
        .background(
            RoundedRectangle(cornerRadius: DesignConstants.CornerRadius.regular)
                .fill(Color.colorFillMinimal)
        )
    }
}

private struct StatsTierRow: View {
    let tier: StatsTierStat

    var body: some View {
        HStack(spacing: DesignConstants.Spacing.step2x) {
            Circle()
                .fill(tier.color)
                .frame(width: 10.0, height: 10.0)
            Text(tier.label)
                .foregroundStyle(.colorTextPrimary)
            Spacer()
            Text("\(tier.count)")
                .foregroundStyle(.colorTextPrimary)
            Text("\(StatsFormat.dollars(tier.mrrCents))/mo")
                .font(.footnote)
                .foregroundStyle(.colorTextSecondary)
        }
    }
}

private struct StatsTierDonut: View {
    let tiers: [StatsTierStat]

    var body: some View {
        Chart(tiers) { tier in
            SectorMark(
                angle: .value("Clients", tier.count),
                innerRadius: .ratio(0.62),
                angularInset: 1.5
            )
            .foregroundStyle(tier.color)
            .cornerRadius(3.0)
        }
        .chartLegend(.hidden)
        .padding(.vertical, DesignConstants.Spacing.step2x)
    }
}

private struct StatsScreeningChart: View {
    let days: [StatsTrendDay]

    var body: some View {
        Chart(days) { day in
            AreaMark(
                x: .value("Day", day.date),
                y: .value("Screenings", day.cumulative)
            )
            .foregroundStyle(Color.statsEmerald.opacity(0.16))

            LineMark(
                x: .value("Day", day.date),
                y: .value("Screenings", day.cumulative)
            )
            .foregroundStyle(Color.statsEmerald)
            .interpolationMethod(.monotone)
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4))
        }
        .padding(.vertical, DesignConstants.Spacing.step2x)
    }
}

#Preview {
    NavigationStack {
        StatsView(session: MockInboxesService())
    }
}
