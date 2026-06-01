import Foundation

struct EmptyResponse: Decodable {}

public enum ConvosAPI {
    public struct FetchJwtResponse: Codable {
        public let token: String
    }

    // MARK: - Device Update Models

    struct DeviceUpdateRequest: Codable {
        let pushToken: String
        let pushTokenType: DeviceUpdatePushTokenType
        let apnsEnv: DeviceUpdateApnsEnvironment

        enum DeviceUpdatePushTokenType: String, Codable {
            case apns
        }

        enum DeviceUpdateApnsEnvironment: String, Codable {
            case sandbox
            case production
        }

        init(pushToken: String,
             pushTokenType: DeviceUpdatePushTokenType = .apns,
             apnsEnv: DeviceUpdateApnsEnvironment) {
            self.pushToken = pushToken
            self.pushTokenType = pushTokenType
            self.apnsEnv = apnsEnv
        }
    }
    public struct DeviceUpdateResponse: Codable {
        public let id: String
        public let pushToken: String?
        public let pushTokenType: String
        public let apnsEnv: String?
        public let updatedAt: String
        public let pushFailures: Int
    }

    public struct AuthCheckResponse: Codable {
        public let success: Bool
    }

    // MARK: - v2 Device & Notification Endpoints

    public enum PushTokenType: String, Codable {
        case apns
        case fcm
    }

    // MARK: - v2/device/register
    // POST /v2/device/register
    // Purpose: Register or update device metadata (independent of push notifications)
    // Returns: 200 with empty body on success
    // Errors: 400 (invalid body), 403 (device disabled), 500 (server error)

    public struct RegisterDeviceRequest: Codable {
        public let deviceId: String
        public let pushToken: String?
        public let pushTokenType: String?
        public let apnsEnv: String?

        public init(deviceId: String, pushToken: String?, pushTokenType: String?, apnsEnv: String?) {
            self.deviceId = deviceId
            self.pushToken = pushToken
            self.pushTokenType = pushTokenType
            self.apnsEnv = apnsEnv
        }
    }

    // MARK: - v2/notifications/subscribe
    // POST /v2/notifications/subscribe
    // Returns: 200 with empty body on success
    // Errors: 400 (invalid body), 404 (device not found), 403 (device disabled), 500 (server error)

    public struct HmacKey: Codable {
        public let thirtyDayPeriodsSinceEpoch: Int
        public let key: String // hex string

        public init(thirtyDayPeriodsSinceEpoch: Int, key: String) {
            self.thirtyDayPeriodsSinceEpoch = thirtyDayPeriodsSinceEpoch
            self.key = key
        }
    }

    public struct TopicSubscription: Codable {
        public let topic: String
        public let hmacKeys: [HmacKey]

        public init(topic: String, hmacKeys: [HmacKey]) {
            self.topic = topic
            self.hmacKeys = hmacKeys
        }
    }

    public struct SubscribeRequest: Codable {
        public let deviceId: String
        public let clientId: String
        public let topics: [TopicSubscription]

        public init(deviceId: String, clientId: String, topics: [TopicSubscription]) {
            self.deviceId = deviceId
            self.clientId = clientId
            self.topics = topics
        }
    }

    // MARK: - v2/notifications/unsubscribe
    // POST /v2/notifications/unsubscribe
    // Returns: 200 with empty body on success
    // Errors: 400 (invalid body), 404 (client not found), 500 (server error)

    public struct UnsubscribeRequest: Codable {
        public let clientId: String
        public let topics: [String]

        public init(clientId: String, topics: [String]) {
            self.clientId = clientId
            self.topics = topics
        }
    }

    // MARK: - v2/notifications/unregister
    // DELETE /v2/notifications/unregister/:clientId
    // clientId is a URL parameter, not in body
    // Returns: 200 with empty body on success
    // Errors: 400 (invalid params), 404 (client not found), 500 (server error)

    // MARK: - v2/agents/join
    // POST /v2/agents/join

    public struct AgentJoinRequest: Codable {
        public let slug: String
        public let instructions: String

        public init(slug: String, instructions: String) {
            self.slug = slug
            self.instructions = instructions
        }
    }

    public struct AgentJoinResponse: Codable {
        public let success: Bool
        public let joined: Bool

