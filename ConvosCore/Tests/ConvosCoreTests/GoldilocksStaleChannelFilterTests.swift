@testable import ConvosCore
import Foundation
import Testing

/// Coverage for `Conversation.isStaleGoldilocksChannel` — the filter that
/// keeps the conversations list honest when a device's inbox happens to
/// be a member of Advisory or Reports groups it doesn't *own*. Common
/// causes: keychain reuse across test sessions, prior admin role
/// promotion, or stale MLS state surviving a backend wipe.
///
/// The contract has three branches:
///   1. Trusted creator + id in owned set → NOT stale (the channel is ours).
///   2. Trusted creator + id NOT in owned set → STALE (filter it out).
///   3. Owned set unloaded (`isLoaded == false`) → NOT stale, regardless,
///      so we don't over-filter during the launch window before
///      `/v2/me/channels` returns.
@Suite("Conversation.isStaleGoldilocksChannel", .serialized)
struct GoldilocksStaleChannelFilterTests {
    @Test("trusted creator + id in owned set → not stale")
    func ownedTrustedConversationIsNotStale() {
        let trustedInbox = "trusted-agent-inbox-1"
        GoldilocksAgentTrust.setTrustedInboxIds([trustedInbox])
        GoldilocksOwnedChannels.set(["owned-group-1"])
        defer {
            GoldilocksAgentTrust.setTrustedInboxIds([])
            GoldilocksOwnedChannels.set([])
        }

        let convo = makeConversation(id: "owned-group-1", creatorInboxId: trustedInbox)
        #expect(!convo.isStaleGoldilocksChannel)
    }

    @Test("trusted creator + id NOT in owned set → stale")
    func unownedTrustedConversationIsStale() {
        let trustedInbox = "trusted-agent-inbox-2"
        GoldilocksAgentTrust.setTrustedInboxIds([trustedInbox])
        GoldilocksOwnedChannels.set(["owned-group-2"])
        defer {
            GoldilocksAgentTrust.setTrustedInboxIds([])
            GoldilocksOwnedChannels.set([])
        }

        let convo = makeConversation(id: "stranger-group", creatorInboxId: trustedInbox)
        #expect(convo.isStaleGoldilocksChannel)
    }

    @Test("untrusted creator → never stale (regular Convos chat)")
    func untrustedCreatorIsNeverStale() {
        GoldilocksAgentTrust.setTrustedInboxIds(["some-trusted-inbox"])
        GoldilocksOwnedChannels.set(["owned-group-3"])
        defer {
            GoldilocksAgentTrust.setTrustedInboxIds([])
            GoldilocksOwnedChannels.set([])
        }

        let convo = makeConversation(id: "regular-group", creatorInboxId: "random-friend-inbox")
        #expect(!convo.isStaleGoldilocksChannel)
    }

    @Test("owned set not yet loaded → don't filter (avoid blanking the list during launch)")
    func unloadedOwnedSetMeansNotStale() {
        let trustedInbox = "trusted-agent-inbox-3"
        GoldilocksAgentTrust.setTrustedInboxIds([trustedInbox])
        // Empty set → isLoaded == false. Even with a trusted creator we
        // shouldn't claim staleness, because /v2/me/channels hasn't
        // landed yet and we'd hide the user's real channels.
        GoldilocksOwnedChannels.set([])
        defer { GoldilocksAgentTrust.setTrustedInboxIds([]) }

        let convo = makeConversation(id: "any-group", creatorInboxId: trustedInbox)
        #expect(!convo.isStaleGoldilocksChannel)
    }
}

// MARK: - Helpers

private func makeConversation(id: String, creatorInboxId: String) -> Conversation {
    let creator = ConversationMember(
        profile: Profile(inboxId: creatorInboxId, conversationId: id, name: "Creator", avatar: nil),
        role: .admin,
        isCurrentUser: false
    )
    let me = ConversationMember(
        profile: Profile(inboxId: "current-user", conversationId: id, name: "You", avatar: nil),
        role: .member,
        isCurrentUser: true
    )
    return Conversation(
        id: id,
        clientConversationId: id,
        creator: creator,
        createdAt: Date(),
        consent: .allowed,
        kind: .group,
        name: "Test",
        description: nil,
        members: [creator, me],
        otherMember: creator,
        messages: [],
        isPinned: false,
        isUnread: false,
        isMuted: false,
        pinnedOrder: nil,
        lastMessage: nil,
        imageURL: nil,
        imageSalt: nil,
        imageNonce: nil,
        imageEncryptionKey: nil,
        conversationEmoji: nil,
        includeInfoInPublicPreview: false,
        isDraft: false,
        invite: nil,
        expiresAt: nil,
        debugInfo: .empty,
        isLocked: false,
        assistantJoinStatus: nil,
        hasHadVerifiedAssistant: false
    )
}
