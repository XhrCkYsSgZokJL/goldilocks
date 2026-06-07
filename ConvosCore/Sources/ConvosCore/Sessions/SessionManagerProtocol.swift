import Combine
import Foundation

/// Progress events for inbox deletion
public enum InboxDeletionProgress: Sendable, Equatable {
    case clearingDeviceRegistration
    case stoppingServices(completed: Int, total: Int)
    case deletingFromDatabase
    case completed
}

public protocol SessionManagerProtocol: AnyObject, Sendable {
    // MARK: Inbox Management

    /// Returns the shared messaging service and an optional conversation id
    /// for a hidden draft group prepared by `UnusedConversationCache`. The
    /// draft is *peeked*, not claimed, so reopening an untouched "new channel"
    /// reuses the same group rather than minting another; it stays hidden
    /// until `markNewConversationUsed` graduates it. `conversationId` is nil
    /// if no prepared group was available and the caller should create one
    /// on demand.
    func prepareNewConversation() async -> (service: AnyMessagingService, conversationId: String?)

    /// Graduates a reused draft to a real conversation once the user commits
    /// to it (sends the first message), so it leaves the hidden-draft state
    /// and appears in the conversation list. No-op for conformers that don't
    /// use the unused-conversation cache.
    func markNewConversationUsed(conversationId: String) async

    func deleteAllInboxes() async throws
    func deleteAllInboxesWithProgress() -> AsyncThrowingStream<InboxDeletionProgress, Error>

    // MARK: Messaging Services

    func messagingService() -> AnyMessagingService
    func messagingServiceSync() -> AnyMessagingService

    // MARK: Factory methods for repositories

    func inviteRepository(for conversationId: String) -> any InviteRepositoryProtocol
    func requestAgentJoin(slug: String, instructions: String, forceErrorCode: Int?) async throws -> ConvosAPI.AgentJoinResponse
    func redeemInviteCode(_ code: String) async throws -> ConvosAPI.InviteCodeStatus
    func fetchInviteCodeStatus(_ code: String) async throws -> ConvosAPI.InviteCodeStatus

    func conversationRepository(for conversationId: String) -> any ConversationRepositoryProtocol

    func messagesRepository(for conversationId: String) -> any MessagesRepositoryProtocol

    func photoPreferencesRepository(for conversationId: String) -> any PhotoPreferencesRepositoryProtocol
    func photoPreferencesWriter() -> any PhotoPreferencesWriterProtocol
    func voiceMemoTranscriptRepository() -> any VoiceMemoTranscriptRepositoryProtocol
    func voiceMemoTranscriptWriter() -> any VoiceMemoTranscriptWriterProtocol
    func voiceMemoTranscriptionService() -> any VoiceMemoTranscriptionServicing

    func attachmentLocalStateWriter() -> any AttachmentLocalStateWriterProtocol
    func assistantFilesLinksRepository(for conversationId: String) -> AssistantFilesLinksRepository

    func conversationsRepository(for consent: [Consent]) -> any ConversationsRepositoryProtocol
    func conversationsCountRepo(
        for consent: [Consent],
        kinds: [ConversationKind]
    ) -> any ConversationsCountRepositoryProtocol
    func pinnedConversationsCountRepo() -> any PinnedConversationsCountRepositoryProtocol

    // MARK: Notifications

    func notifyChangesInDatabase()
    func shouldDisplayNotification(for conversationId: String) async -> Bool

    /// Tells the session manager whether the conversations list is currently
    /// on-screen. Used to suppress in-app notification banners — the list
    /// already surfaces the new-message indicator, so a banner would be
    /// redundant.
    func setIsOnConversationsList(_ isOn: Bool)

    /// Ensures the messaging service is ready before processing a notification
    /// for the given conversation. Safe to call from the NSE.
    func wakeInboxForNotification(conversationId: String)

    // MARK: Helpers

    func inboxId(for conversationId: String) async -> String?

    // MARK: Debug

    func pendingInviteDetails() throws -> [PendingInviteDetail]
    func deleteExpiredPendingInvites() async throws -> Int
    func isAccountOrphaned() throws -> Bool

    // MARK: Asset Renewal

    func makeAssetRenewalManager() async -> AssetRenewalManager

    // MARK: Connections

    func connectionManager(callbackURLScheme: String) -> any ConnectionManagerProtocol
    func connectionRepository() -> any ConnectionRepositoryProtocol

