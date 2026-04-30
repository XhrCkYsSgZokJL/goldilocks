import ConvosCore
import ConvosCoreiOS
import Foundation

/// Build-time role for this install. The active role is set in
/// `GoldilocksConfig.role` (constant in source) or the `GOLDILOCKS_ROLE`
/// scheme env var. Each role gets its own keychain slot so flipping the
/// flag and ⌘R picks up that role's persisted identity.
///
/// We deliberately don't try to switch identity at runtime — Convos's
/// SessionManager / MessagingService / SQLCipher DB are wired around a
/// single inbox and tearing them down to swap mid-session is invasive.
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
    /// Wire the keychain slot suffix and device-id suffix to the active
    /// (role, name) pair via `GoldilocksConfig.slotIdentifier`. Must be
    /// called before the first `KeychainIdentityStore` read AND before
    /// any device registration / auth call — i.e. as early as possible
    /// in app launch, before SessionManager or ConvosClient is constructed.
    static func applyToKeychain() {
        let suffix = GoldilocksConfig.slotIdentifier
        KeychainIdentityStore.slotSuffix = suffix
        IOSDeviceInfo.deviceIdSuffix = suffix
    }
}
