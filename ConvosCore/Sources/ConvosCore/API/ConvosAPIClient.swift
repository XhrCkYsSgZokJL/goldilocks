import ConvosAppData
import ConvosLogging
import Foundation

protocol ConvosAPIClientFactoryType {
    static func client(environment: AppEnvironment, overrideJWTToken: String?) -> any ConvosAPIClientProtocol
}

enum ConvosAPIClientFactory: ConvosAPIClientFactoryType {
    static func client(environment: AppEnvironment, overrideJWTToken: String? = nil) -> any ConvosAPIClientProtocol {
        guard !environment.isTestingEnvironment else {
            return MockAPIClient()
        }
        return ConvosAPIClient(
            environment: environment,
            overrideJWTToken: overrideJWTToken
        )
    }
}

public protocol ConvosAPIClientProtocol: AnyObject, Sendable {
    func request(for path: String,
                 method: String,
                 queryParameters: [String: String]?) throws -> URLRequest

    /// Register device (no JWT required — device-level operation).
    func registerDevice(deviceId: String, pushToken: String?) async throws

    func authenticate(retryCount: Int) async throws -> String

    /// Revoke the saved refresh-token family on the backend and drop
    /// both tokens from the local keychain. Idempotent — safe to call
    /// even if no tokens are saved. Network failure does not block
    /// local deletion; we prefer being signed-out-locally over staying
    /// signed-in because the backend wasn't reachable at the moment.
    func logout() async

    func uploadAttachment(
        data: Data,
        filename: String,
        contentType: String,
        acl: String
    ) async throws -> String
    func uploadAttachmentAndExecute(
        data: Data,
        filename: String,
        afterUpload: @escaping (String) async throws -> Void
    ) async throws -> String

    func getPresignedUploadURL(
        filename: String,
        contentType: String
    ) async throws -> (uploadURL: String, assetURL: String)

    // Push notifications
    func subscribeToTopics(deviceId: String, clientId: String, topics: [String]) async throws
    func unsubscribeFromTopics(clientId: String, topics: [String]) async throws
    func unregisterInstallation(clientId: String) async throws

    // Asset renewal
    func renewAssetsBatch(assetKeys: [String]) async throws -> AssetRenewalResult

    // Agents
    func requestAgentJoin(slug: String, instructions: String, forceErrorCode: Int?) async throws -> ConvosAPI.AgentJoinResponse

    // Invite codes
    func redeemInviteCode(_ code: String) async throws -> ConvosAPI.InviteCodeStatus
    func fetchInviteCodeStatus(_ code: String) async throws -> ConvosAPI.InviteCodeStatus

    // Connections
    func initiateConnection(serviceId: String, redirectUri: String) async throws -> ConnectionsAPI.InitiateResponse
    func completeConnection(connectionRequestId: String) async throws -> ConnectionsAPI.CompleteResponse
    func listConnections() async throws -> [ConnectionsAPI.ConnectionResponse]
    func revokeConnection(connectionId: String) async throws

    // Goldilocks SIWE-based identity registration. The backend validates
    // that the caller's eth_address is bound to the claimed inbox_id by
    // querying the XMTP node, so other clients can't impersonate this
    // inbox even if they steal the JWT.
    func fetchGoldilocksChallenge(inboxId: String, ethAddress: String) async throws -> ConvosAPI.GoldilocksChallengeResponse
    func registerWithGoldilocks(inboxId: String, siweMessage: String, signature: String, claimAdminRole: Bool) async throws -> ConvosAPI.GoldilocksMeResponse
    func fetchGoldilocksMe() async throws -> ConvosAPI.GoldilocksMeResponse
    func promoteSelfToAdminDev() async throws
    func upgradeGoldilocksAdmin(code: String) async throws
    func downgradeGoldilocksAdmin() async throws
    func fetchGoldilocksAdmins() async throws -> ConvosAPI.GoldilocksAdminsResponse
    func fetchGoldilocksAgents() async throws -> ConvosAPI.GoldilocksAgentsResponse
    func fetchGoldilocksAdminChannels() async throws -> ConvosAPI.GoldilocksAdminChannelsResponse
    func fetchGoldilocksAdminStats() async throws -> ConvosAPI.GoldilocksAdminStatsResponse
    func setGoldilocksEmeraldMembership(
        clientInboxId: String,
        enabled: Bool,
        seatLimit: Int?
    ) async throws -> ConvosAPI.GoldilocksEmeraldToggleResponse
    func setGoldilocksClientReview(
        clientInboxId: String,
        open: Bool
    ) async throws -> ConvosAPI.GoldilocksReviewToggleResponse

    // Goldilocks channel lifecycle.
    func registerGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse
    func markGoldilocksChannelExploded(role: String) async throws
    func recreateGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse
    func listGoldilocksChannels() async throws -> ConvosAPI.GoldilocksChannelsListResponse
    func recoverGoldilocksChannels() async throws

    // Goldilocks billing (Stripe prepaid balance + Apple IAP).
    func createGoldilocksCheckout(_ request: ConvosAPI.GoldilocksCheckoutRequest) async throws -> ConvosAPI.GoldilocksCheckoutResponse
    func fetchGoldilocksBillingStatus() async throws -> ConvosAPI.GoldilocksBillingStatusResponse
    func syncGoldilocksSeats(_ request: ConvosAPI.GoldilocksSeatsRequest) async throws -> ConvosAPI.GoldilocksBillingStatusResponse
    func setGoldilocksReportDay(_ request: ConvosAPI.GoldilocksReportDayRequest) async throws -> ConvosAPI.GoldilocksBillingStatusResponse
    func reconcileGoldilocksCheckout(sessionId: String) async throws -> ConvosAPI.GoldilocksBillingStatusResponse
    func setupGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodSetupResponse
    func confirmGoldilocksPaymentMethod(sessionId: String) async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse
    func removeGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse
    func claimGoldilocksReferral(code: String) async throws
    func toggleGoldilocksCoverage(_ request: ConvosAPI.GoldilocksCoverageToggleRequest) async throws -> ConvosAPI.GoldilocksBillingStatusResponse
    func toggleGoldilocksPersonCoverage(_ request: ConvosAPI.GoldilocksPersonToggleRequest) async throws -> ConvosAPI.GoldilocksPersonToggleResponse
    func cancelGoldilocksBilling() async throws -> ConvosAPI.GoldilocksCancelResponse
    func verifyApplePurchase(_ request: ConvosAPI.GoldilocksApplePurchaseRequest) async throws