    // MARK: Goldilocks identity registration

    /// Run the SIWE handshake against the Goldilocks backend, binding the
    /// caller's deviceId to their XMTP inbox and returning the assigned
    /// `clientNumber` plus the admin flag. Idempotent.
    ///
    /// `claimAdminRole` lets the device assert "I'm an admin build" so
    /// the backend can promote the inbox in the same call as the client
    /// row creation. That ordering ensures `admin_changed` arrives at
    /// the agent before `client_registered`, and reports-agent skips
    /// creating Reports for admins entirely. Production ignores the
    /// flag (gated by `GOLDILOCKS_ALLOW_SELF_PROMOTE`).
    func registerWithGoldilocks(claimAdminRole: Bool) async throws -> GoldilocksAuth.Identity

    /// Re-fetch the caller's identity (clientNumber + isAdmin) without
    /// re-doing SIWE. Useful after admin promotion.
    func refreshGoldilocksIdentity() async throws -> GoldilocksAuth.Identity

    /// DEV-ONLY. Calls /v2/admin/promote-self to add the caller's inbox to
    /// admin_inboxes. Backend rejects unless GOLDILOCKS_ALLOW_SELF_PROMOTE=true.
    func promoteSelfToAdminDev() async throws

    /// Submit the secret upgrade code to `POST /v2/admin/upgrade`. On
    /// success the caller's inbox is added to `admin_inboxes`. Throws if
    /// the code is wrong or the endpoint is disabled.
    func upgradeGoldilocksAdmin(code: String) async throws

    /// Self-downgrade: `POST /v2/admin/downgrade` flips the caller's
    /// admin_inboxes row to disabled. The agent removes the inbox from
    /// the cross-admin groups + every Advisory on the next reconcile.
    func downgradeGoldilocksAdmin() async throws

    /// Create a Stripe Checkout Session to deposit funds into the prepaid
    /// balance. The amount is in cents, must be a multiple of $100.
    func createGoldilocksCheckout(
        paymentMethod: GoldilocksPaymentMethod,
        amountCents: Int
    ) async throws -> ConvosAPI.GoldilocksCheckoutResponse

    /// Fetch the caller's prepaid-balance state (`GET /v2/billing/status`).
    func fetchGoldilocksBillingStatus() async throws -> ConvosAPI.GoldilocksBillingStatusResponse

    /// Push the current seat count so the backend re-settles the balance
    /// and moves the coverage date (`POST /v2/billing/seats`).
    func syncGoldilocksSeats(seats: Int) async throws -> ConvosAPI.GoldilocksBillingStatusResponse

    /// Set the monthly report delivery day (`POST /v2/billing/report-day`).
    func setGoldilocksReportDay(reportDay: String) async throws -> ConvosAPI.GoldilocksBillingStatusResponse

    /// Reconcile a checkout session with Stripe and return updated billing
    /// status (`GET /v2/billing/checkout-status/:sessionId`).
    func reconcileGoldilocksCheckout(sessionId: String) async throws -> ConvosAPI.GoldilocksBillingStatusResponse

    /// Start a Stripe Checkout (setup mode) to save a card on file
    /// (`POST /v2/billing/payment-method`).
    func setupGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodSetupResponse

    /// Confirm the saved card after the setup checkout completes
    /// (`POST /v2/billing/payment-method/confirm`).
    func confirmGoldilocksPaymentMethod(sessionId: String) async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse

    /// Detach the saved card from the Stripe customer
    /// (`POST /v2/billing/payment-method/remove`).
    func removeGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse

    func claimGoldilocksReferral(code: String) async throws

    /// Enable or disable coverage (`POST /v2/billing/coverage`).
    func toggleGoldilocksCoverage(enabled: Bool) async throws -> ConvosAPI.GoldilocksBillingStatusResponse

    /// Enable or disable a specific person on the plan. Enabling deducts
    /// the initial monthly fee and queues a sample report.
    func toggleGoldilocksPersonCoverage(
        personId: String,
        displayName: String,
        enabled: Bool
    ) async throws -> ConvosAPI.GoldilocksPersonToggleResponse

    /// Stop cover and refund the unused balance (`POST /v2/billing/cancel`).
    func cancelGoldilocksBilling() async throws -> ConvosAPI.GoldilocksCancelResponse

