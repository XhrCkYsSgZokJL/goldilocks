import ConvosCore
import Foundation
import SwiftUI

// Display helpers and view-model-side shaping for the admin Stats
// dashboard. Kept out of StatsView so the view bodies stay small and
// inside the project's type-check budget.

extension Color {
    static let statsBronze: Color = Color(red: 0.80, green: 0.50, blue: 0.20)
    static let statsSilver: Color = Color(red: 0.66, green: 0.66, blue: 0.70)
    static let statsGold: Color = Color(red: 0.90, green: 0.72, blue: 0.20)
    static let statsEmerald: Color = Color(red: 0.15, green: 0.68, blue: 0.45)
}

// A single overview metric card.
struct StatsKPI: Identifiable {
    let id: String
    let value: String
    let label: String
}

// One membership tier, with its client count, monthly revenue, and color.
struct StatsTierStat: Identifiable {
    let id: String
    let label: String
    let count: Int
    let mrrCents: Int
    let color: Color
}

// One day of the cumulative-screenings trend, with a parsed date for the
// chart's x-axis.
struct StatsTrendDay: Identifiable {
    let id: String
    let date: Date
    let cumulative: Int
}

enum StatsFormat {
    // Whole-dollar currency, grouped — e.g. 1_910_000 cents -> "$19,100".
    static func dollars(_ cents: Int) -> String {
        let dollars: Double = Double(cents) / 100.0
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 0
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSNumber(value: dollars)) ?? "$\(Int(dollars))"
    }

    // Friendly "as of" line from an ISO8601 timestamp.
    static func asOf(_ iso: String) -> String {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed: Date? = withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date = parsed else { return iso }
        let output = DateFormatter()
        output.dateStyle = .medium
        output.timeStyle = .short
        return "As of \(output.string(from: date))"
    }

    static func kpis(_ stats: ConvosAPI.GoldilocksAdminStatsResponse) -> [StatsKPI] {
        // MRR = current memberships × $100/mo.
        let mrrCents: Int = stats.membershipsTotal * 100_00
        var items: [StatsKPI] = []
        items.append(StatsKPI(id: "clients", value: "\(stats.totalClients)", label: "Clients"))
        items.append(StatsKPI(id: "memberships", value: "\(stats.membershipsTotal)", label: "Memberships"))
        items.append(StatsKPI(id: "referrals", value: "\(stats.referrals.total)", label: "Referrals"))
        items.append(StatsKPI(id: "mrr", value: dollars(mrrCents), label: "MRR"))
        return items
    }

    // Parse the trend points (UTC "YYYY-MM-DD") into dated rows for the chart.
    static func trend(_ points: [ConvosAPI.GoldilocksStatsTrendPoint]) -> [StatsTrendDay] {
        let parser = DateFormatter()
        parser.dateFormat = "yyyy-MM-dd"
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.locale = Locale(identifier: "en_US_POSIX")
        return points.compactMap { (point: ConvosAPI.GoldilocksStatsTrendPoint) -> StatsTrendDay? in
            guard let date = parser.date(from: point.date) else { return nil }
            return StatsTrendDay(id: point.date, date: date, cumulative: point.cumulative)
        }
    }

    static func tiers(_ stats: ConvosAPI.GoldilocksAdminStatsResponse) -> [StatsTierStat] {
        let counts = stats.clientsByTier
        let mrr = stats.mrrByTierCents
        var result: [StatsTierStat] = []
        result.append(StatsTierStat(id: "bronze", label: "Bronze", count: counts.bronze, mrrCents: mrr.bronze, color: .statsBronze))
        result.append(StatsTierStat(id: "silver", label: "Silver", count: counts.silver, mrrCents: mrr.silver, color: .statsSilver))
        result.append(StatsTierStat(id: "gold", label: "Gold", count: counts.gold, mrrCents: mrr.gold, color: .statsGold))
        result.append(StatsTierStat(id: "emerald", label: "Emerald", count: counts.emerald, mrrCents: mrr.emerald, color: .statsEmerald))
        return result
    }
}
