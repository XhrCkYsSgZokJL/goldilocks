import Foundation

class MockAPIClientFactory: ConvosAPIClientFactoryType {
    static func client(environment: AppEnvironment, overrideJWTToken: String? = nil) -> any ConvosAPIClientProtocol {
        MockAPIClient(overrideJWTToken: overrideJWTToken)
    }
}

enum MockAPIError: Error {
    case invalidURL
}

final class MockAPIClient: ConvosAPIClientProtocol, Sendable {
    let overrideJWTToken: String?

    init(overrideJWTToken: String? = nil) {
        self.overrideJWTToken = overrideJWTToken
    }

    func request(for path: String, method: String, queryParameters: [String: String]?) throws -> URLRequest {
        guard let url = URL(string: "http://example.com") else {
            throw MockAPIError.invalidURL
        }
        return URLRequest(url: url)
    }

    func registerDevice(deviceId: String, pushToken: String?) async throws {
        // Mock implementation - no-op
    }

    func authenticate(retryCount: Int = 0) async throws -> String {
        return "mock-jwt-token"
    }

    func authenticateWithSIWE(
        appCheckToken: String,
        signing: BackendAuthSigningContext
    ) async throws -> String {
        "mock-siwe-jwt-token"
    }

    func updateSIWESigningContext(_ context: BackendAuthSigningContext?) {
        // no-op
    }

    func accountAuthCheck(jwt: String?) async throws -> ConvosAPI.AuthCheckResponse {
        .init(success: jwt != nil)
    }

    func logout() async {
        // Mock implementation — no-op
    }

    func uploadAttachment(
        data: Data,
        filename: String,
        contentType: String,
        acl: String
    ) async throws -> String {
        "https://mock-api.example.com/uploads/\(filename)"
    }

    func uploadAttachmentAndExecute(
        data: Data,
        filename: String,
        afterUpload: @escaping (String) async throws -> Void
    ) async throws -> String {
        let url = "https://mock-api.example.com/uploads/\(filename)"
        try await afterUpload(url)
        return url
    }

    func getPresignedUploadURL(
        filename: String,
        contentType: String
    ) async throws -> (uploadURL: String, assetURL: String) {
        let uploadURL = "https://mock-s3.example.com/upload/\(filename)?presigned=true"
        let assetURL = "https://mock-cdn.example.com/assets/\(filename)"
        return (uploadURL: uploadURL, assetURL: assetURL)
    }

    // MARK: - Notifications mocks

    func subscribeToTopics(deviceId: String, clientId: String, topics: [String]) async throws {
        // no-op in mock
    }

    func unsubscribeFromTopics(clientId: String, topics: [String]) async throws {
        // no-op in mock
    }

    func unregisterInstallation(clientId: String) async throws {
        // no-op in mock
    }

    // MARK: - Asset Renewal

    func renewAssetsBatch(assetKeys: [String]) async throws -> AssetRenewalResult {
        AssetRenewalResult(renewed: assetKeys.count, failed: 0, expiredKeys: [])
    }

    func requestAgentJoin(
        slug: String,
        templateId: String? = nil,
        options: ConvosAPI.AgentJoinOptions? = nil,
        forceErrorCode: Int? = nil
    ) async throws -> ConvosAPI.AgentJoinResponse {
        .init(success: true, joined: true)
    }

    func getAgentTemplate(idOrUrlSlug: String) async throws -> ConvosAPI.AgentTemplate {
        .init(
            id: UUID().uuidString,
            status: "published",
            publishedUrl: "https://agents.example.com/a/\(idOrUrlSlug)",
            slug: idOrUrlSlug,
            agentName: "Mock Agent",
            description: "A mock agent template for previews and tests.",
            emoji: "🤖",
            avatarUrl: nil
        )
    }

    func getFeaturedAgentTemplates(limit: Int, cursor: String?) async throws -> ConvosAPI.AgentTemplatesPage {
        let templates: [ConvosAPI.AgentTemplate] = [
            .init(id: "tmpl-trip", status: "published", publishedUrl: nil, slug: "trip", agentName: "Trip", description: "Travel agent", emoji: "🧳", avatarUrl: nil),
            .init(id: "tmpl-champ", status: "published", publishedUrl: nil, slug: "champ", agentName: "Champ", description: "Team manager", emoji: "🏆", avatarUrl: nil),
            .init(id: "tmpl-chef", status: "published", publishedUrl: nil, slug: "chef", agentName: "Chef", description: "Meal and nutrition partner", emoji: "🍽️", avatarUrl: nil),
        ]
        return .init(data: templates, hasMore: false, nextCursor: nil)
    }

    // MARK: - Connections