    /// Verify an Apple IAP transaction with the backend and credit the
    /// prepaid balance. The backend uses the transaction ID to validate
    /// the receipt with Apple's App Store Server API.
    func verifyApplePurchase(
        transactionId: String,
        productId: String,
        amountCents: Int
    ) async throws

    /// Fetch the inbox IDs of all admins (Goldilocks team). Used by the
    /// client app as the recipient list when creating Advisory/Reports.
    func fetchGoldilocksAdminInboxIds() async throws -> [String]

    /// Fetch admin inbox IDs together with their display names. Used to
    /// pre-populate the contacts list so clients see advisor names immediately.
    func fetchGoldilocksAdminProfiles() async throws -> [ConvosAPI.GoldilocksAdminInbox]

    /// Fetch the inbox IDs of the long-lived server agents (admins-agent,
    /// reports-agent). The iOS layer registers these with
    /// `GoldilocksAgentTrust` so welcomes from those inboxes auto-allow
    /// past the consent gate.
    func fetchGoldilocksAgentInboxIds() async throws -> [String]

    /// Fetch the cross-admin "Admins" group's xmtpGroupId. Returns nil
    /// when the admins-agent hasn't created the group yet. Used by the
    /// admin iOS app to add the Admins group to its
    /// `GoldilocksOwnedChannels` set so it passes the staleness filter.
    func fetchGoldilocksAdminsGroupId() async throws -> String?

    /// Fetch the cross-admin "Alerts" group's xmtpGroupId. Returns nil
    /// until the admins-agent creates it (after the first admin is
    /// promoted). Like Admins, this is included in the admin's owned
    /// channels set so it passes the staleness filter.
    func fetchGoldilocksAlertsGroupId() async throws -> String?

    /// Admin-only. Fetch every client's channels with their `clientNumber`
    /// so the admin home screen can render "Advisory #55", "Reports #56" etc.
    func fetchAdminChannels() async throws -> [ConvosAPI.GoldilocksAdminChannel]

    /// Admin-only. Aggregate, point-in-time snapshot of the application —
    /// client counts, membership-tier mix, MRR, prepaid balance, revenue,
    /// coverage state, seat distribution, and referrals — powering the
    /// admin Stats dashboard.
    func fetchAdminStats() async throws -> ConvosAPI.GoldilocksAdminStatsResponse

    /// Admin-only. Flip the Emerald membership flag on a client. The
    /// backend posts an "Admin #N enabled/disabled Emerald membership
    /// for Client #M" line to the audit log when the flag actually
    /// changes.
    func setEmeraldMembership(
        clientInboxId: String,
        enabled: Bool
    ) async throws -> ConvosAPI.GoldilocksEmeraldToggleResponse

    // MARK: Goldilocks channel lifecycle

    /// Register a freshly-created XMTP group as the (role, this client)
    /// canonical channel on the Goldilocks backend. role is one of
    /// `"advisory"` or `"reports"`.
    func registerGoldilocksChannel(role: String, xmtpGroupId: String) async throws

    /// Mark a channel exploded on the backend. The row stays in the DB
    /// (so admins still see it greyed-out) but flips to `status='exploded'`.
    func markGoldilocksChannelExploded(role: String) async throws

    /// Replace the xmtp_group_id of a previously-exploded channel with a
    /// freshly-created XMTP group, flipping status back to `'active'`.
    func recreateGoldilocksChannel(role: String, xmtpGroupId: String) async throws

    /// Fetch the calling client's channel rows from the backend, plus
    /// the `expectedRoles` set. Used by the auto-recover path to compare
    /// the expected channels against what's present in local storage.
    func listGoldilocksChannels() async throws -> ConvosAPI.GoldilocksChannelsListResponse

    /// Ask the backend to fire `channels_recover` NOTIFY for this
    /// client. The agent removes + re-adds us to each Advisory/Reports
    /// group, regenerating fresh MLS welcomes that iOS picks up on
    /// the next sync.
    func recoverGoldilocksChannels() async throws

    /// Count of conversations whose creator inbox is in
    /// `GoldilocksAgentTrust`. Cheap GRDB query against DBConversation.
    func goldilocksManagedConversationCount() async throws -> Int

