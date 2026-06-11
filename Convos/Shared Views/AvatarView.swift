import ConvosCore
import SwiftUI

struct AvatarView: View {
    let fallbackName: String
    let cacheableObject: any ImageCacheable
    let placeholderImage: UIImage?
    let placeholderEmoji: String?
    let placeholderImageName: String?
    let agentVerification: AgentVerification
    /// Forwarded to the emoji/monogram fallbacks so they render without a
    /// `GeometryReader` when the caller already knows the avatar size (see
    /// `EmojiAvatarView.size`). Nil keeps the self-sizing path.
    let explicitSize: CGFloat?
    @State private var cachedImage: UIImage?

    init(
        fallbackName: String,
        cacheableObject: any ImageCacheable,
        placeholderImage: UIImage?,
        placeholderEmoji: String? = nil,
        placeholderImageName: String?,
        agentVerification: AgentVerification = .unverified,
        explicitSize: CGFloat? = nil
    ) {
        self.fallbackName = fallbackName
        self.cacheableObject = cacheableObject
        self.placeholderImage = placeholderImage
        self.placeholderEmoji = placeholderEmoji
        self.placeholderImageName = placeholderImageName
        self.agentVerification = agentVerification
        self.explicitSize = explicitSize
        _cachedImage = State(initialValue: ImageCache.shared.image(for: cacheableObject))
    }

    var body: some View {
        Group {
            if let image = placeholderImage ?? cachedImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .aspectRatio(contentMode: .fill)
            } else if let placeholderEmoji, !placeholderEmoji.isEmpty {
                EmojiAvatarView(emoji: placeholderEmoji, agentVerification: agentVerification, size: explicitSize)
            } else if let placeholderImageName {
                Image(systemName: placeholderImageName)
                    .resizable()
                    .scaledToFit()
                    .aspectRatio(contentMode: .fill)
                    .symbolEffect(.bounce.up.byLayer, options: .nonRepeating)
                    .padding(DesignConstants.Spacing.step2x)
                    .foregroundStyle(.colorTextPrimaryInverted)
                    .background(agentVerification.avatarBackgroundColor)
            } else {
                MonogramView(name: fallbackName, agentVerification: agentVerification, size: explicitSize)
            }
        }
        .aspectRatio(1.0, contentMode: .fit)
        .clipShape(Circle())
        .cachedImage(for: cacheableObject, into: $cachedImage)
        .accessibilityHidden(true)
    }
}

struct ProfileAvatarView: View {
    let profile: Profile
    let profileImage: UIImage?
    let useSystemPlaceholder: Bool
    var agentVerification: AgentVerification = .unverified
    /// Forwarded to `AvatarView` so the emoji/monogram fallbacks skip their
    /// `GeometryReader` when the size is already known (clustered avatars).
    var size: CGFloat?

    private var isGoldilocksBot: Bool {
        profile.isAgent || GoldilocksAgentTrust.contains(inboxId: profile.inboxId)
    }

    var body: some View {
        if isGoldilocksBot, profileImage == nil, let botImage = BrandConfig.shared.assets.botImageName {
            Image(botImage)
                .resizable()
                .scaledToFill()
                .aspectRatio(1.0, contentMode: .fit)
                .clipShape(Circle())
        } else {
            AvatarView(
                fallbackName: profile.displayName,
                cacheableObject: profile,
                placeholderImage: profileImage,
                placeholderEmoji: profile.profileEmoji,
                placeholderImageName: useSystemPlaceholder ? "person.crop.circle.fill" : nil,
                agentVerification: profile.isAgent ? agentVerification : .unverified,
                explicitSize: size
            )
        }
    }
}

/// Lightweight avatar optimized for scroll performance in conversation lists.
/// Uses the new cachedImage modifier for automatic loading and URL change detection.
struct ConversationAvatarView: View {
    let conversation: Conversation
    let conversationImage: UIImage?
    /// Forwarded to the emoji/monogram/clustered fallbacks so they render
    /// without a `GeometryReader` when the caller knows the avatar size (the
    /// pinned cell passes its fixed avatar size). Nil keeps the self-sizing
    /// path for list rows that only constrain with an outer `.frame`.
    var size: CGFloat?

    @State private var cachedImage: UIImage?
    @Environment(\.memberNameOverride) private var memberNameOverride: @Sendable (String) -> String?

