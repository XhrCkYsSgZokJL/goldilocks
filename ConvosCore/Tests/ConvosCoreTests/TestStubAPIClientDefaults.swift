@testable import ConvosCore
import Foundation

/// Default no-op implementations of the IAP-credits methods added to
/// `ConvosAPIClientProtocol` so test fixtures that predate that protocol
/// addition (RecordingPushAPIClient, ThrowingPushAPIClient, StubAPIClient,
/// TestableMockAPIClient, ConfigurableMockAPIClient, ThrowawayPushAPIClient,
/// and the reconciliation-test variant) don't each have to re-stub them.
///
/// Lives only in the test target; the main library's `MockAPIClient` provides
/// its own implementations and is unaffected. Tests that specifically exercise
/// these methods should override them on their stub or use a dedicated fixture.
extension ConvosAPIClientProtocol {
    func getCreditBalance() async throws -> CreditBalance {
        CreditBalance(
            balance: 0,
            monthlyGrant: 0,
            monthlyGrantUsed: 0,
            nextRefreshAt: Date(),
            periodLabel: ""
        )
    }

    func getSubscription() async throws -> UserSubscription? {
        nil
    }

    func verifySubscription(jwsRepresentation: String) async throws -> UserSubscription {
        throw CancellationError()
    }

    /// Default for the post-`options:` `requestAgentJoin` signature so
    /// pre-existing test mocks (which still carry the old
    /// `slug:templateId:forceErrorCode:` shape) don't have to re-stub it
    /// every time the protocol gains a parameter. Tests that exercise
    /// `requestAgentJoin` specifically should still override this on
    /// their fixture.
    func requestAgentJoin(
        slug: String,
        templateId: String?,
        options: ConvosAPI.AgentJoinOptions?,
        forceErrorCode: Int?
    ) async throws -> ConvosAPI.AgentJoinResponse {
        ConvosAPI.AgentJoinResponse(success: true, joined: true)
    }

    /// Default for the public agent-template detail fetch used by the
    /// agent-share card/chip resolver. Tests that exercise it specifically
    /// should override on their fixture.
    func getAgentTemplate(idOrUrlSlug: String) async throws -> ConvosAPI.AgentTemplate {
        ConvosAPI.AgentTemplate(
            id: UUID().uuidString,
            status: "published",
            publishedUrl: "https://agents.example.com/a/\(idOrUrlSlug)",
            slug: idOrUrlSlug,
            agentName: "Test Agent",
            description: "A test agent template.",
            emoji: "🤖",
            avatarUrl: nil
        )
    }

    /// Default for the featured agent-templates list backing the contacts
    /// picker's suggested section. Tests that exercise it specifically should
    /// override on their fixture.
    func getFeaturedAgentTemplates(limit: Int, cursor: String?) async throws -> ConvosAPI.AgentTemplatesPage {
        ConvosAPI.AgentTemplatesPage(data: [], hasMore: false, nextCursor: nil)
    }

    // Goldilocks auth (no App Check), identity registration, admin, and
    // channel lifecycle. Response-returning defaults throw so an unexpected
    // call surfaces as a test error instead of fabricating backend state;
    // Void defaults no-op. Tests that exercise these should override them
    // on their fixture.
    func authenticate(retryCount: Int) async throws -> String { "" }
    func logout() async {}
    func fetchGoldilocksChallenge(inboxId: String, ethAddress: String) async throws -> ConvosAPI.GoldilocksChallengeResponse {
        throw CancellationError()
    }
    func registerWithGoldilocks(inboxId: String, siweMessage: String, signature: String, claimAdminRole: Bool) async throws -> ConvosAPI.GoldilocksMeResponse {
        throw CancellationError()
    }
    func fetchGoldilocksMe() async throws -> ConvosAPI.GoldilocksMeResponse {
        throw CancellationError()
    }
    func promoteSelfToAdminDev() async throws {}
    func upgradeGoldilocksAdmin(code: String) async throws {}
    func downgradeGoldilocksAdmin() async throws {}
    func fetchGoldilocksAdmins() async throws -> ConvosAPI.GoldilocksAdminsResponse {
        throw CancellationError()
    }
    func fetchGoldilocksAgents() async throws -> ConvosAPI.GoldilocksAgentsResponse {
        throw CancellationError()
    }
    func fetchGoldilocksAdminChannels() async throws -> ConvosAPI.GoldilocksAdminChannelsResponse {
        throw CancellationError()
    }
    func fetchGoldilocksAdminStats() async throws -> ConvosAPI.GoldilocksAdminStatsResponse {
        throw CancellationError()
    }
    func setGoldilocksEmeraldMembership(clientInboxId: String, enabled: Bool, seatLimit: Int?) async throws -> ConvosAPI.GoldilocksEmeraldToggleResponse {
        throw CancellationError()
    }
    func registerGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse {
        throw CancellationError()
    }
    func markGoldilocksChannelExploded(role: String) async throws {}
    func recreateGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse {
        throw CancellationError()
    }
    func listGoldilocksChannels() async throws -> ConvosAPI.GoldilocksChannelsListResponse {
        throw CancellationError()
    }
    func recoverGoldilocksChannels() async throws {}
    func setupGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodSetupResponse {
        throw CancellationError()
    }
    func confirmGoldilocksPaymentMethod(sessionId: String) async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse {
        throw CancellationError()
    }
    func removeGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse {
        throw CancellationError()
    }
    func setGoldilocksClientReview(clientInboxId: String, open: Bool) async throws -> ConvosAPI.GoldilocksReviewToggleResponse {
        throw CancellationError()
    }
}