    // Goldilocks people list (encrypted blob).
    func fetchGoldilocksPeopleList() async throws -> ConvosAPI.GoldilocksPeopleListResponse
    func saveGoldilocksPeopleList(_ request: ConvosAPI.GoldilocksPeopleListSaveRequest) async throws -> ConvosAPI.GoldilocksPeopleListSaveResponse
    func fetchAdminPeopleList(clientInboxId: String) async throws -> ConvosAPI.GoldilocksPeopleListResponse
    func saveAdminPeopleList(clientInboxId: String, _ request: ConvosAPI.GoldilocksPeopleListSaveRequest) async throws -> ConvosAPI.GoldilocksPeopleListSaveResponse
}

extension ConvosAPIClientProtocol {
    func requestAgentJoin(slug: String, instructions: String) async throws -> ConvosAPI.AgentJoinResponse {
        try await requestAgentJoin(slug: slug, instructions: instructions, forceErrorCode: nil)
    }

    /// Default billing stubs so mock/stub conformers compile without their
    /// own implementations. The real `ConvosAPIClient` overrides them.
    func createGoldilocksCheckout(_ request: ConvosAPI.GoldilocksCheckoutRequest) async throws -> ConvosAPI.GoldilocksCheckoutResponse {
        throw APIError.notImplementedInGoldilocks
    }

    func fetchGoldilocksBillingStatus() async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    func syncGoldilocksSeats(_ request: ConvosAPI.GoldilocksSeatsRequest) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    func setGoldilocksReportDay(_ request: ConvosAPI.GoldilocksReportDayRequest) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    func reconcileGoldilocksCheckout(sessionId: String) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    func setupGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodSetupResponse {
        throw APIError.notImplementedInGoldilocks
    }

    func confirmGoldilocksPaymentMethod(sessionId: String) async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse {
        ConvosAPI.GoldilocksPaymentMethodConfirmResponse(hasPaymentMethod: false)
    }

    func removeGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse {
        ConvosAPI.GoldilocksPaymentMethodConfirmResponse(hasPaymentMethod: false)
    }

    func claimGoldilocksReferral(code: String) async throws {}

    func toggleGoldilocksCoverage(_ request: ConvosAPI.GoldilocksCoverageToggleRequest) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        ConvosAPI.GoldilocksBillingStatusResponse(activeUntil: nil, balanceCents: 0, monthlyRateCents: 0, seats: 0)
    }

    func toggleGoldilocksPersonCoverage(_ request: ConvosAPI.GoldilocksPersonToggleRequest) async throws -> ConvosAPI.GoldilocksPersonToggleResponse {
        ConvosAPI.GoldilocksPersonToggleResponse()
    }

    func cancelGoldilocksBilling() async throws -> ConvosAPI.GoldilocksCancelResponse {
        ConvosAPI.GoldilocksCancelResponse(refundedCents: 0)
    }

    func verifyApplePurchase(_ request: ConvosAPI.GoldilocksApplePurchaseRequest) async throws {
        // No-op for mocks
    }

    func fetchGoldilocksPeopleList() async throws -> ConvosAPI.GoldilocksPeopleListResponse {
        ConvosAPI.GoldilocksPeopleListResponse(version: 0, ciphertext: nil, salt: nil, nonce: nil)
    }

    func saveGoldilocksPeopleList(_ request: ConvosAPI.GoldilocksPeopleListSaveRequest) async throws -> ConvosAPI.GoldilocksPeopleListSaveResponse {
        ConvosAPI.GoldilocksPeopleListSaveResponse(version: request.baseVersion + 1)
    }

    func fetchAdminPeopleList(clientInboxId: String) async throws -> ConvosAPI.GoldilocksPeopleListResponse {
        ConvosAPI.GoldilocksPeopleListResponse(version: 0, ciphertext: nil, salt: nil, nonce: nil)
    }

    func saveAdminPeopleList(clientInboxId: String, _ request: ConvosAPI.GoldilocksPeopleListSaveRequest) async throws -> ConvosAPI.GoldilocksPeopleListSaveResponse {
        ConvosAPI.GoldilocksPeopleListSaveResponse(version: request.baseVersion + 1)
    }
}

/// HTTP client for Convos backend API
///
/// ConvosAPIClient provides both authenticated and unauthenticated access to the Convos backend, handling:
/// - JWT authentication with automatic token refresh
/// - Device registration
/// - Attachment uploads via S3 presigned URLs
/// - Push notification topic subscriptions
/// - Device and installation management
/// - Exponential backoff retry logic
///
/// The client automatically re-authenticates on 401 responses up to a maximum
/// retry count and stores JWT tokens in keychain for persistence.
/// Single-flight gate for token refresh. Concurrent 401 responses all
/// await the same in-flight refresh task, so the backend never sees
/// double-spend of a refresh token (which would otherwise trigger
/// family revocation under our RFC 6819 §5.2.2.3 theft-detection rule).
private actor TokenRefresher {
    private var inflight: Task<String, Error>?

    func refresh(_ work: @Sendable @escaping () async throws -> String) async throws -> String {
        if let existing = inflight {
            return try await existing.value
        }
        let task = Task { try await work() }
        inflight = task
        defer { inflight = nil }
        return try await task.value
    }
}