        public init(success: Bool, joined: Bool) {
            self.success = success
            self.joined = joined
        }
    }

    // MARK: - v2/invite-codes/redeem
    // POST /v2/invite-codes/redeem

    public struct RedeemCodeRequest: Codable {
        public let code: String

        public init(code: String) {
            self.code = code
        }
    }

    public struct InviteCodeStatusResponse: Codable, Sendable {
        public let success: Bool
        public let data: InviteCodeStatus

        public init(success: Bool, data: InviteCodeStatus) {
            self.success = success
            self.data = data
        }
    }

    public struct InviteCodeStatus: Codable, Sendable {
        public let code: String
        public let name: String?
        public let maxRedemptions: Int
        public let redemptionCount: Int
        public let remainingRedemptions: Int

        public init(code: String, name: String?, maxRedemptions: Int, redemptionCount: Int, remainingRedemptions: Int) {
            self.code = code
            self.name = name
            self.maxRedemptions = maxRedemptions
            self.redemptionCount = redemptionCount
            self.remainingRedemptions = remainingRedemptions
        }
    }

    public struct RedeemInviteCodeResponse: Codable, Sendable {
        public let success: Bool
        public let data: RedeemInviteCodeData

        public init(success: Bool, data: RedeemInviteCodeData) {
            self.success = success
            self.data = data
        }
    }

    public struct RedeemInviteCodeData: Codable, Sendable {
        public let inviteCode: InviteCodeStatus

        public init(inviteCode: InviteCodeStatus) {
            self.inviteCode = inviteCode
        }
    }

    // MARK: - Goldilocks identity registration (SIWE)

    public struct GoldilocksChallengeRequest: Codable {
        public let inboxId: String
        public let ethAddress: String
    }

    public struct GoldilocksChallengeResponse: Codable {
        public let siweMessage: String
        public let nonce: String
        public let expiresAt: String
    }

    public struct GoldilocksMeRequest: Codable {
        public let inboxId: String
        public let siweMessage: String
        public let signature: String
        /// iOS sets this to `true` on builds whose role is `.admin`,
        /// so the backend can promote the inbox to admin in the same
        /// transaction as the client row creation. That ordering makes
        /// `admin_changed` arrive at the agent before
        /// `client_registered`, which means reports-agent never creates
        /// a Reports group for an admin in the first place. Backend
        /// ignores this flag in production (gate via env var).
        public let claimAdminRole: Bool

        public init(inboxId: String, siweMessage: String, signature: String, claimAdminRole: Bool) {
            self.inboxId = inboxId
            self.siweMessage = siweMessage
            self.signature = signature
            self.claimAdminRole = claimAdminRole
        }
    }

    public struct GoldilocksMeResponse: Codable, Sendable {
        public let clientNumber: Int64
        public let isAdmin: Bool
        public let inboxId: String
        /// Admin-controlled Emerald membership flag for this client.
        /// Default false so older backend responses (pre-migration 015)
        /// still decode cleanly. Emerald clients get the Emerald tier
        /// regardless of seats / coverage, and the Membership screen
        /// hides the "Add coverage" purchase flow + enables Invoices.
        public let emeraldMembershipEnabled: Bool

        public init(
            clientNumber: Int64,
            isAdmin: Bool,
            inboxId: String,
            emeraldMembershipEnabled: Bool = false
        ) {
            self.clientNumber = clientNumber
            self.isAdmin = isAdmin
            self.inboxId = inboxId
            self.emeraldMembershipEnabled = emeraldMembershipEnabled
        }

        private enum CodingKeys: String, CodingKey {
            case clientNumber, isAdmin, inboxId, emeraldMembershipEnabled
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.clientNumber = try container.decode(Int64.self, forKey: .clientNumber)
            self.isAdmin = try container.decode(Bool.self, forKey: .isAdmin)
            self.inboxId = try container.decode(String.self, forKey: .inboxId)
            // Tolerate older backends that don't yet return this field.
            self.emeraldMembershipEnabled = try container.decodeIfPresent(Bool.self, forKey: .emeraldMembershipEnabled) ?? false
        }
    }

    public struct GoldilocksAdminInbox: Codable, Sendable {
        public let inboxId: String
        public let name: String?
    }

    public struct GoldilocksAdminsResponse: Codable, Sendable {
        public let inboxes: [GoldilocksAdminInbox]
    }

