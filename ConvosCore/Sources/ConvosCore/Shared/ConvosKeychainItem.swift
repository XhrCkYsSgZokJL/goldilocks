import Foundation

/// Account identifiers for specific keychain items
enum KeychainAccount {
    /// Account for storing JWT access tokens, keyed by device ID
    static func jwt(deviceId: String) -> String {
        return deviceId
    }

    /// Account for storing refresh tokens, keyed by device ID. Stored in
    /// the same access class as the JWT so they share the same
    /// device-locked lifecycle.
    static func refreshToken(deviceId: String) -> String {
        return "refresh.\(deviceId)"
    }
}
