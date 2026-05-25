import ConvosCore
import SwiftUI

/// SwiftUI styling for the Bronze/Silver/Gold membership tiers, shared by
/// the Membership screen badge and the admin channels list.
extension GoldilocksMembershipTier {
    /// SF Symbol shown alongside the tier name.
    var iconName: String {
        "seal.fill"
    }

    /// Accent colour for tier text and icons.
    var accentColor: Color {
        switch self {
        case .bronze: return Color(red: 0.72, green: 0.45, blue: 0.20)
        case .silver: return Color(red: 0.52, green: 0.55, blue: 0.60)
        case .gold: return Color(red: 0.80, green: 0.61, blue: 0.13)
        }
    }

    /// Faint wash placed behind tier-coloured rows and badges.
    var tintColor: Color {
        accentColor.opacity(0.16)
    }
}