    // MARK: - Goldilocks server agents

    public struct GoldilocksAgent: Codable, Sendable {
        public let kind: String       // "admins" | "reports"
        public let inboxId: String
    }

    public struct GoldilocksAgentsResponse: Codable, Sendable {
        public let agents: [GoldilocksAgent]
        /// xmtpGroupId of the cross-admin "Admins" coordination group, or
        /// nil if the admins-agent hasn't created it yet (no admins
        /// promoted). Admin iOS clients merge this into
        /// `GoldilocksOwnedChannels` so the group passes the staleness
        /// filter on the conversations list.
        public let adminsGroupId: String?
        /// xmtpGroupId of the cross-admin "Alerts" feed where client
        /// reports get cross-posted. Same membership shape as Admins.
        /// Null until the admins-agent creates it (after the first
        /// admin is promoted).
        public let alertsGroupId: String?
    }

    // MARK: - Goldilocks channel lifecycle

    public struct GoldilocksChannelResponse: Codable, Sendable {
        public let role: String
        public let xmtpGroupId: String
        public let status: String
    }

    public struct GoldilocksChannel: Codable, Sendable {
        public let role: String
        public let xmtpGroupId: String?
        public let status: String                 // "active" | "exploded"
        public let createdAt: String
        public let explodedAt: String?
        public let recreatedAt: String?
    }

    public struct GoldilocksChannelsListResponse: Codable, Sendable {
        public let clientNumber: Int64
        public let channels: [GoldilocksChannel]
        /// The roles every client should eventually have ("advisory",
        /// "reports"). The agents provision channels asynchronously, so
        /// `channels` can be a partial set right after registration —
        /// this is the full target the client waits for. Optional so an
        /// older backend that omits it still decodes.
        public let expectedRoles: [String]?

        public init(
            clientNumber: Int64,
            channels: [GoldilocksChannel],
            expectedRoles: [String]? = nil
        ) {
            self.clientNumber = clientNumber
            self.channels = channels
            self.expectedRoles = expectedRoles
        }
    }

    /// One row in the admin's view of all clients' channels. Admins use
    /// `clientNumber` as the human-readable identifier ("Advisory #55").
    public struct GoldilocksAdminChannel: Codable, Sendable {
        public let clientNumber: Int64
        public let clientInboxId: String
        public let role: String
        public let xmtpGroupId: String?
        public let status: String
        public let createdAt: String
        public let explodedAt: String?
        public let recreatedAt: String?
        /// The client's current monthly spend in cents — drives the
        /// Bronze/Silver/Gold membership tier shown in the admin view.
        public let monthlyRateCents: Int
        /// Whether the client currently has active prepaid coverage. A
        /// client only reaches Silver or Gold while this is true.
        public let coverageActive: Bool
        /// Admin-controlled Emerald override. When true, the tier is
        /// Emerald regardless of `monthlyRateCents` / `coverageActive`.
        public let emeraldMembershipEnabled: Bool
    }

    /// Body for `POST /v2/admin/clients/:inboxId/emerald` — admins
    /// toggle a client's Emerald membership status.
    public struct GoldilocksEmeraldToggleRequest: Codable, Sendable {
        public let enabled: Bool
        public init(enabled: Bool) { self.enabled = enabled }
    }

    /// Response for the Emerald toggle endpoint. `changed` is false
    /// when the requested state matched what was already stored.
    public struct GoldilocksEmeraldToggleResponse: Codable, Sendable {
        public let clientNumber: Int64
        public let emeraldMembershipEnabled: Bool
        public let changed: Bool
    }

    public struct GoldilocksAdminChannelsResponse: Codable, Sendable {
        public let channels: [GoldilocksAdminChannel]
    }

    // MARK: - Goldilocks billing (Stripe prepaid balance)

    /// Body for `POST /v2/billing/checkout` — buy a block of coverage.
    /// The seat count is sent rather than an amount so the backend prices
    /// the top-up server-side.
    public struct GoldilocksCheckoutRequest: Codable, Sendable {
        public let paymentMethod: String   // "apple" | "card" | "crypto"
        public let durationMonths: Int     // 1, 3 or 6
        public let seats: Int

        public init(paymentMethod: String, durationMonths: Int, seats: Int) {
            self.paymentMethod = paymentMethod
            self.durationMonths = durationMonths
            self.seats = seats
        }
    }

