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
        public let emeraldMembershipEnabled: Bool
        public let emeraldSeatLimit: Int
        public let referralCode: String?
        public let referralCreditCents: Int
        public let payingReferralCount: Int
        public let hasAppliedReferralCode: Bool

        public init(
            clientNumber: Int64,
            isAdmin: Bool,
            inboxId: String,
            emeraldMembershipEnabled: Bool = false,
            emeraldSeatLimit: Int = 0,
            referralCode: String? = nil,
            referralCreditCents: Int = 0,
            payingReferralCount: Int = 0,
            hasAppliedReferralCode: Bool = false
        ) {
            self.clientNumber = clientNumber
            self.isAdmin = isAdmin
            self.inboxId = inboxId
            self.emeraldMembershipEnabled = emeraldMembershipEnabled
            self.emeraldSeatLimit = emeraldSeatLimit
            self.referralCode = referralCode
            self.referralCreditCents = referralCreditCents
            self.payingReferralCount = payingReferralCount
            self.hasAppliedReferralCode = hasAppliedReferralCode
        }

        public init(from response: ConvosAPI.GoldilocksMeResponse) {
            self.clientNumber = response.clientNumber
            self.isAdmin = response.isAdmin
            self.inboxId = response.inboxId
            self.emeraldMembershipEnabled = response.emeraldMembershipEnabled
            self.emeraldSeatLimit = response.emeraldSeatLimit
            self.referralCode = response.referralCode
            self.referralCreditCents = response.referralCreditCents
            self.payingReferralCount = response.payingReferralCount
            self.hasAppliedReferralCode = response.hasAppliedReferralCode
        }
    }

    public enum AuthError: Error, LocalizedError {
        case missingPrivateKey
        case invalidSignatureLength(Int)

        public var errorDescription: String? {
            switch self {
            case .missingPrivateKey:
                return "No XMTP private key available. Keychain identity not loaded yet."
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

/// The Goldilocks Digital plan. Configured at launch from brand.json via
/// `GoldilocksPlan.configure(cents:label:)`.
public enum GoldilocksPlan {
    nonisolated(unsafe) private static var _monthlyPricePerPersonCents: Int = 10000
    nonisolated(unsafe) private static var _priceLabel: String = "$100/mo per person"

    public static func configure(monthlyPricePerPersonCents cents: Int, priceLabel label: String) {
        _monthlyPricePerPersonCents = cents
        _priceLabel = label
    }

    public static var monthlyPricePerPerson: Int { _monthlyPricePerPersonCents / 100 }
    public static var monthlyPricePerPersonCents: Int { _monthlyPricePerPersonCents }
    public static var priceLabel: String { _priceLabel }
}
