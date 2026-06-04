import Combine
import Foundation
import GRDB

public final class MockInboxesService: SessionManagerProtocol {
    private let mockMessagingService: MockMessagingService

    public init(mockMessagingService: MockMessagingService = MockMessagingService()) {
        self.mockMessagingService = mockMessagingService
    }

    public func fetchAdminStats() async throws -> ConvosAPI.GoldilocksAdminStatsResponse {
        ConvosAPI.GoldilocksAdminStatsResponse(
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
            screeningTrend: Self.sampleScreeningTrend(),
            asOf: "2026-06-03T12:00:00.000Z"
        )
    }

    private static func sampleScreeningTrend() -> [ConvosAPI.GoldilocksStatsTrendPoint] {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        let calendar = Calendar(identifier: .gregorian)
        let today = Date()
        var points: [ConvosAPI.GoldilocksStatsTrendPoint] = []
        var cumulative: Int = 40
        for offset in stride(from: 89, through: 0, by: -1) {
            let day = calendar.date(byAdding: .day, value: -offset, to: today) ?? today
            cumulative += Int.random(in: 0...4)
            points.append(.init(date: formatter.string(from: day), cumulative: cumulative))
        }
        return points
    }

    // MARK: - Inbox Management

    public func prepareNewConversation() async -> (service: AnyMessagingService, conversationId: String?) {
        (service: mockMessagingService, conversationId: nil)
    }

    public func deleteAllInboxes() async throws {
    }

    public func deleteAllInboxesWithProgress() -> AsyncThrowingStream<InboxDeletionProgress, any Error> {
        AsyncThrowingStream { continuation in
            Task {
                continuation.yield(.clearingDeviceRegistration)
                try? await Task.sleep(for: .milliseconds(200))
                continuation.yield(.stoppingServices(completed: 0, total: 1))
                try? await Task.sleep(for: .milliseconds(300))
                continuation.yield(.stoppingServices(completed: 1, total: 1))
                try? await Task.sleep(for: .milliseconds(200))
                continuation.yield(.deletingFromDatabase)
                try? await Task.sleep(for: .milliseconds(200))
                continuation.yield(.completed)
                continuation.finish()
            }
        }
    }

    // MARK: - Messaging Services

    public func messagingService() -> AnyMessagingService {
        mockMessagingService
    }

    public func messagingServiceSync() -> AnyMessagingService {
        mockMessagingService
    }

    // MARK: - Factory methods for repositories

    public func conversationsRepository(for consent: [Consent]) -> any ConversationsRepositoryProtocol {
        MockConversationsRepository()
    }

    public func conversationsCountRepo(for consent: [Consent], kinds: [ConversationKind]) -> any ConversationsCountRepositoryProtocol {
        MockConversationsCountRepository()
    }

    public func pinnedConversationsCountRepo() -> any PinnedConversationsCountRepositoryProtocol {
        MockPinnedConversationsCountRepository()
    }

    public func inviteRepository(for conversationId: String) -> any InviteRepositoryProtocol {
        MockInviteRepository()
    }

    public func requestAgentJoin(slug: String, instructions: String, forceErrorCode: Int? = nil) async throws -> ConvosAPI.AgentJoinResponse {
        if let forceErrorCode {
            switch forceErrorCode {
            case 502: throw APIError.agentProvisionFailed
            case 503: throw APIError.noAgentsAvailable
            case 504: throw APIError.agentPoolTimeout
            default: throw APIError.serverError("Mock forced error \(forceErrorCode)")
            }
        }
        return .init(success: true, joined: true)
    }

    public func redeemInviteCode(_ code: String) async throws -> ConvosAPI.InviteCodeStatus {
        .init(code: "MOCKCODE", name: nil, maxRedemptions: 5, redemptionCount: 0, remainingRedemptions: 5)
    }

    public func fetchInviteCodeStatus(_ code: String) async throws -> ConvosAPI.InviteCodeStatus {
        .init(code: code.uppercased(), name: nil, maxRedemptions: 5, redemptionCount: 1, remainingRedemptions: 4)
    }

    public func conversationRepository(for conversationId: String) -> any ConversationRepositoryProtocol {
        MockConversationRepository()
    }

    public func messagesRepository(for conversationId: String) -> any MessagesRepositoryProtocol {
        MockMessagesRepository(conversationId: conversationId)
    }

    public func photoPreferencesRepository(for conversationId: String) -> any PhotoPreferencesRepositoryProtocol {
        MockPhotoPreferencesRepository()
    }

    public func photoPreferencesWriter() -> any PhotoPreferencesWriterProtocol {
        MockPhotoPreferencesWriter()
    }

    public func voiceMemoTranscriptRepository() -> any VoiceMemoTranscriptRepositoryProtocol {
        MockVoiceMemoTranscriptRepository()
    }

    public func voiceMemoTranscriptWriter() -> any VoiceMemoTranscriptWriterProtocol {
        MockVoiceMemoTranscriptWriter()
    }

    public func voiceMemoTranscriptionService() -> any VoiceMemoTranscriptionServicing {
        MockVoiceMemoTranscriptionService()
    }

    public func attachmentLocalStateWriter() -> any AttachmentLocalStateWriterProtocol {
        MockAttachmentLocalStateWriter()
    }

    private static let mockDatabase: DatabaseQueue = MockDatabaseManager.shared.dbPool

    public func assistantFilesLinksRepository(for conversationId: String) -> AssistantFilesLinksRepository {
        AssistantFilesLinksRepository(dbReader: Self.mockDatabase, conversationId: conversationId)
    }

    // MARK: - Notifications

    public func notifyChangesInDatabase() {
    }

    public func shouldDisplayNotification(for conversationId: String) async -> Bool {
        true
    }

    public func setIsOnConversationsList(_ isOn: Bool) {}

    public func wakeInboxForNotification(conversationId: String) {}

    // MARK: - Helpers

    public func inboxId(for conversationId: String) async -> String? {
        "mock-inbox-id"
    }

    // MARK: - Debug

    public func pendingInviteDetails() throws -> [PendingInviteDetail] {
        []
    }

    public func deleteExpiredPendingInvites() async throws -> Int {
        0
    }

    public func isAccountOrphaned() throws -> Bool {
        false
    }

    // MARK: - Asset Renewal

    public func makeAssetRenewalManager() async -> AssetRenewalManager {
        let dbManager = MockDatabaseManager.shared
        let recoveryHandler = ExpiredAssetRecoveryHandler(databaseWriter: dbManager.dbWriter)
        return AssetRenewalManager(
            databaseWriter: dbManager.dbWriter,
            apiClient: MockAPIClient(),
            recoveryHandler: recoveryHandler
        )
    }

    // MARK: - Connections

    public func connectionManager(
        callbackURLScheme: String
    ) -> any ConnectionManagerProtocol {
        MockConnectionManager()
    }

    public func connectionRepository() -> any ConnectionRepositoryProtocol {
        MockConnectionRepository()
    }
}
