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

/// The client's overall membership tier. Silver and Gold both require
/// active coverage (a positive prepaid balance). The tier is then set
/// by the number of active members: one unlocks Silver, four unlock
/// Gold (with priority reports). Emerald sits above Gold and is awarded
/// by an admin flipping a flag on the client (Advisory chat info →
/// admin toggles); it overrides the automatic Bronze/Silver/Gold rules
/// so a Emerald client is purely Emerald regardless of their seat
/// count. Shown on the Membership screen and used in the admin view
/// to colour each client's Advisory chat.
public enum GoldilocksMembershipTier: String, Codable, Sendable, Equatable, CaseIterable {
    case bronze
    case silver
    case gold
    case emerald

    /// Active-member thresholds — one source of truth for the tier math
    /// and the user-facing copy.
    public static let silverMemberThreshold: Int = 1
    public static let goldMemberThreshold: Int = 4

    /// Human-facing tier name.
    public var displayName: String {
        switch self {
        case .bronze: return "Bronze"
        case .silver: return "Silver"
        case .gold: return "Gold"
        case .emerald: return "Emerald"
        }
    }

    /// One-line explanation of how this tier is reached. Always names
    /// both Silver and Gold thresholds so the client can see what it
    /// takes to move up regardless of which tier they're on today.
    public var membershipDetail: String {
        switch self {
        case .bronze:
            return "Bronze is the free plan. One active member unlocks Silver, and four unlock Gold with priority reports."
        case .silver:
            return "Silver applies with active coverage for one or more members. Reach four members for Gold with priority reports."
        case .gold:
            return "Gold delivers priority reports for plans with four or more active members."
        case .emerald:
            return "Emerald is awarded by Goldilocks and supersedes the automatic tier."
        }
    }

    /// The membership tier for a given active-member count. Emerald
    /// is an admin-controlled override and trumps the automatic rules.
    /// Without coverage the client is Bronze regardless of headcount.
    public init(activeMembers: Int, hasActiveCoverage: Bool, emeraldEnabled: Bool = false) {
        if emeraldEnabled {
            self = .emerald
            return
        }
        guard hasActiveCoverage else {
            self = .bronze
            return
        }
        if activeMembers >= Self.goldMemberThreshold {
            self = .gold
        } else if activeMembers >= Self.silverMemberThreshold {
            self = .silver
        } else {
            self = .bronze
        }
    }

    /// The membership tier inferred from the backend's reported monthly
    /// rate in cents. Used by the admin grid, which knows the rate but
    /// not the headcount directly. Reverses the per-person price set in
    /// `GoldilocksPlan`.
    public init(monthlyRateCents cents: Int, hasActiveCoverage: Bool, emeraldEnabled: Bool = false) {
        let perPerson: Int = GoldilocksPlan.monthlyPricePerPersonCents
        let activeMembers: Int = perPerson > 0 ? cents / perPerson : 0
        self.init(activeMembers: activeMembers, hasActiveCoverage: hasActiveCoverage, emeraldEnabled: emeraldEnabled)
    }
}