    /// Filter `xmtpGroupIds` to those NOT present in local GRDB. Used
    /// by the auto-recover path to ask: "of the channels the backend
    /// says I own, which ones haven't landed locally yet?" If empty,
    /// don't fire recover — count-based heuristics race with the
    /// welcome stream during launch and produce false positives.
    func missingGoldilocksConversationIds(_ xmtpGroupIds: [String]) async throws -> [String]

    /// Fetch the caller's encrypted people-list blob (`GET /v2/me/people-list`).
    func fetchGoldilocksPeopleList() async throws -> ConvosAPI.GoldilocksPeopleListResponse

    /// Replace the caller's encrypted people-list blob (`PUT /v2/me/people-list`).
    /// Returns the new stored version; throws on a version conflict.
    func saveGoldilocksPeopleList(ciphertext: String, salt: String, nonce: String, baseVersion: Int) async throws -> Int

    /// Resolve a conversation's group encryption key, creating it in the
    /// group's MLS metadata if absent. Used to encrypt the people list
    /// with the Advisory group's key.
    func groupEncryptionKey(forConversationId conversationId: String) async throws -> Data

    /// Admin: fetch a client's encrypted people-list blob by inbox id.
    func fetchAdminPeopleList(clientInboxId: String) async throws -> ConvosAPI.GoldilocksPeopleListResponse

    /// Admin: replace a client's encrypted people-list blob. Returns the
    /// new stored version; throws on a version conflict. The optional
    /// `auditHint` tags the write so the backend can record a per-person
    /// enable/disable line in the audit log.
    func saveAdminPeopleList(
        clientInboxId: String,
        ciphertext: String,
        salt: String,
        nonce: String,
        baseVersion: Int,
        auditHint: ConvosAPI.GoldilocksPeopleListSaveRequest.AuditHint?
    ) async throws -> Int
}

extension SessionManagerProtocol {
    public func requestAgentJoin(slug: String, instructions: String) async throws -> ConvosAPI.AgentJoinResponse {
        try await requestAgentJoin(slug: slug, instructions: instructions, forceErrorCode: nil)
    }

    /// Default no-op for mocks/tests so they don't need to provide an
    /// implementation. The production `SessionManager` overrides this with
    /// the real SIWE flow.
    public func registerWithGoldilocks(claimAdminRole: Bool) async throws -> GoldilocksAuth.Identity {
        throw GoldilocksAuth.AuthError.missingPrivateKey
    }

    public func refreshGoldilocksIdentity() async throws -> GoldilocksAuth.Identity {
        throw GoldilocksAuth.AuthError.missingPrivateKey
    }

    public func promoteSelfToAdminDev() async throws {
        // No-op for mocks
    }

    /// Default no-op so conformers that don't use the unused-conversation
    /// cache (mocks, test doubles) need no implementation. The production
    /// `SessionManager` overrides this to graduate the draft.
    public func markNewConversationUsed(conversationId: String) async {
        // No-op for mocks
    }

    public func upgradeGoldilocksAdmin(code: String) async throws {
        // No-op for mocks
    }

    public func downgradeGoldilocksAdmin() async throws {
        // No-op for mocks
    }

    public func createGoldilocksCheckout(
        paymentMethod: GoldilocksPaymentMethod,
        amountCents: Int
    ) async throws -> ConvosAPI.GoldilocksCheckoutResponse {
        throw GoldilocksAuth.AuthError.missingPrivateKey
    }

    public func fetchGoldilocksBillingStatus() async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    public func syncGoldilocksSeats(seats: Int) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    public func setGoldilocksReportDay(reportDay: String) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    public func reconcileGoldilocksCheckout(sessionId: String) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    public func setupGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodSetupResponse {
        ConvosAPI.GoldilocksPaymentMethodSetupResponse(checkoutUrl: "", sessionId: "")
    }

    public func confirmGoldilocksPaymentMethod(sessionId: String) async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse {
        ConvosAPI.GoldilocksPaymentMethodConfirmResponse(hasPaymentMethod: false)
    }

    public func removeGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse {
        ConvosAPI.GoldilocksPaymentMethodConfirmResponse(hasPaymentMethod: false)
    }

    public func claimGoldilocksReferral(code: String) async throws {}

    public func toggleGoldilocksCoverage(enabled: Bool) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    public func toggleGoldilocksPersonCoverage(
        personId: String,
        displayName: String,
        enabled: Bool
    ) async throws -> ConvosAPI.GoldilocksPersonToggleResponse {
        ConvosAPI.GoldilocksPersonToggleResponse()
    }

