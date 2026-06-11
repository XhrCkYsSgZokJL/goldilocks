import Foundation

public extension ConversationMember {
    /// Returns a copy with the supplied description merged into the profile
    /// metadata when the member's own profile doesn't carry one yet. Used to
    /// keep the template description on the agent contact card after the real
    /// agent joins but before it writes its `description` metadata -- a no-op
    /// when the profile already has a description or none is supplied. The
    /// copy is only ever handed to the messages-list repository, never
    /// inserted into `conversation.members`.
    func withFallbackAgentDescription(_ fallbackText: String?) -> ConversationMember {
        guard let fallbackText, !fallbackText.isEmpty, profile.agentDescription == nil else { return self }
        var metadata: ProfileMetadata = profile.metadata ?? [:]
        metadata["description"] = .string(fallbackText)
        let updatedProfile = Profile(
            inboxId: profile.inboxId,
            conversationId: profile.conversationId,
            name: profile.name,
            avatar: profile.avatar,
            avatarSalt: profile.avatarSalt,
            avatarNonce: profile.avatarNonce,
            avatarKey: profile.avatarKey,
            isAgent: profile.isAgent,
            imageSourceContentDigest: profile.imageSourceContentDigest,
            metadata: metadata
        )
        return ConversationMember(
            profile: updatedProfile,
            role: role,
            isCurrentUser: isCurrentUser,
            isAgent: isAgent,
            agentVerification: agentVerification,
            invitedBy: invitedBy,
            joinedAt: joinedAt
        )
    }
}
