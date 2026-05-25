import Foundation

/// How the client pays for coverage. Card routes to Stripe; crypto is
/// reserved until a crypto payment provider is chosen.
public enum GoldilocksPaymentMethod: String, Codable, Sendable, Equatable, CaseIterable {
    case card
    case crypto

    /// Human-facing label.
    public var displayName: String {
        switch self {
        case .card: return "Card"
        case .crypto: return "Crypto"
        }
    }
}

/// Top-up lengths offered when buying coverage. The raw value is the
/// number of months the top-up pays for, at the current monthly rate.
/// Capped at 6 months so a pro-rata refund on cancellation always stays
/// within Stripe's refund window.
public enum GoldilocksPrepaidDuration: Int, Codable, Sendable, Equatable, CaseIterable {
    case oneMonth = 1
    case threeMonths = 3
    case sixMonths = 6

    /// Number of months this top-up pays for.
    public var months: Int { rawValue }

    /// Clean, human-facing label.
    public var displayName: String {
        switch self {
        case .oneMonth: return "1 month"
        case .threeMonths: return "3 months"
        case .sixMonths: return "6 months"
        }
    }
}

/// The client's overall membership tier, set by how much they spend with
/// us per month: Gold from $200/mo, Silver from $100/mo, Bronze below
/// that (the free tier). Shown to the client on the Membership screen and
/// used in the admin view to colour each client's Advisory chat.
public enum GoldilocksMembershipTier: String, Codable, Sendable, Equatable, CaseIterable {
    case bronze
    case silver
    case gold

    /// Human-facing tier name.
    public var displayName: String {
        switch self {
        case .bronze: return "Bronze"
        case .silver: return "Silver"
        case .gold: return "Gold"
        }
    }

    /// One-line explanation of how this tier is reached.
    public var membershipDetail: String {
        switch self {
        case .bronze: return "Bronze is the free plan. Add people to move up a tier."
        case .silver: return "Silver applies once you're spending at least $100/mo."
        case .gold: return "Gold applies once you're spending at least $200/mo."
        }
    }

    /// The membership tier for a monthly spend in whole US dollars: Gold
    /// from $200/mo, Silver from $100/mo, Bronze below that.
    public init(monthlyTotalDollars dollars: Int) {
        switch dollars {
        case 200...: self = .gold
        case 100...: self = .silver
        default: self = .bronze
        }
    }

    /// The membership tier for a monthly spend in cents.
    public init(monthlyRateCents cents: Int) {
        self.init(monthlyTotalDollars: cents / 100)
    }
}