    public func cancelGoldilocksBilling() async throws -> ConvosAPI.GoldilocksCancelResponse {
        ConvosAPI.GoldilocksCancelResponse(refundedCents: 0)
    }

    public func verifyApplePurchase(
        transactionId: String,
        productId: String,
        amountCents: Int
    ) async throws {
        // No-op for mocks
    }

    public func fetchGoldilocksPeopleList() async throws -> ConvosAPI.GoldilocksPeopleListResponse {
        ConvosAPI.GoldilocksPeopleListResponse(version: 0, ciphertext: nil, salt: nil, nonce: nil)
    }

    public func saveGoldilocksPeopleList(ciphertext: String, salt: String, nonce: String, baseVersion: Int) async throws -> Int {
        baseVersion + 1
    }

    public func groupEncryptionKey(forConversationId conversationId: String) async throws -> Data {
        throw ImageEncryptionError.missingEncryptionKey
    }

    public func fetchAdminPeopleList(clientInboxId: String) async throws -> ConvosAPI.GoldilocksPeopleListResponse {
        ConvosAPI.GoldilocksPeopleListResponse(version: 0, ciphertext: nil, salt: nil, nonce: nil)
    }

    public func saveAdminPeopleList(
        clientInboxId: String,
        ciphertext: String,
        salt: String,
        nonce: String,
        baseVersion: Int,
        auditHint: ConvosAPI.GoldilocksPeopleListSaveRequest.AuditHint?
    ) async throws -> Int {
        baseVersion + 1
    }

    public func fetchGoldilocksAdminInboxIds() async throws -> [String] {
        []
    }

    public func fetchGoldilocksAdminProfiles() async throws -> [ConvosAPI.GoldilocksAdminInbox] {
        []
    }

    public func fetchGoldilocksAgentInboxIds() async throws -> [String] {
        []
    }

    public func fetchGoldilocksAdminsGroupId() async throws -> String? {
        nil
    }

    public func fetchGoldilocksAlertsGroupId() async throws -> String? {
        nil
    }

    public func fetchAdminChannels() async throws -> [ConvosAPI.GoldilocksAdminChannel] {
        []
    }

    public func fetchAdminStats() async throws -> ConvosAPI.GoldilocksAdminStatsResponse {
        ConvosAPI.GoldilocksAdminStatsResponse(
            totalClients: 0,
            newClientsThisMonth: 0,
            clientsWithActiveCoverage: 0,
            totalCoveredPeople: 0,
            membershipsTotal: 0,
            mrrCents: 0,
            totalBalanceCents: 0,
            clientsByTier: .init(bronze: 0, silver: 0, gold: 0, emerald: 0),
            mrrByTierCents: .init(bronze: 0, silver: 0, gold: 0, emerald: 0),
            lifetimeRevenueCents: 0,
            refundedCents: 0,
            seatDistribution: [],
            coverage: .init(active: 0, paused: 0, none: 0),
            referrals: .init(total: 0, paying: 0, creditIssuedCents: 0),
            screeningTrend: [],
            asOf: ""
        )
    }

    public func setEmeraldMembership(
        clientInboxId: String,
        enabled: Bool
    ) async throws -> ConvosAPI.GoldilocksEmeraldToggleResponse {
        ConvosAPI.GoldilocksEmeraldToggleResponse(
            clientNumber: 0,
            emeraldMembershipEnabled: enabled,
            changed: false
        )
    }

    // Default channel-lifecycle no-ops for mocks/tests.
    public func registerGoldilocksChannel(role: String, xmtpGroupId: String) async throws {}
    public func markGoldilocksChannelExploded(role: String) async throws {}
    public func recreateGoldilocksChannel(role: String, xmtpGroupId: String) async throws {}

    public func listGoldilocksChannels() async throws -> ConvosAPI.GoldilocksChannelsListResponse {
        ConvosAPI.GoldilocksChannelsListResponse(clientNumber: 0, channels: [])
    }
    public func recoverGoldilocksChannels() async throws {}
    public func goldilocksManagedConversationCount() async throws -> Int { 0 }
    public func missingGoldilocksConversationIds(_ xmtpGroupIds: [String]) async throws -> [String] { [] }
}