    func initiateCloudConnection(serviceId: String, redirectUri: String) async throws -> CloudConnectionsAPI.InitiateResponse {
        .init(connectionRequestId: "mock-request-\(UUID().uuidString)", redirectUrl: "https://accounts.google.com/o/oauth2/auth?mock=true")
    }

    func completeCloudConnection(connectionRequestId: String) async throws -> CloudConnectionsAPI.CompleteResponse {
        .init(
            connectionId: "mock-conn-\(UUID().uuidString)",
            serviceId: "googlecalendar",
            serviceName: "Google Calendar",
            composioEntityId: "convos_mock_entity",
            composioConnectionId: "mock_composio_conn",
            status: "active"
        )
    }

    func listCloudConnections() async throws -> [CloudConnectionsAPI.ConnectionResponse] {
        []
    }

    func revokeCloudConnection(connectionId: String) async throws {}

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
        throw MockAPIError.invalidURL
    }
    func revokeConnection(connectionId: String) async throws {}

    // MARK: - Goldilocks identity registration (mock)

    func fetchGoldilocksChallenge(inboxId: String, ethAddress: String) async throws -> ConvosAPI.GoldilocksChallengeResponse {
        let nowIso = ISO8601DateFormatter().string(from: Date())
        let expiresIso = ISO8601DateFormatter().string(from: Date().addingTimeInterval(300))
        let siweMessage = """
        mock.local wants you to sign in with your Ethereum account:
        \(ethAddress)

        I am the owner of XMTP inbox \(inboxId).

        URI: http://mock
        Version: 1
        Chain ID: 1
        Nonce: mocknonce
        Issued At: \(nowIso)
        """
        return .init(
            siweMessage: siweMessage,
            nonce: "mocknonce",
            expiresAt: expiresIso
        )
    }

    func registerWithGoldilocks(inboxId: String, siweMessage: String, signature: String, claimAdminRole: Bool) async throws -> ConvosAPI.GoldilocksMeResponse {
        .init(clientNumber: 42, isAdmin: false, inboxId: inboxId)
    }

    func fetchGoldilocksMe() async throws -> ConvosAPI.GoldilocksMeResponse {
        .init(clientNumber: 42, isAdmin: false, inboxId: "mock-inbox")
    }

    func promoteSelfToAdminDev() async throws {}

    func upgradeGoldilocksAdmin(code: String) async throws {}

    func downgradeGoldilocksAdmin() async throws {}

    func fetchGoldilocksAdmins() async throws -> ConvosAPI.GoldilocksAdminsResponse {
        .init(inboxes: [])
    }

    func fetchGoldilocksAgents() async throws -> ConvosAPI.GoldilocksAgentsResponse {
        .init(agents: [], adminsGroupId: nil, alertsGroupId: nil)
    }

    func fetchGoldilocksAdminChannels() async throws -> ConvosAPI.GoldilocksAdminChannelsResponse {
        .init(channels: [])
    }

    func fetchGoldilocksAdminStats() async throws -> ConvosAPI.GoldilocksAdminStatsResponse {
        .init(
            totalClients: 128,
            newClientsThisMonth: 14,
            clientsWithActiveCoverage: 73,
            totalCoveredPeople: 191,
            membershipsTotal: 214,
            mrrCents: 1_910_000,
            totalBalanceCents: 4_820_000,
            clientsByTier: .init(bronze: 41, silver: 52, gold: 21, emerald: 14),
            mrrByTierCents: .init(bronze: 0, silver: 720_000, gold: 1_010_000, emerald: 180_000),
            lifetimeRevenueCents: 9_640_000,
            refundedCents: 120_000,
            seatDistribution: [
                .init(seats: 0, clients: 41),
                .init(seats: 1, clients: 33),
                .init(seats: 2, clients: 19),
                .init(seats: 3, clients: 14),
                .init(seats: 4, clients: 21),
            ],
            coverage: .init(active: 73, paused: 22, none: 33),
            referrals: .init(total: 38, paying: 21, creditIssuedCents: 210_000),
            screeningTrend: [],
            asOf: "2026-06-03T12:00:00.000Z"
        )
    }

    func setGoldilocksEmeraldMembership(
        clientInboxId: String,
        enabled: Bool
    ) async throws -> ConvosAPI.GoldilocksEmeraldToggleResponse {
        .init(clientNumber: 0, emeraldMembershipEnabled: enabled, changed: true)
    }

    func registerGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse {
        .init(role: role, xmtpGroupId: xmtpGroupId, status: "active")
    }

    func markGoldilocksChannelExploded(role: String) async throws {}

    func recreateGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse {
        .init(role: role, xmtpGroupId: xmtpGroupId, status: "active")
    }

    func listGoldilocksChannels() async throws -> ConvosAPI.GoldilocksChannelsListResponse {
        .init(clientNumber: 42, channels: [])
    }

    func recoverGoldilocksChannels() async throws {}
}