final class ConvosAPIClient: ConvosAPIClientProtocol, Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let environment: AppEnvironment
    private let keychainService: any KeychainServiceProtocol = KeychainService()
    private let overrideJWTToken: String?  // Immutable JWT override from APNS payload
    private let maxRetryCount: Int = 3
    private let tokenRefresher: TokenRefresher = .init()

    fileprivate init(environment: AppEnvironment, overrideJWTToken: String? = nil) {
        guard let apiBaseURL = URL(string: environment.apiBaseURL) else {
            fatalError("Failed constructing API base URL")
        }
        self.baseURL = apiBaseURL
        // Certificate pinning, when configured. `GoldilocksPinning` returns
        // nil while no SPKI hashes are filled in; the client falls back to
        // the OS-default URLSession in that case. First production release
        // ships in `.shadow` mode (mismatches log to Sentry but don't
        // break connections); flip to `.enforce` after a clean cycle.
        if let pinner = GoldilocksPinning.defaultPinner(mode: .shadow) {
            self.session = URLSession(
                configuration: .default,
                delegate: pinner,
                delegateQueue: nil,
            )
        } else {
            self.session = URLSession(configuration: .default)
        }
        self.environment = environment
        self.overrideJWTToken = overrideJWTToken
    }

    // MARK: - Base Request Building

    func request(for path: String,
                 method: String = "GET",
                 queryParameters: [String: String]? = nil) throws -> URLRequest {
        var urlComponents = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if let queryParameters = queryParameters {
            urlComponents?.queryItems = queryParameters.map { URLQueryItem(name: $0.key, value: $0.value) }
        }

        guard let url = urlComponents?.url else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        return request
    }

    /// Register device. Device-level operation, not inbox-specific. No JWT
    /// or App Check — abuse on this endpoint is bounded by the backend's
    /// per-route rate limit.
    func registerDevice(deviceId: String, pushToken: String?) async throws {
        let url = baseURL.appendingPathComponent("v2/device/register")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // Determine APNS environment and token type
        let apnsEnv: String?
        let pushTokenType: String?
        if let token = pushToken, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            apnsEnv = environment.apnsEnvironment == .sandbox ? "sandbox" : "production"
            pushTokenType = "apns"
        } else {
            apnsEnv = nil
            pushTokenType = nil
        }

        let body = ConvosAPI.RegisterDeviceRequest(
            deviceId: deviceId,
            pushToken: pushToken,
            pushTokenType: pushTokenType,
            apnsEnv: apnsEnv
        )
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let errorMessage = String(data: data, encoding: .utf8) ?? "Unknown error"
            Log.error("Device registration failed with status \(httpResponse.statusCode): \(errorMessage)")
            throw APIError.serverError(errorMessage)
        }

        Log.info("Device registered successfully (token: \(pushToken != nil ? "present" : "nil"))")
    }

    // MARK: - Private Helpers

    private func reAuthenticate() async throws -> String {
        return try await authenticate(retryCount: 0)
    }

    func logout() async {
        let deviceId = DeviceInfo.deviceIdentifier
        let savedRefresh = try? keychainService.retrieveString(
            account: KeychainAccount.refreshToken(deviceId: deviceId)
        )

        if let savedRefresh, !savedRefresh.isEmpty {
            // Best-effort: tell the backend to revoke the family. We
            // ignore the response — local deletion happens regardless,
            // because the user has decided to sign out and a network
            // error shouldn't strand them in a half-state.
            do {
                let url = baseURL.appendingPathComponent("v2/auth/logout")
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                struct LogoutBody: Encodable { let refreshToken: String }
                request.httpBody = try JSONEncoder().encode(LogoutBody(refreshToken: savedRefresh))
                _ = try await session.data(for: request)
            } catch {
                Log.warning("Logout call failed (\(error.localizedDescription)); clearing local tokens anyway")
            }
        }

        try? keychainService.delete(account: KeychainAccount.jwt(deviceId: deviceId))
        try? keychainService.delete(account: KeychainAccount.refreshToken(deviceId: deviceId))
        SecurityLog.event(.authLogout, deviceId: deviceId)
    }

    private func isJWTValid(_ token: String) -> Bool {
        // JWT format: header.payload.signature
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return false }

        let payload = String(parts[1])
        guard let payloadData = try? payload.base64URLDecoded(),
              let json = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
              let exp = json["exp"] as? TimeInterval else {
            return false
        }
        // Valid if expiration is more than 60 seconds from now
        return Date(timeIntervalSince1970: exp) > Date().addingTimeInterval(60)
    }

    // MARK: - Authentication

    /// Authenticates with the backend to obtain a JWT token.
    /// - Parameter retryCount: Number of retry attempts (for rate limiting).
    /// - Returns: JWT token string.
    func authenticate(retryCount: Int = 0) async throws -> String {
        let deviceId = DeviceInfo.deviceIdentifier

        // Check for existing valid JWT token first
        if let existingToken = try? keychainService.retrieveString(
            account: KeychainAccount.jwt(deviceId: deviceId)
        ), !existingToken.isEmpty,
           isJWTValid(existingToken) {
            Log.info("Using existing JWT token from keychain")
            return existingToken
        }

        // Token missing or expired - fetch new one
        let url = baseURL.appendingPathComponent("v2/auth/token")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        struct AuthRequest: Encodable {
            let deviceId: String
        }

        let requestBody = AuthRequest(deviceId: deviceId)
        request.httpBody = try JSONEncoder().encode(requestBody)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.authenticationFailed
        }

        // Handle bad request
        if httpResponse.statusCode == 400 {
            throw APIError.badRequest(parseErrorMessage(from: data))
        }

        // Handle auth rate limiting
        if httpResponse.statusCode == 429 {
            guard retryCount < maxRetryCount else {
                throw APIError.rateLimitExceeded
            }
            // Use exponential backoff for rate limit retries
            let delay = TimeInterval.calculateExponentialBackoff(for: retryCount)
            Log.info("Auth rate limited - retrying in \(delay)s (attempt \(retryCount + 1) of \(maxRetryCount))")

            // Sleep and then retry
            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            return try await authenticate(retryCount: retryCount + 1)
        }

        guard httpResponse.statusCode == 200 else {
            let errorMessage = parseErrorMessage(from: data)
            Log.error("Authentication failed with status \(httpResponse.statusCode): \(errorMessage ?? "unknown error")")
            throw APIError.authenticationFailed
        }

        let authResponse = try JSONDecoder().decode(AuthTokensResponse.self, from: data)
        try saveAuthTokens(authResponse, deviceId: deviceId)
        Log.info("Successfully authenticated and stored JWT + refresh tokens")
        return authResponse.token
    }

    // MARK: - Refresh Tokens
    //
    // Implementation lives in the `ConvosAPIClient` extension below to
    // keep the class body under SwiftLint's `type_body_length` ceiling.

    // MARK: - Private Helpers

    private func authenticatedRequest(
        for path: String,
        method: String = "GET",
        queryParameters: [String: String]? = nil
    ) throws -> URLRequest {
        var request = try request(for: path, method: method, queryParameters: queryParameters)

        let deviceId = DeviceInfo.deviceIdentifier

        // Prioritize override JWT token (from notification payload) over keychain JWT
        if let overrideJWT = overrideJWTToken {
            Log.debug("Using override JWT token from notification payload")
            request.setValue(overrideJWT, forHTTPHeaderField: "X-Convos-AuthToken")
        } else {
            // No override JWT - try keychain
            do {
                if let keychainJWT = try keychainService.retrieveString(
                    account: KeychainAccount.jwt(deviceId: deviceId)
                ) {
                    Log.debug("Using JWT token from keychain")
                    request.setValue(keychainJWT, forHTTPHeaderField: "X-Convos-AuthToken")
                } else {
                    Log.debug("No JWT token found - request will trigger re-authentication")
                }
            } catch {
                Log.warning("Failed to retrieve JWT from keychain: \(error.localizedDescription)")
                // In main app context, continue without JWT - will trigger re-authentication
            }
        }

        return request
    }

    private func performRequest<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, httpResponse) = try await performAuthenticatedRequest(request)

        Log.info("\(request.url?.path(percentEncoded: false) ?? "nil") received response: \(data.prettyPrintedJSONString ?? "nil data")")

        switch httpResponse.statusCode {
        case 200...203, 206...299:
            if T.self == EmptyResponse.self,
               let emptyResponse = EmptyResponse() as? T {
                return emptyResponse
            } else {
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                return try decoder.decode(T.self, from: data)
            }
        case 204, 205, 304:
            if T.self == EmptyResponse.self,
               let emptyResponse = EmptyResponse() as? T {
                return emptyResponse
            } else if let emptyDict = [:] as? T {
                return emptyDict
            } else if let emptyArray = [] as? T {
                return emptyArray
            } else {
                throw APIError.noContent
            }
        case 400:
            throw APIError.badRequest(parseErrorMessage(from: data))
        case 403:
            throw APIError.forbidden
        case 404:
            throw APIError.notFound
        default:
            throw APIError.serverError(parseErrorMessage(from: data))
        }
    }

    private func performAuthenticatedRequest(
        _ request: URLRequest,
        retryCount: Int = 0
    ) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        guard httpResponse.statusCode == 401 else {
            return (data, httpResponse)
        }

        guard overrideJWTToken == nil else {
            Log.error("Authentication failed in JWT override mode - cannot re-authenticate")
            throw APIError.notAuthenticated
        }

        guard retryCount < maxRetryCount else {
            Log.error("Max retry count (\(maxRetryCount)) exceeded for request")
            throw APIError.notAuthenticated
        }

        Log.info("Attempting token refresh (attempt \(retryCount + 1) of \(maxRetryCount))")
        let freshJWT = try await tokenRefresher.refresh { [self] in
            // Prefer rotating the saved refresh token. Fall back to a
            // full re-authentication (fresh family) only when the
            // refresh token is missing, expired, or rejected.
            do {
                return try await refreshAccessToken()
            } catch {
                Log.info("Refresh-token rotation failed (\(error)); falling back to full re-auth")
                return try await reAuthenticate()
            }
        }
        guard !freshJWT.isEmpty else {
            throw APIError.notAuthenticated
        }

        var newRequest = request
        newRequest.setValue(freshJWT, forHTTPHeaderField: "X-Convos-AuthToken")
        return try await performAuthenticatedRequest(newRequest, retryCount: retryCount + 1)
    }

    func uploadAttachment(
        data: Data,
        filename: String,
        contentType: String = "image/jpeg",
        acl: String = "public-read"
    ) async throws -> String {
        Log.info("Starting attachment upload process for file: \(filename)")
        Log.info("File data size: \(data.count) bytes")

        // Get presigned URL from Convos API
        let presignedRequest = try authenticatedRequest(
            for: "v2/attachments/presigned",
            method: "GET",
            queryParameters: ["contentType": contentType, "filename": filename]
        )

        struct PresignedResponse: Codable {
            let objectKey: String
            let uploadUrl: String    // Upload pre-signed URL
            let assetUrl: String     // Final asset URL
            // Note: legacy `url` field is ignored; decoder will drop unknown keys.
        }

        let presignedResponse: PresignedResponse = try await performRequest(presignedRequest)
        Log.info("Received presigned response for objectKey: \(presignedResponse.objectKey)")

        // Upload to S3 using presigned URL
        guard let s3URL = URL(string: presignedResponse.uploadUrl) else {
            Log.error("Invalid presigned URL received")
            throw APIError.invalidURL
        }

        var s3Request = URLRequest(url: s3URL)
        s3Request.httpMethod = "PUT"
        s3Request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        s3Request.httpBody = data

        Log.info("Uploading \(data.count) bytes to S3")

        let (s3Data, s3Response) = try await URLSession.shared.data(for: s3Request)

        guard let s3HttpResponse = s3Response as? HTTPURLResponse else {
            Log.error("Invalid S3 response type")
            throw APIError.invalidResponse
        }

        Log.info("S3 upload response status: \(s3HttpResponse.statusCode)")

        guard s3HttpResponse.statusCode == 200 else {
            Log.error("S3 upload failed with status: \(s3HttpResponse.statusCode)")
            Log.error("S3 error response: \(String(data: s3Data, encoding: .utf8) ?? "nil")")
            throw APIError.serverError(nil)
        }

        // Require full asset URL. Do not fallback to bare keys.
        guard let assetUrl = URL(string: presignedResponse.assetUrl) else {
            Log.error("Invalid assetUrl in presigned response; refusing to return non-URL")
            throw APIError.invalidResponse
        }

        let assetPath = assetUrl.absoluteString
        Log.info("Successfully uploaded to S3, assetUrl: \(assetPath)")
        return assetPath
    }

    func uploadAttachmentAndExecute(
        data: Data,
        filename: String,
        afterUpload: @escaping (String) async throws -> Void
    ) async throws -> String {
        Log.info("Starting chained upload and execute process for file: \(filename)")

        // Upload the attachment and get the URL
        let uploadedURL = try await uploadAttachment(
            data: data,
            filename: filename,
            contentType: "image/jpeg",
            acl: "public-read"
        )
        Log.info("Upload completed successfully, URL: \(uploadedURL)")

        // Execute the provided closure with the URL
        Log.info("Executing post-upload action with URL: \(uploadedURL)")
        try await afterUpload(uploadedURL)
        Log.info("Post-upload action completed successfully")

        return uploadedURL
    }

    func getPresignedUploadURL(
        filename: String,
        contentType: String
    ) async throws -> (uploadURL: String, assetURL: String) {
        Log.info("Getting presigned URL for file: \(filename)")

        let presignedRequest = try authenticatedRequest(
            for: "v2/attachments/presigned",
            method: "GET",
            queryParameters: ["contentType": contentType, "filename": filename]
        )

        struct PresignedResponse: Codable {
            let objectKey: String
            let uploadUrl: String
            let assetUrl: String
        }

        let response: PresignedResponse = try await performRequest(presignedRequest)
        Log.info("Received presigned URL for objectKey: \(response.objectKey)")

        return (uploadURL: response.uploadUrl, assetURL: response.assetUrl)
    }

    // MARK: - Push Notification Management (JWT-authenticated, inbox-level)

    func subscribeToTopics(deviceId: String, clientId: String, topics: [String]) async throws {
        var request = try authenticatedRequest(for: "v2/notifications/subscribe", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let topicSubscriptions: [ConvosAPI.TopicSubscription] = topics.map { topic in
            ConvosAPI.TopicSubscription(topic: topic, hmacKeys: [])
        }

        let body = ConvosAPI.SubscribeRequest(
            deviceId: deviceId,
            clientId: clientId,
            topics: topicSubscriptions
        )
        request.httpBody = try JSONEncoder().encode(body)

        let _: EmptyResponse = try await performRequest(request)
    }

    func unsubscribeFromTopics(clientId: String, topics: [String]) async throws {
        var request = try authenticatedRequest(for: "v2/notifications/unsubscribe", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ConvosAPI.UnsubscribeRequest(clientId: clientId, topics: topics)
        request.httpBody = try JSONEncoder().encode(body)

        let _: EmptyResponse = try await performRequest(request)
    }

    func unregisterInstallation(clientId: String) async throws {
        let path = "v2/notifications/unregister/\(clientId)"
        let request = try authenticatedRequest(for: path, method: "DELETE")
        let _: EmptyResponse = try await performRequest(request)
    }

    // MARK: - Asset Renewal

    func renewAssetsBatch(assetKeys: [String]) async throws -> AssetRenewalResult {
        var request = try authenticatedRequest(for: "v2/assets/renew-batch", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ConvosAPI.BatchRenewRequest(assetKeys: assetKeys)
        request.httpBody = try JSONEncoder().encode(body)

        let response: ConvosAPI.BatchRenewResponse = try await performRequest(request)

        let expiredKeys = response.results
            .filter { !$0.success && $0.error == "not_found" }
            .map { $0.key }

        return AssetRenewalResult(
            renewed: response.renewed,
            failed: response.failed,
            expiredKeys: expiredKeys
        )
    }

    // MARK: - Agents

    func requestAgentJoin(slug: String, instructions: String, forceErrorCode: Int? = nil) async throws -> ConvosAPI.AgentJoinResponse {
        var request = try authenticatedRequest(for: "v2/agents/join", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Backend pool timeout is 30s; give 5s buffer so backend returns a proper 504 before iOS times out
        request.timeoutInterval = 35

        if let forceErrorCode {
            request.setValue("\(forceErrorCode)", forHTTPHeaderField: "X-Force-Error")
        }

        request.httpBody = try JSONEncoder().encode(
            ConvosAPI.AgentJoinRequest(
                slug: slug,
                instructions: instructions
            )
        )

        let (data, httpResponse) = try await performAuthenticatedRequest(request)

        switch httpResponse.statusCode {
        case 200...299:
            let decoder = JSONDecoder()
            return try decoder.decode(ConvosAPI.AgentJoinResponse.self, from: data)
        case 502:
            throw APIError.agentProvisionFailed
        case 503:
            throw APIError.noAgentsAvailable
        case 504:
            throw APIError.agentPoolTimeout
        case 400:
            throw APIError.badRequest(parseErrorMessage(from: data))
        case 403:
            throw APIError.forbidden
        case 404:
            throw APIError.notFound
        default:
            throw APIError.serverError(parseErrorMessage(from: data))
        }
    }

    // MARK: - Invite Codes
    //
    // disabled-for-goldilocks: the original implementation called the Convos
    // backend at /v2/invite-codes/{redeem,status}. Goldilocks Digital does not
    // gate access behind invite codes, so these methods now return a synthetic
    // "always-valid" status. To restore: revert this file via git, and bring
    // back the corresponding backend endpoints.

    func redeemInviteCode(_ code: String) async throws -> ConvosAPI.InviteCodeStatus {
        let normalised = code.uppercased().trimmingCharacters(in: .whitespacesAndNewlines)
        return ConvosAPI.InviteCodeStatus(
            code: normalised,
            name: nil,
            maxRedemptions: .max,
            redemptionCount: 0,
            remainingRedemptions: .max
        )
    }

    func fetchInviteCodeStatus(_ code: String) async throws -> ConvosAPI.InviteCodeStatus {
        let normalised = code.uppercased().trimmingCharacters(in: .whitespacesAndNewlines)
        return ConvosAPI.InviteCodeStatus(
            code: normalised,
            name: nil,
            maxRedemptions: .max,
            redemptionCount: 0,
            remainingRedemptions: .max
        )
    }

    // MARK: - Connections
    //
    // disabled-for-goldilocks: the original implementation talked to a Composio-
    // backed service for SaaS integrations (connect Slack/GitHub/etc). Goldilocks
    // is a security product and doesn't ship third-party app integrations, so we
    // stub these to no-ops. The cloud-connections UI is also gated by
    // FeatureFlags.isCloudConnectionsEnabled which defaults to false.
    // To restore: revert this method block and re-implement the corresponding
    // backend endpoints under /api/v2/connections/*.

    func initiateConnection(serviceId: String, redirectUri: String) async throws -> ConnectionsAPI.InitiateResponse {
        throw APIError.notImplementedInGoldilocks
    }

    func completeConnection(connectionRequestId: String) async throws -> ConnectionsAPI.CompleteResponse {
        throw APIError.notImplementedInGoldilocks
    }

    func listConnections() async throws -> [ConnectionsAPI.ConnectionResponse] {
        return []
    }

    func revokeConnection(connectionId: String) async throws {
        // no-op
    }

    // MARK: - Goldilocks identity registration

    func fetchGoldilocksChallenge(inboxId: String, ethAddress: String) async throws -> ConvosAPI.GoldilocksChallengeResponse {
        var request = try authenticatedRequest(for: "v2/auth/challenge", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ConvosAPI.GoldilocksChallengeRequest(inboxId: inboxId, ethAddress: ethAddress)
        request.httpBody = try JSONEncoder().encode(body)

        return try await performRequest(request)
    }

    func registerWithGoldilocks(inboxId: String, siweMessage: String, signature: String, claimAdminRole: Bool) async throws -> ConvosAPI.GoldilocksMeResponse {
        var request = try authenticatedRequest(for: "v2/me", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ConvosAPI.GoldilocksMeRequest(
            inboxId: inboxId,
            siweMessage: siweMessage,
            signature: signature,
            claimAdminRole: claimAdminRole
        )
        request.httpBody = try JSONEncoder().encode(body)

        return try await performRequest(request)
    }

    func fetchGoldilocksMe() async throws -> ConvosAPI.GoldilocksMeResponse {
        let request = try authenticatedRequest(for: "v2/me", method: "GET")
        return try await performRequest(request)
    }

    func promoteSelfToAdminDev() async throws {
        var request = try authenticatedRequest(for: "v2/admin/promote-self", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([String: String]())
        let _: EmptyResponse = try await performRequest(request)
    }

    func upgradeGoldilocksAdmin(code: String) async throws {
        var request = try authenticatedRequest(for: "v2/admin/upgrade", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["code": code])
        // Throws on non-2xx — a wrong code returns 403 and surfaces as
        // an error the caller turns into "upgrade failed".
        let _: EmptyResponse = try await performRequest(request)
    }

    func downgradeGoldilocksAdmin() async throws {
        var request = try authenticatedRequest(for: "v2/admin/downgrade", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([String: String]())
        let _: EmptyResponse = try await performRequest(request)
    }

    func fetchGoldilocksAdmins() async throws -> ConvosAPI.GoldilocksAdminsResponse {
        let request = try authenticatedRequest(for: "v2/admins", method: "GET")
        return try await performRequest(request)
    }

    func fetchGoldilocksAgents() async throws -> ConvosAPI.GoldilocksAgentsResponse {
        let request = try authenticatedRequest(for: "v2/agents", method: "GET")
        return try await performRequest(request)
    }

    func fetchGoldilocksAdminChannels() async throws -> ConvosAPI.GoldilocksAdminChannelsResponse {
        let request = try authenticatedRequest(for: "v2/admin/channels", method: "GET")
        return try await performRequest(request)
    }

    func fetchGoldilocksAdminStats() async throws -> ConvosAPI.GoldilocksAdminStatsResponse {
        let request = try authenticatedRequest(for: "v2/admin/stats", method: "GET")
        return try await performRequest(request)
    }

    /// Toggle a client's admin-controlled Emerald membership flag.
    /// Admin-only; the backend posts an "Admin #N enabled/disabled
    /// Emerald membership for Client #M" line to the audit log on
    /// any state change.
    func setGoldilocksEmeraldMembership(
        clientInboxId: String,
        enabled: Bool,
        seatLimit: Int?
    ) async throws -> ConvosAPI.GoldilocksEmeraldToggleResponse {
        var request = try authenticatedRequest(
            for: "v2/admin/clients/\(clientInboxId)/emerald",
            method: "POST"
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            ConvosAPI.GoldilocksEmeraldToggleRequest(enabled: enabled, seatLimit: seatLimit)
        )
        return try await performRequest(request)
    }

    /// Open or close a client review. Admin-only; the backend posts an
    /// "Admin #N requested / closed Client #M review." audit line on any
    /// state change.
    func setGoldilocksClientReview(
        clientInboxId: String,
        open: Bool
    ) async throws -> ConvosAPI.GoldilocksReviewToggleResponse {
        var request = try authenticatedRequest(
            for: "v2/admin/clients/\(clientInboxId)/review",
            method: "POST"
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            ConvosAPI.GoldilocksReviewToggleRequest(open: open)
        )
        return try await performRequest(request)
    }

    // MARK: - Goldilocks channel lifecycle

    func registerGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse {
        var request = try authenticatedRequest(for: "v2/me/channels", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        struct Body: Codable { let role: String; let xmtpGroupId: String }
        request.httpBody = try JSONEncoder().encode(Body(role: role, xmtpGroupId: xmtpGroupId))

        return try await performRequest(request)
    }

    func markGoldilocksChannelExploded(role: String) async throws {
        var request = try authenticatedRequest(for: "v2/me/channels/\(role)", method: "PATCH")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([String: String]())
        let _: EmptyResponse = try await performRequest(request)
    }

    func recreateGoldilocksChannel(role: String, xmtpGroupId: String) async throws -> ConvosAPI.GoldilocksChannelResponse {
        var request = try authenticatedRequest(for: "v2/me/channels/\(role)/recreate", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        struct Body: Codable { let xmtpGroupId: String }
        request.httpBody = try JSONEncoder().encode(Body(xmtpGroupId: xmtpGroupId))

        return try await performRequest(request)
    }

    func listGoldilocksChannels() async throws -> ConvosAPI.GoldilocksChannelsListResponse {
        let request = try authenticatedRequest(for: "v2/me/channels", method: "GET")
        return try await performRequest(request)
    }

    /// Ask the backend to fire `channels_recover` NOTIFY for this client.
    /// The agent removes + re-adds us to each Advisory/Reports group,
    /// generating fresh MLS welcomes that iOS picks up on next sync.
    /// Used when local conversation count is below the active channel
    /// count reported by `/v2/me/channels` — typically after a dropped
    /// initial welcome or an installation rotation.
    func recoverGoldilocksChannels() async throws {
        var request = try authenticatedRequest(for: "v2/me/channels/recover", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([String: String]())
        let _: EmptyResponse = try await performRequest(request)
    }

    // MARK: - Goldilocks billing

    func createGoldilocksCheckout(_ checkout: ConvosAPI.GoldilocksCheckoutRequest) async throws -> ConvosAPI.GoldilocksCheckoutResponse {
        var request = try authenticatedRequest(for: "v2/billing/checkout", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(checkout)
        return try await performRequest(request)
    }

    func fetchGoldilocksBillingStatus() async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        let request = try authenticatedRequest(for: "v2/billing/status", method: "GET")
        return try await performRequest(request)
    }

    func syncGoldilocksSeats(_ seats: ConvosAPI.GoldilocksSeatsRequest) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        var request = try authenticatedRequest(for: "v2/billing/seats", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(seats)
        return try await performRequest(request)
    }

    func setGoldilocksReportDay(_ reportDay: ConvosAPI.GoldilocksReportDayRequest) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        var request = try authenticatedRequest(for: "v2/billing/report-day", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(reportDay)
        return try await performRequest(request)
    }

    func reconcileGoldilocksCheckout(sessionId: String) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        let request = try authenticatedRequest(for: "v2/billing/checkout-status/\(sessionId)", method: "GET")
        return try await performRequest(request)
    }

    func setupGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodSetupResponse {
        var request = try authenticatedRequest(for: "v2/billing/payment-method", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([String: String]())
        return try await performRequest(request)
    }

    func confirmGoldilocksPaymentMethod(sessionId: String) async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse {
        struct Body: Encodable { let sessionId: String }
        var request = try authenticatedRequest(for: "v2/billing/payment-method/confirm", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(sessionId: sessionId))
        return try await performRequest(request)
    }

    func removeGoldilocksPaymentMethod() async throws -> ConvosAPI.GoldilocksPaymentMethodConfirmResponse {
        var request = try authenticatedRequest(for: "v2/billing/payment-method/remove", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([String: String]())
        return try await performRequest(request)
    }

    func claimGoldilocksReferral(code: String) async throws {
        struct Body: Encodable { let referralCode: String }
        var request = try authenticatedRequest(for: "v2/me/referral", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(referralCode: code))
        let _: EmptyResponse = try await performRequest(request)
    }

    func toggleGoldilocksCoverage(_ toggle: ConvosAPI.GoldilocksCoverageToggleRequest) async throws -> ConvosAPI.GoldilocksBillingStatusResponse {
        var request = try authenticatedRequest(for: "v2/billing/coverage", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(toggle)
        return try await performRequest(request)
    }

    func toggleGoldilocksPersonCoverage(_ toggle: ConvosAPI.GoldilocksPersonToggleRequest) async throws -> ConvosAPI.GoldilocksPersonToggleResponse {
        var request = try authenticatedRequest(for: "v2/billing/person-toggle", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(toggle)
        return try await performRequest(request)
    }

    func cancelGoldilocksBilling() async throws -> ConvosAPI.GoldilocksCancelResponse {
        var request = try authenticatedRequest(for: "v2/billing/cancel", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([String: String]())
        return try await performRequest(request)
    }

    func verifyApplePurchase(_ purchase: ConvosAPI.GoldilocksApplePurchaseRequest) async throws {
        var request = try authenticatedRequest(for: "v2/billing/apple-purchase", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(purchase)
        let _: EmptyResponse = try await performRequest(request)
    }

    // MARK: - Goldilocks people list

    func fetchGoldilocksPeopleList() async throws -> ConvosAPI.GoldilocksPeopleListResponse {
        let request = try authenticatedRequest(for: "v2/me/people-list", method: "GET")
        return try await performRequest(request)
    }

    func saveGoldilocksPeopleList(_ blob: ConvosAPI.GoldilocksPeopleListSaveRequest) async throws -> ConvosAPI.GoldilocksPeopleListSaveResponse {
        var request = try authenticatedRequest(for: "v2/me/people-list", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(blob)
        return try await performRequest(request)
    }

    func fetchAdminPeopleList(clientInboxId: String) async throws -> ConvosAPI.GoldilocksPeopleListResponse {
        let request = try authenticatedRequest(for: "v2/admin/clients/\(clientInboxId)/people-list", method: "GET")
        return try await performRequest(request)
    }

    func saveAdminPeopleList(clientInboxId: String, _ blob: ConvosAPI.GoldilocksPeopleListSaveRequest) async throws -> ConvosAPI.GoldilocksPeopleListSaveResponse {
        var request = try authenticatedRequest(for: "v2/admin/clients/\(clientInboxId)/people-list", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(blob)
        return try await performRequest(request)
    }

    // MARK: - Helper Methods

    private func parseErrorMessage(from data: Data) -> String? {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let message = json["message"] as? String {
                return message
            }
            if let error = json["error"] as? String {
                return error
            }
        }
        return String(data: data, encoding: .utf8)
    }
}

// MARK: - Refresh Tokens (extension)
//
// Pulled out of the main `ConvosAPIClient` body so the class stays under
// SwiftLint's `type_body_length` ceiling. Same-file `private` access
// means everything here still sees the class's private state.

private extension ConvosAPIClient {
    struct AuthTokensResponse: Codable {
        let token: String
        let refreshToken: String?
        let refreshExpiresAt: String?
    }

    func saveAuthTokens(_ response: AuthTokensResponse, deviceId: String) throws {
        try keychainService.saveString(
            response.token,
            account: KeychainAccount.jwt(deviceId: deviceId)
        )
        if let refresh = response.refreshToken, !refresh.isEmpty {
            try keychainService.saveString(
                refresh,
                account: KeychainAccount.refreshToken(deviceId: deviceId)
            )
        }
    }

    /// Exchange the saved refresh token for a fresh access + refresh pair.
    /// Throws `APIError.notAuthenticated` if there is no saved refresh
    /// token, or if the backend rejects it (expired, invalid, or family
    /// revoked due to replay). Callers should fall back to a full
    /// `authenticate()` on failure.
    func refreshAccessToken() async throws -> String {
        let deviceId = DeviceInfo.deviceIdentifier
        guard let savedRefresh = try? keychainService.retrieveString(
            account: KeychainAccount.refreshToken(deviceId: deviceId)
        ), !savedRefresh.isEmpty else {
            throw APIError.notAuthenticated
        }

        let url = baseURL.appendingPathComponent("v2/auth/refresh")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        struct RefreshBody: Encodable { let refreshToken: String }
        request.httpBody = try JSONEncoder().encode(RefreshBody(refreshToken: savedRefresh))

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard httpResponse.statusCode == 200 else {
            // 401 from /v2/auth/refresh means the token is invalid,
            // expired, or its family was revoked. Drop the saved refresh
            // so we don't retry with a known-bad value. If the status
            // indicates the backend explicitly revoked the family due to
            // reuse, that's a critical security signal.
            try? keychainService.delete(account: KeychainAccount.refreshToken(deviceId: deviceId))
            let bodyText: String = String(data: data, encoding: .utf8) ?? ""
            let isFamilyRevoked: Bool = bodyText.contains("refresh_token_reused")
            SecurityLog.event(
                isFamilyRevoked ? .authRefreshFamilyRevoked : .authRefreshRotationFailed,
                severity: isFamilyRevoked ? .critical : .warn,
                deviceId: deviceId,
                context: ["status": String(httpResponse.statusCode)],
            )
            throw APIError.notAuthenticated
        }
        let parsed: AuthTokensResponse = try JSONDecoder().decode(AuthTokensResponse.self, from: data)
        try saveAuthTokens(parsed, deviceId: deviceId)
        SecurityLog.event(.authTokenRefreshed, deviceId: deviceId)
        return parsed.token
    }
}

// MARK: - Error Handling

public enum APIError: Error {
    case invalidURL
    case authenticationFailed
    case notAuthenticated
    case badRequest(String?)
    case forbidden
    case notFound
    case noContent
    case invalidResponse
    case invalidRequest
    case serverError(String?)
    case rateLimitExceeded
    case noAgentsAvailable
    case agentPoolTimeout
    case agentProvisionFailed
    case inviteCodeNotFound
    case inviteCodeInvalidFormat
    case inviteCodeFullyRedeemed
    case notImplementedInGoldilocks
}

extension APIError: DisplayError {
    public var title: String {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .authenticationFailed:
            return "Authentication failed"
        case .notAuthenticated:
            return "Not authenticated"
        case .badRequest:
            return "Bad request"
        case .forbidden:
            return "Access denied"
        case .notFound:
            return "Not found"
        case .noContent:
            return "No content"
        case .invalidResponse:
            return "Invalid response"
        case .invalidRequest:
            return "Invalid request"
        case .serverError:
            return "Server error"
        case .rateLimitExceeded:
            return "Too many requests"
        case .noAgentsAvailable:
            return "No assistants available"
        case .agentPoolTimeout:
            return "Assistant timed out"
        case .agentProvisionFailed:
            return "Couldn't add assistant"
        case .inviteCodeNotFound:
            return "Code not found"
        case .inviteCodeInvalidFormat:
            return "Invalid code"
        case .inviteCodeFullyRedeemed:
            return "Code already used up"
        case .notImplementedInGoldilocks:
            return "Not available"
        }
    }

    public var description: String {
        switch self {
        case .invalidURL:
            return "The URL is not valid."
        case .authenticationFailed:
            return "Failed to authenticate with the server."
        case .notAuthenticated:
            return "Failed to authorize with the server."
        case .badRequest(let message):
            return message ?? "The request was invalid."
        case .forbidden:
            return "You don't have permission to access this."
        case .notFound:
            return "The requested resource was not found."
        case .noContent:
            return "No content was returned."
        case .invalidResponse:
            return "The server returned an invalid response."
        case .invalidRequest:
            return "The request could not be created."
        case .serverError(let message):
            return message ?? "The server encountered an error."
        case .rateLimitExceeded:
            return "Too many requests. Please try again later."
        case .noAgentsAvailable:
            return "No assistants are available right now. Please try again later."
        case .agentPoolTimeout:
            return "Assistant setup took too long. Please try again."
        case .agentProvisionFailed:
            return "Something went wrong while adding an assistant. Please try again."
        case .inviteCodeNotFound:
            return "No invite code found with that value."
        case .inviteCodeInvalidFormat:
            return "Code must be 8 letters."
        case .inviteCodeFullyRedeemed:
            return "That invite code has already been fully redeemed."
        case .notImplementedInGoldilocks:
            return "This feature isn't available in Goldilocks."
        }
    }
}

extension TimeInterval {
    public static func calculateExponentialBackoff(for retryCount: Int) -> TimeInterval {
        guard retryCount >= 0 else { return 0.0 }
        let baseDelay: TimeInterval = 1.0
        let exponentialDelay = baseDelay * pow(2.0, Double(retryCount))
        let jitter = Double.random(in: 0...0.1) * exponentialDelay
        return min(exponentialDelay + jitter, 30.0) // Cap at 30 seconds
    }
}
