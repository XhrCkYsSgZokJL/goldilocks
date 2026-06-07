import Foundation

// MARK: - Conversation

public struct Conversation: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let clientConversationId: String
    public let creator: ConversationMember
    public let createdAt: Date
    public let consent: Consent
    public let kind: ConversationKind
    public let name: String?
    public let description: String?
    public let members: [ConversationMember]
    public let otherMember: ConversationMember?
    public let messages: [Message]
    public let isPinned: Bool
    public let isUnread: Bool
    public let isMuted: Bool
    public let pinnedOrder: Int?
    /// Per-conversation UI flag set by the contacts picker when it seeds a
    /// new conversation with members. Suppresses the QR invite header in
    /// the messages list so the user doesn't see an empty-state CTA on a
    /// chat that already has members. The plus-menu "Convo code" entry
    /// still reaches the QR on demand.
    public let hidesInviteCard: Bool
    public let lastMessage: MessagePreview?
    public let imageURL: URL?
    public let imageSalt: Data?
    public let imageNonce: Data?
    public let imageEncryptionKey: Data?
    public let conversationEmoji: String?
    public let includeInfoInPublicPreview: Bool
    public let isDraft: Bool
    public let invite: Invite?
    public let expiresAt: Date?
    public let debugInfo: ConversationDebugInfo
    public let isLocked: Bool
    public let agentJoinStatus: AgentJoinStatus?
    public let hasHadVerifiedAgent: Bool
    /// True when this conversation was created through the Agent Builder
    /// (an `AgentBuilderSummary` row exists for it). Drives the
    /// pending-agent presentation -- "New Agent" placeholder name + the
    /// add-agent avatar instead of the generic "New Convo" + emoji circle
    /// -- until a verified agent actually joins. See
    /// `isPendingAgentBuilderDraft`.
    public let wasCreatedFromAgentBuilder: Bool
}

public extension Conversation {
    static let maxMembers: Int = 150

    /// True iff this conversation was created by a trusted Goldilocks
    /// server agent (admins-agent, reports-agent). The agent owns the
    /// group and reprovisions on demand, so the UI treats these as
    /// system channels — no swipe-to-delete, no hide-on-consent-deny.
    var isGoldilocksManaged: Bool {
        GoldilocksAgentTrust.contains(inboxId: creator.profile.inboxId)
    }

    /// True iff this conversation looks like a Goldilocks-managed
    /// channel (creator is a trusted agent) but isn't in the calling
    /// client's owned channel set. Happens when stale MLS state from a
    /// previous role (e.g. this device was an admin earlier) leaves
    /// the user as a member of other clients' Advisories. Filtered out
    /// of the conversations list so only this client's channels show.
    var isStaleGoldilocksChannel: Bool {
        guard isGoldilocksManaged else { return false }
        guard GoldilocksOwnedChannels.isLoaded else { return false }
        return !GoldilocksOwnedChannels.contains(xmtpGroupId: id)
    }

    /// True for a group with no name and no members besides the current
    /// user — an unused or abandoned conversation left behind by the
    /// new-conversation prewarm. It can only render as the placeholder
    /// "New Channel", so the conversations list filters it out. Goldilocks
    /// agent-managed channels are exempt: the agent always gives them a
    /// name and members, and `isStaleGoldilocksChannel` already governs them.
    var isEmptyPlaceholderConversation: Bool {
        guard !isGoldilocksManaged else { return false }
        guard !creator.isCurrentUser else { return false }
        guard kind != .dm else { return false }
        guard name?.isEmpty ?? true else { return false }
        return membersWithoutCurrent.isEmpty
    }

    var isForked: Bool {
        debugInfo.commitLogForkStatus == .forked
    }

    var hasJoined: Bool {
        members.contains(where: { $0.isCurrentUser })
    }

    var membersWithoutCurrent: [ConversationMember] {
        members.filter { !$0.isCurrentUser }
    }

    var displayName: String {
        computedDisplayName
    }

    var computedDisplayName: String {
        computedDisplayName(memberNameOverride: { _ in nil })
    }

    /// `computedDisplayName` with an inbox → contact-name override applied
    /// to the auto-generated unnamed-group title and to DM titles. The
    /// override wins over the per-conversation profile name (mirrors
    /// `Profile`/`ConversationMember`'s override semantics). When the
    /// conversation already has an explicit `name`, it's returned verbatim
    /// — the override only affects auto-generated titles.
    /// True while an Agent-Builder-created conversation is still waiting on
    /// its verified agent to join. In this window the conversation has only
    /// the local user as a member, so it would otherwise render as the
    /// generic "New Convo" + emoji circle; instead we surface the
    /// pending-agent identity ("New Agent" + add-agent avatar) to match the
    /// builder indicator. Gated on the sticky `hasHadVerifiedAgent` flag
    /// (set once any Convos-verified agent has joined) rather than the
    /// current member list, so the hand-off to normal member-driven
    /// rendering is permanent -- a builder agent that later leaves doesn't
    /// flip the conversation back to the "New Agent" placeholder.
    var isPendingAgentBuilderDraft: Bool {
        wasCreatedFromAgentBuilder && !hasHadVerifiedAgent
    }