    public struct GoldilocksCheckoutResponse: Codable, Sendable {
        /// Hosted Stripe Checkout URL the app opens in the browser.
        public let checkoutUrl: String
        /// Stripe Checkout Session id, for status reconciliation.
        public let sessionId: String

        public init(checkoutUrl: String, sessionId: String) {
            self.checkoutUrl = checkoutUrl
            self.sessionId = sessionId
        }
    }

    /// Body for `POST /v2/billing/seats` — pushes the current seat count so
    /// the backend can re-settle the balance and move the coverage date.
    public struct GoldilocksSeatsRequest: Codable, Sendable {
        public let seats: Int

        public init(seats: Int) {
            self.seats = seats
        }
    }

    public struct GoldilocksBillingStatusResponse: Codable, Sendable {
        public let activeUntil: String?
        public let coverageActive: Bool
        public let coverageEnabled: Bool
        public let balanceCents: Int
        public let monthlyRateCents: Int
        public let seats: Int
        public let coveredPeople: Int
        public let reportDay: String

        public init(
            activeUntil: String?,
            coverageActive: Bool = false,
            coverageEnabled: Bool = true,
            balanceCents: Int,
            monthlyRateCents: Int,
            seats: Int,
            coveredPeople: Int = 0,
            reportDay: String = "1st"
        ) {
            self.activeUntil = activeUntil
            self.coverageActive = coverageActive
            self.coverageEnabled = coverageEnabled
            self.balanceCents = balanceCents
            self.monthlyRateCents = monthlyRateCents
            self.seats = seats
            self.coveredPeople = coveredPeople
            self.reportDay = reportDay
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            activeUntil = try container.decodeIfPresent(String.self, forKey: .activeUntil)
            coverageActive = try container.decodeIfPresent(Bool.self, forKey: .coverageActive) ?? false
            coverageEnabled = try container.decodeIfPresent(Bool.self, forKey: .coverageEnabled) ?? true
            balanceCents = try container.decode(Int.self, forKey: .balanceCents)
            monthlyRateCents = try container.decode(Int.self, forKey: .monthlyRateCents)
            seats = try container.decode(Int.self, forKey: .seats)
            coveredPeople = try container.decodeIfPresent(Int.self, forKey: .coveredPeople) ?? 0
            reportDay = try container.decodeIfPresent(String.self, forKey: .reportDay) ?? "1st"
        }
    }

    public struct GoldilocksReportDayRequest: Codable, Sendable {
        public let reportDay: String

        public init(reportDay: String) {
            self.reportDay = reportDay
        }
    }

    public struct GoldilocksCoverageToggleRequest: Codable, Sendable {
        public let enabled: Bool

        public init(enabled: Bool) {
            self.enabled = enabled
        }
    }

    public struct GoldilocksPersonToggleRequest: Codable, Sendable {
        public let personId: String
        public let displayName: String
        public let enabled: Bool

        public init(personId: String, displayName: String, enabled: Bool) {
            self.personId = personId
            self.displayName = displayName
            self.enabled = enabled
        }
    }

    public struct GoldilocksPersonToggleResponse: Codable, Sendable {
        public let activeUntil: String?
        public let coverageActive: Bool
        public let coverageEnabled: Bool
        public let balanceCents: Int
        public let monthlyRateCents: Int
        public let seats: Int
        public let coveredPeople: Int
        public let reportDay: String
        public let activated: Bool
        public let deductedCents: Int

        public init(
            activeUntil: String? = nil,
            coverageActive: Bool = false,
            coverageEnabled: Bool = true,
            balanceCents: Int = 0,
            monthlyRateCents: Int = 0,
            seats: Int = 0,
            coveredPeople: Int = 0,
            reportDay: String = "1st",
            activated: Bool = false,
            deductedCents: Int = 0
        ) {
            self.activeUntil = activeUntil
            self.coverageActive = coverageActive
            self.coverageEnabled = coverageEnabled
            self.balanceCents = balanceCents
            self.monthlyRateCents = monthlyRateCents
            self.seats = seats
            self.coveredPeople = coveredPeople
            self.reportDay = reportDay
            self.activated = activated
            self.deductedCents = deductedCents
        }
    }