    var body: some View {
        Group {
            if conversation.isGoldilocksGroup {
                goldilocksAvatar
            } else if let conversationImage {
                Image(uiImage: conversationImage)
                    .resizable()
                    .scaledToFill()
            } else if let image = cachedImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                fallbackContent
            }
        }
        .aspectRatio(1.0, contentMode: .fit)
        .clipShape(Circle())
        .cachedImage(for: conversation, into: $cachedImage)
    }

    private var currentTier: GoldilocksMembershipTier {
        let plan: GoldilocksSeatPlan = GoldilocksSeatPlan.shared
        let emerald: Bool = GoldilocksSession.shared.identity?.emeraldMembershipEnabled ?? false
        return GoldilocksMembershipTier(
            activeMembers: plan.billableSeatCount,
            hasActiveCoverage: plan.coverageActive,
            emeraldEnabled: emerald
        )
    }

    @ViewBuilder
    private var goldilocksAvatar: some View {
        let groupName: String = conversation.name ?? ""
        if let imageName = GoldilocksConfig.iconImageName(for: groupName, tier: currentTier) {
            Image(imageName)
                .resizable()
                .scaledToFill()
        } else {
            let symbol: String = GoldilocksConfig.iconSymbolName(for: groupName)
            ZStack {
                Circle()
                    .fill(Color.colorFillPrimary)
                Image(systemName: symbol)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.white)
                    .padding(12)
            }
        }
    }

    @ViewBuilder
    private var fallbackContent: some View {
        switch conversation.avatarType {
        case .customImage:
            MonogramView(name: conversation.computedDisplayName(memberNameOverride: memberNameOverride), size: size)
        case let .profile(profile, verification):
            let isBotProfile: Bool = profile.isAgent || GoldilocksAgentTrust.contains(inboxId: profile.inboxId)
            if isBotProfile, let botImage = BrandConfig.shared.assets.botImageName {
                Image(botImage)
                    .resizable()
                    .scaledToFill()
            } else if let emoji = profile.profileEmoji, !emoji.isEmpty {
                EmojiAvatarView(emoji: emoji, agentVerification: verification, size: size)
            } else if verification == .unverified {
                EmojiAvatarView(emoji: conversation.defaultEmoji, size: size)
            } else {
                MonogramView(name: profile.displayName, agentVerification: verification, size: size)
            }
        case .clustered(let profiles):
            ClusteredAvatarView(profiles: profiles, size: size)
        case .emoji(let emoji):
            EmojiAvatarView(emoji: emoji, size: size)
        case .monogram(let name):
            MonogramView(name: name, size: size)
        case .pendingAgent:
            PendingAgentAvatarView()
        }
    }
}

struct PendingAgentAvatarView: View {
    var body: some View {
        GeometryReader { geometry in
            let side = min(geometry.size.width, geometry.size.height)
            // Size the glyph proportionally rather than with a fixed inset so
            // it reads like an emoji avatar (centered, with breathing room) at
            // any avatar size -- a touch larger than `EmojiAvatarView`'s 0.43
            // emoji since the glyph carries no internal whitespace.
            let glyphSide = side * 0.5
            ZStack {
                Circle()
                    .fill(Color.black)
                Image("addAgentIcon")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.white)
                    .frame(width: glyphSide, height: glyphSide)
            }
            .frame(width: side, height: side)
        }
        .aspectRatio(1.0, contentMode: .fit)
    }
}

/// Lightweight avatar optimized for scroll performance in lists.
/// Uses the new cachedImage modifier for automatic loading and URL change detection.
struct MessageAvatarView: View {
    let profile: Profile
    let size: CGFloat
    var agentVerification: AgentVerification = .unverified

    @State private var cachedImage: UIImage?

    var body: some View {
        Group {
            let isBotProfile: Bool = profile.isAgent || GoldilocksAgentTrust.contains(inboxId: profile.inboxId)
            if let image = cachedImage {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else if isBotProfile, let botImage = BrandConfig.shared.assets.botImageName {
                Image(botImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else if let emoji = profile.profileEmoji, !emoji.isEmpty {
                EmojiAvatarView(emoji: emoji, agentVerification: profile.isAgent ? agentVerification : .unverified)
            } else {
                MonogramView(name: profile.displayName, agentVerification: profile.isAgent ? agentVerification : .unverified)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .cachedImage(for: profile, into: $cachedImage)
    }
}

#Preview {
    @Previewable @State var profileImage: UIImage?
    let profile: Profile = .mock(name: "John Doe")
    ProfileAvatarView(profile: profile, profileImage: profileImage, useSystemPlaceholder: true)
}

#Preview {
    @Previewable @State var conversationImage: UIImage?
    let conversation = Conversation.mock(members: [.mock(), .mock()])
    ConversationAvatarView(conversation: conversation, conversationImage: nil)
}