    func computedDisplayName(memberNameOverride: (String) -> String?) -> String {
        if let name, !name.isEmpty {
            return name
        }
        if isPendingAgentBuilderDraft {
            return "New Agent"
        }
        if kind == .dm {
            if let other = otherMember {
                return other.displayName(memberNameOverride: memberNameOverride)
            }
            return "Somebody"
        }
        let otherMembers = membersWithoutCurrent
        if otherMembers.isEmpty {
            return "New Channel"
        }
        return otherMembers.formattedNamesString(memberNameOverride: memberNameOverride)
    }

    var isFullyAnonymous: Bool {
        let otherMembers = membersWithoutCurrent
        guard !otherMembers.isEmpty else { return false }
        return !otherMembers.map(\.profile).hasAnyNamedProfile
    }

    /// A stored emoji the user actually picked, or nil when the stored value
    /// is just the auto-generated default. New channels auto-seed the
    /// deterministic `EmojiSelector.emoji(for:)` into group metadata; treating
    /// that as "not chosen" lets the suggested-icon rotation cycle a blank
    /// draft while still honoring an emoji the user explicitly set.
    var userChosenEmoji: String? {
        guard let conversationEmoji, !conversationEmoji.isEmpty else { return nil }
        if conversationEmoji == EmojiSelector.emoji(for: clientConversationId) {
            return nil
        }
        return conversationEmoji
    }

    var defaultEmoji: String {
        if let userChosenEmoji {
            return userChosenEmoji
        }
        return EmojiSelector.emoji(
            for: clientConversationId,
            offset: SuggestedEmojiRotation.offset(for: clientConversationId)
        )
    }

    var avatarType: ConversationAvatarType {
        // A pending agent-builder draft shows the add-agent glyph (matching
        // the builder bar / indicator) rather than the conversation emoji,
        // even before the verified agent joins. Checked before the
        // image/member branches so a user-only draft doesn't fall through
        // to the emoji circle.
        if isPendingAgentBuilderDraft {
            return .pendingAgent
        }
        if imageURL != nil {
            return .customImage
        }
        let otherMembers = membersWithoutCurrent
        if otherMembers.count == 1, let member = otherMembers.first {
            return .profile(member.profile, member.agentVerification)
        }
        if let userChosenEmoji {
            return .emoji(userChosenEmoji)
        }
        let otherProfiles = otherMembers.map(\.profile)
        if otherProfiles.isEmpty || !otherProfiles.hasAnyAvatar {
            return .emoji(defaultEmoji)
        }
        return .clustered(Array(otherProfiles.sortedForCluster().prefix(7)))
    }

    var memberNamesString: String {
        membersWithoutCurrent.formattedNamesString
    }

    var membersCountString: String {
        let totalCount = members.count
        return "\(totalCount) \(totalCount == 1 ? "member" : "members")"
    }

    var membersCountStringCapitalized: String {
        let totalCount = members.count
        return "\(totalCount) \(totalCount == 1 ? "Member" : "Members")"
    }

    var agentCount: Int {
        members.filter(\.isAgent).count
    }

    var verifiedConvosAgentCount: Int {
        members.filter(\.agentVerification.isConvosAgent).count
    }

    var hasAgent: Bool {
        agentCount > 0
    }

    var hasVerifiedConvosAgent: Bool {
        members.contains(where: \.agentVerification.isConvosAgent)
    }

    var hasEverHadVerifiedConvosAgent: Bool {
        hasHadVerifiedAgent
    }

    var hasVerifiedAgent: Bool {
        members.contains(where: \.agentVerification.isVerified)
    }

    var agentCountString: String? {
        let verified = verifiedConvosAgentCount
        let unverified = agentCount - verified
        var parts: [String] = []
        if verified > 0 {
            parts.append("\(verified) \(verified == 1 ? "Agent" : "Agents")")
        }
        if unverified > 0 {
            parts.append("\(unverified) \(unverified == 1 ? "Agent" : "Agents")")
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: ", ")
    }

    var shouldShowQuickEdit: Bool {
        (hasJoined && members.count <= 1) || isDraft
    }

    /// Posts a notification that the current user has left this conversation.
    func postLeftConversationNotification() {
        NotificationCenter.default.post(
            name: .leftConversationNotification,
            object: nil,
            userInfo: ["conversationId": id]
        )
    }

    var xmtpGroupTopic: String {
        id.xmtpGroupTopicFormat
    }

    /// A conversation is considered full when it has reached the XMTP group limit.
    /// When full, new invites cannot be shared. Note: members can still leave, which
    /// would make space available again.
    var isFull: Bool {
        members.count >= Self.maxMembers
    }

    var isPendingInvite: Bool {
        isDraft && !hasJoined
    }

    var scheduledExplosionDate: Date? {
        let now = Date()
        guard let expiresAt,
              expiresAt > now else { return nil }
        let oneYearFromNow = now.addingTimeInterval(365 * 24 * 60 * 60)
        guard expiresAt < oneYearFromNow else { return nil }
        return expiresAt
    }
}
