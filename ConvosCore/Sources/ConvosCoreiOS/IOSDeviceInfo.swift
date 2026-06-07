#if canImport(UIKit)
import ConvosCore
import Foundation
import UIKit

/// iOS implementation of device information provider.
///
/// Uses UIDevice for vendor identifier and provides iOS-specific OS string.
/// Must be initialized on the main thread to capture main actor-isolated UIDevice properties.
@MainActor
public final class IOSDeviceInfo: DeviceInfoProviding, @unchecked Sendable {
    private let _identifierForVendor: String?
    private let _deviceName: String

    /// Optional suffix appended to `deviceIdentifier` (e.g. "admin", "client").
    /// The Goldilocks role-toggle dev model uses this to keep separate
    /// device rows per role when running both roles on the same simulator,
    /// so the backend's per-device inbox lock doesn't collide. Set once
    /// at app launch before any registration call.
    nonisolated(unsafe) public static var deviceIdSuffix: String?

    public init() {
        _identifierForVendor = UIDevice.current.identifierForVendor?.uuidString
        _deviceName = UIDevice.current.name
    }

    /// Returns the device's identifier for vendor (IDFV).
    /// This is a unique identifier that persists across app launches but resets when all apps
    /// from the same vendor are deleted.
    public nonisolated var identifierForVendor: String? {
        _identifierForVendor
    }

    /// Returns a fallback identifier if IDFV is not available.
    /// This should rarely happen, but provides a backup solution.
    public nonisolated var fallbackIdentifier: String {
        // Generate a UUID and store it in UserDefaults as a fallback
        let key = "convos_fallback_device_id"
        if let stored = UserDefaults.standard.string(forKey: key) {
            return stored
        }

        let newId = UUID().uuidString
        UserDefaults.standard.set(newId, forKey: key)
        return newId
    }

    /// Returns the most appropriate device identifier.
    /// Prefers IDFV but falls back to a persistent UUID if needed.
    /// If `deviceIdSuffix` is set, it's appended as `<id>.<suffix>` so
    /// dev role-toggling produces distinct device rows on the backend.
    public nonisolated var deviceIdentifier: String {
        let base = identifierForVendor ?? fallbackIdentifier
        if let suffix = Self.deviceIdSuffix, !suffix.isEmpty {
            return "\(base).\(suffix)"
        }
        return base
    }

    /// Returns the current OS string.
    public nonisolated var osString: String {
        #if targetEnvironment(macCatalyst)
        return "macos"
        #else
        return "ios"
        #endif
    }

    /// User-visible device name from `UIDevice.current.name`. Captured at
    /// init time (main-actor) and exposed nonisolated.
    public nonisolated var deviceName: String {
        _deviceName
    }
}
#endif