    /// Body for `POST /v2/billing/apple-purchase` — sends the StoreKit2
    /// transaction to the backend for App Store Server API verification
    /// and balance crediting.
    public struct GoldilocksApplePurchaseRequest: Codable, Sendable {
        public let transactionId: String
        public let productId: String
        public let durationMonths: Int
        public let seats: Int

        public init(transactionId: String, productId: String, durationMonths: Int, seats: Int) {
            self.transactionId = transactionId
            self.productId = productId
            self.durationMonths = durationMonths
            self.seats = seats
        }
    }

    /// Result of `POST /v2/billing/cancel`.
    public struct GoldilocksCancelResponse: Codable, Sendable {
        /// How much was refunded to the card, in cents.
        public let refundedCents: Int
        /// How much was retained (current month, non-refundable), in cents.
        public let retainedCents: Int

        public init(refundedCents: Int, retainedCents: Int = 0) {
            self.refundedCents = refundedCents
            self.retainedCents = retainedCents
        }
    }

    /// The encrypted people-list blob, from `GET /v2/me/people-list`. The
    /// blob fields are AES-256-GCM ciphertext (base64); they are nil when
    /// the client has no list yet (version 0).
    public struct GoldilocksPeopleListResponse: Codable, Sendable {
        public let version: Int
        public let ciphertext: String?
        public let salt: String?
        public let nonce: String?

        public init(version: Int, ciphertext: String?, salt: String?, nonce: String?) {
            self.version = version
            self.ciphertext = ciphertext
            self.salt = salt
            self.nonce = nonce
        }
    }

    /// Body for `PUT /v2/me/people-list` — the re-encrypted blob plus the
    /// version it was edited from (optimistic concurrency). `auditHint`
    /// is only honoured by the admin variant of the endpoint; it tags
    /// the write so the backend can post a narrative line ("Admin #N
    /// enabled/disabled someone on Client #M") to the audit log
    /// without ever seeing the plaintext list.
    public struct GoldilocksPeopleListSaveRequest: Codable, Sendable {
        public let ciphertext: String
        public let salt: String
        public let nonce: String
        public let baseVersion: Int
        public let auditHint: AuditHint?

        public struct AuditHint: Codable, Sendable, Equatable {
            public let action: String
            public init(action: String) { self.action = action }
            public static let enablePerson: AuditHint = AuditHint(action: "enable_person")
            public static let disablePerson: AuditHint = AuditHint(action: "disable_person")
        }

        public init(
            ciphertext: String,
            salt: String,
            nonce: String,
            baseVersion: Int,
            auditHint: AuditHint? = nil
        ) {
            self.ciphertext = ciphertext
            self.salt = salt
            self.nonce = nonce
            self.baseVersion = baseVersion
            self.auditHint = auditHint
        }
    }

    /// Result of `PUT /v2/me/people-list` — the new stored version.
    public struct GoldilocksPeopleListSaveResponse: Codable, Sendable {
        public let version: Int

        public init(version: Int) {
            self.version = version
        }
    }

    // MARK: - Common Error Response

    public struct ErrorResponse: Codable {
        public let error: String
        public let details: [ValidationError]?
        public let hint: String?
    }

    public struct ValidationError: Codable {
        public let code: String
        public let expected: String?
        public let received: String?
        public let path: [String]
        public let message: String
    }

    // MARK: - v2/assets/renew-batch
    // POST /v2/assets/renew-batch
    // Purpose: Renew (copy-to-self) multiple S3 assets to reset their lifecycle expiration
    // Returns: 200 with BatchRenewResponse body
    // Errors: 400 (invalid body), 401 (unauthorized), 500 (server error)

    struct BatchRenewRequest: Codable {
        let assetKeys: [String]
    }

    struct BatchRenewResponse: Codable {
        let renewed: Int
        let failed: Int
        let results: [AssetResult]

        struct AssetResult: Codable {
            let key: String
            let success: Bool
            let error: String?
        }
    }
}

// MARK: - Asset Renewal Result

public struct AssetRenewalResult: Sendable {
    public let renewed: Int
    public let failed: Int
    public let expiredKeys: [String]

    public init(renewed: Int, failed: Int, expiredKeys: [String]) {
        self.renewed = renewed
        self.failed = failed
        self.expiredKeys = expiredKeys
    }
}
