import ConvosCore
import ConvosCoreiOS
import Foundation

/// The viewer's effective role. Every install starts `.client`; a user
/// becomes `.admin` only when their inbox is on the backend's admin
/// allowlist (`admin_inboxes`) — confirmed by `/v2/me` and surfaced
/// through `GoldilocksConfig.role` / `GoldilocksSession.role`.
///
/// There is no build-time role flag and no keychain-slot-per-role: one
/// XMTP identity per install. The role is purely a UI/behavior
/// distinction derived from server state, not a separate identity.
enum GoldilocksRole: String, Codable, CaseIterable {
    case client
    case admin

    var displayName: String {
        switch self {
        case .client: return "Client"
        case .admin:  return "Admin"
        }
    }
}

enum GoldilocksRolePrefs {
    /// Wire the keychain slot suffix and device-id suffix to the fixed
    /// `GoldilocksConfig.slotIdentifier`. Must be called before the first
    /// `KeychainIdentityStore` read AND before any device registration /
    /// auth call — i.e. as early as possible in app launch, before
    /// SessionManager or ConvosClient is constructed.
    static func applyToKeychain() {
        let suffix = GoldilocksConfig.slotIdentifier
        KeychainIdentityStore.slotSuffix = suffix
        IOSDeviceInfo.deviceIdSuffix = suffix
    }
}
