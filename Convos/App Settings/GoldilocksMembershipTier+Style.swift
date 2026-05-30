import ConvosCore
import SwiftUI

/// SwiftUI styling for the Bronze/Silver/Gold/Emerald membership tiers,
/// shared by the Membership screen badge and the admin channels list.
extension GoldilocksMembershipTier {
    /// SF Symbol shown alongside the tier name. Emerald gets a distinct
    /// glyph so it visually stands apart from the automatic tiers.
    /// SF Symbols doesn't ship an emerald glyph specifically, so we use
    /// `diamond.fill` — the generic gem-shape — coloured with our
    /// emerald green to read as an emerald cut stone.
    private var style: BrandConfig.Tiers.TierStyle? {
        BrandConfig.shared.tiers.styles[rawValue]
    }

    var iconName: String {
        style?.icon ?? "seal.fill"
    }

    var accentColor: Color {
        style?.color ?? .gray
    }

    /// Faint wash placed behind tier-coloured rows and badges.
    var tintColor: Color {
        accentColor.opacity(0.16)
    }
}
