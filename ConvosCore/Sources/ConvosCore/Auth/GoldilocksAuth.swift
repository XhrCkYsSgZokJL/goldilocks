import Foundation
@preconcurrency import XMTPiOS

/// Identity registration with the Goldilocks backend.
///
/// After XMTP authentication completes, we run a second auth handshake
/// against the Goldilocks backend so it can confirm the user actually
/// owns the inbox they're claiming. The flow:
///
///   1. iOS asks `/v2/auth/challenge` for a SIWE message bound to
///      (deviceId, inboxId, ethAddress).
///   2. iOS signs the SIWE message with the inbox's secp256k1 private
///      key (the same key XMTP uses for the inbox's Ethereum identifier).
///   3. iOS posts the message + signature to `/v2/me`.
///   4. The backend verifies the signature, then queries the XMTP node
///      to confirm the recovered Ethereum address is currently bound
///      to the claimed inbox. On success it returns:
///         - clientNumber: monotonic int displayed in admin UIs as "#55"
///         - isAdmin:      whether this inbox is on the admin allowlist
///         - inboxId:      echoed for sanity check
///
/// This is the canonical XMTP-backend authentication pattern. It cannot
/// be impersonated: an attacker would need both the device's JWT *and*
/// the inbox's private key to forge a signature that recovers to a
/// XMTP-bound address.
public enum GoldilocksAuth {
    public struct Identity: Sendable, Equatable {
        public let clientNumber: Int64
        public let isAdmin: Bool
        public let inboxId: String
        public let subscriptionTier: GoldilocksSubscriptionTier?

        public init(
            clientNumber: Int64,
            isAdmin: Bool,
            inboxId: String,
            subscriptionTier: GoldilocksSubscriptionTier? = nil
        ) {
            self.clientNumber = clientNumber
            self.isAdmin = isAdmin
            self.inboxId = inboxId
            self.subscriptionTier = subscriptionTier
        }

        /// Build an identity from the backend's `/v2/me` response.
        public init(from response: ConvosAPI.GoldilocksMeResponse) {
            self.clientNumber = response.clientNumber
            self.isAdmin = response.isAdmin
            self.inboxId = response.inboxId
            self.subscriptionTier = response.subscriptionTier
                .flatMap(GoldilocksSubscriptionTier.init(rawValue:))
        }
    }

    public enum AuthError: Error, LocalizedError {
        case missingPrivateKey
        case invalidSignatureLength(Int)

        public var errorDescription: String? {
            switch self {
            case .missingPrivateKey:
                return "No XMTP private key available — keychain identity not loaded yet."
            case .invalidSignatureLength(let n):
                return "Unexpected signature length \(n) bytes (expected 64 or 65)."
            }
        }
    }

    /// Run the full handshake. Idempotent at the backend level — calling
    /// twice for the same (deviceId, inboxId, ethAddress) just re-issues
    /// the same `clientNumber`.
    ///
    /// - parameter inboxId: The XMTP inbox the caller is claiming.
    ///   Pulled from the keychain identity, not from the privateKey
    ///   directly (the inbox ID is computed by libxmtp at registration
    ///   time, not derivable from the secp256k1 keypair alone).
    public static func register(
        inboxId: String,
        privateKey: PrivateKey,
        apiClient: any ConvosAPIClientProtocol,
        claimAdminRole: Bool = false
    ) async throws -> Identity {
        let ethAddress = privateKey.walletAddress     // 0x... derived from secp256k1 pubkey

        let challenge = try await apiClient.fetchGoldilocksChallenge(
            inboxId: inboxId,
            ethAddress: ethAddress
        )

        // libxmtp's PrivateKey.sign returns an Ethereum personal_sign-style
        // signature. The raw bytes are 65: r(32) || s(32) || v(1). Some
        // implementations encode v as 0/1, others as 27/28. Backend verifier
        // (siwe / viem) accepts both, but normalize to 27/28 to be safe.
        let signatureBytes = try await privateKey.sign(challenge.siweMessage).rawData
        let normalized = try normalizeRecoveryV(signatureBytes)
        let signatureHex = "0x" + normalized.toHexString()

        let me = try await apiClient.registerWithGoldilocks(
            inboxId: inboxId,
            siweMessage: challenge.siweMessage,
            signature: signatureHex,
            claimAdminRole: claimAdminRole
        )

        return Identity(from: me)
    }

    /// EIP-191 personal_sign expects the recovery byte (v) to be 27 or 28.
    /// libxmtp may emit 0 or 1 instead. Bump if needed.
    private static func normalizeRecoveryV(_ data: Data) throws -> Data {
        guard data.count == 65 else {
            // 64-byte (compact, no v) signatures aren't supported by
            // EIP-191 verification on the backend.
            throw AuthError.invalidSignatureLength(data.count)
        }
        var bytes = [UInt8](data)
        if bytes[64] < 27 {
            bytes[64] &+= 27
        }
        return Data(bytes)
    }
}

/// The Goldilocks Digital subscription plans.
public enum GoldilocksSubscriptionTier: String, Codable, Sendable, Equatable, CaseIterable {
    /// "No plan" — the client is not subscribed (NULL on the backend).
    /// Declared first so it sorts to the top of the plan list.
    case noPlan = "none"
    case light
    case active

    /// Human-facing plan name.
    public var displayName: String {
        switch self {
        case .light: return "Light"
        case .active: return "Active"
        case .noPlan: return "No plan"
        }
    }

    /// Human-facing price.
    public var priceLabel: String {
        switch self {
        case .light: return "$100/mo"
        case .active: return "$200/mo"
        case .noPlan: return "$0"
        }
    }

    /// Monthly price per seat, in whole US dollars — used for seat totals.
    public var monthlyPrice: Int {
        switch self {
        case .light: return 100
        case .active: return 200
        case .noPlan: return 0
        }
    }
}
