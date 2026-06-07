import Foundation

/// Account identifiers for specific keychain items
enum KeychainAccount {
    /// Account for storing JWT tokens, keyed by device ID (legacy
    /// device-only auth path; also the slot the refresh chain rides on).
    static func jwt(deviceId: String) -> String {
        return deviceId
    }

    /// Account for storing SIWE-bound JWT tokens, keyed by device ID
    /// AND the Ethereum address of the signed-in identity.
    static func siweJwt(deviceId: String, address: String) -> String {
        return "jwt:\(deviceId):siwe:\(address.lowercased())"
    }

    /// Account for storing the backend-assigned `accountId` for this
    /// (deviceId, address). Persists across the JWT's 15-minute expiry.
    static func siweAccountId(deviceId: String, address: String) -> String {
        return "accountId:\(deviceId):siwe:\(address.lowercased())"
    }

    /// Account for storing refresh tokens, keyed by device ID. Stored in
    /// the same access class as the JWT so they share the same
    /// device-locked lifecycle.
    static func refreshToken(deviceId: String) -> String {
        return "refresh.\(deviceId)"
    }
}