/// Open, fully-conforming `ConvosAPIClientProtocol` base for test fixtures that
/// only care about one or two methods. Every requirement throws / returns a
/// trivial value; subclasses override just what they exercise. Spares each new
/// stub from re-declaring the whole (large) protocol surface.
class TestStubAPIClient: ConvosAPIClientProtocol, @unchecked Sendable {
    func request(for path: String, method: String, queryParameters: [String: String]?) throws -> URLRequest {
        URLRequest(url: URL(string: "https://example.com/\(path)") ?? URL(string: "https://example.com")!)
    }
    func registerDevice(deviceId: String, pushToken: String?) async throws {}
    func authenticate(retryCount: Int) async throws -> String { "" }
    func logout() async {}
    func authenticateWithSIWE(appCheckToken: String, signing: BackendAuthSigningContext) async throws -> String { "" }
    func updateSIWESigningContext(_ context: BackendAuthSigningContext?) {}
    func accountAuthCheck(jwt: String?) async throws -> ConvosAPI.AuthCheckResponse {
        throw CancellationError()
    }
    func uploadAttachment(data: Data, filename: String, contentType: String, acl: String) async throws -> String { "" }
    func uploadAttachmentAndExecute(data: Data, filename: String, afterUpload: @escaping (String) async throws -> Void) async throws -> String { "" }
    func getPresignedUploadURL(filename: String, contentType: String) async throws -> (uploadURL: String, assetURL: String) {
        ("", "")
    }
    func subscribeToTopics(deviceId: String, clientId: String, topics: [String]) async throws {}
    func unsubscribeFromTopics(clientId: String, topics: [String]) async throws {}
    func unregisterInstallation(clientId: String) async throws {}
    func renewAssetsBatch(assetKeys: [String]) async throws -> AssetRenewalResult {
        AssetRenewalResult(renewed: 0, failed: 0, expiredKeys: [])
    }
    func initiateCloudConnection(serviceId: String, redirectUri: String) async throws -> CloudConnectionsAPI.InitiateResponse {
        throw CancellationError()
    }
    func completeCloudConnection(connectionRequestId: String) async throws -> CloudConnectionsAPI.CompleteResponse {
        throw CancellationError()
    }
    func listCloudConnections() async throws -> [CloudConnectionsAPI.ConnectionResponse] { [] }
    func revokeCloudConnection(connectionId: String) async throws {}

    // Goldilocks identity registration, admin, and channel lifecycle.
    // Response-returning defaults throw so an unexpected call surfaces as a
    // test error instead of fabricating backend state; Void defaults no-op.
    // Tests that exercise these should override them on their fixture.
    func fetchGoldilocksChallenge(inboxId: String, ethAddress: String) async throws -> ConvosAPI.GoldilocksChallengeResponse {
        throw CancellationError()
    }
    func registerWithGoldilocks(inboxId: String, siweMessage: String, signature: String, claimAdminRole: Bool) async throws -> ConvosAPI.GoldilocksMeResponse {
        throw CancellationError()
    }
    func fetchGoldilocksMe() async throws -> ConvosAPI.GoldilocksMeResponse {
        throw CancellationError()
    }
    func promoteSelfToAdminDev() async throws {}
    func upgradeGoldilocksAdmin(code: String) async throws {}
    func downgradeGoldilocksAdmin() async throws {}
    func fetchGoldilocksAdmins() async throws -> ConvosAPI.GoldilocksAdminsResponse {
        throw CancellationError()
    }
    func fetchGoldilocksAgents() async throws -> ConvosAPI.GoldilocksAgentsResponse {
        throw CancellationError()
    }
    func fetchGoldilocksAdminChannels() async throws -> ConvosAPI.GoldilocksAdminChannelsResponse {
        throw CancellationError()
    }
    func fetchGoldilocksAdminStats() async throws -> ConvosAPI.GoldilocksAdminStatsResponse {
        throw CancellationError()
    }
    func setGoldilocksEmeraldMembership(clientInboxId: String, enabled: Bool, seatLimit: Int?) async throws -> ConvosAPI.GoldilocksEmeraldToggleResponse {
        throw CancellationError()
    }
    func registerGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse {
        throw CancellationError()
    }
    func markGoldilocksChannelExploded(role: String) async throws {}
    func recreateGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse {
        throw CancellationError()
    }
    func listGoldilocksChannels() async throws -> ConvosAPI.GoldilocksChannelsListResponse {
        throw CancellationError()
    }
    func recoverGoldilocksChannels() async throws {}

    /// Declared on the base (not just the protocol-extension default) so
    /// subclasses can `override` it.
    func getAgentTemplate(idOrUrlSlug: String) async throws -> ConvosAPI.AgentTemplate {
        ConvosAPI.AgentTemplate(id: UUID().uuidString, status: "published", publishedUrl: nil)
    }
}
