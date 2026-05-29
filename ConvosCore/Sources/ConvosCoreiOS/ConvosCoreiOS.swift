#if canImport(UIKit)
// ConvosCoreiOS
//
// iOS-specific implementations for the Convos app.
// This package contains platform-specific code that depends on UIKit and other iOS frameworks.
//
// Usage:
// ```swift
// import ConvosCore
// import ConvosCoreiOS
//
// @main
// struct ConvosApp: App {
//     let convos: ConvosClient
//
//     init() {
//         convos = ConvosClient.client(
//             environment: .production,
//             platformProviders: .iOS
//         )
//     }
// }
// ```

import Foundation
import UserNotifications

// MARK: - iOS Platform Providers Extension

extension PlatformProviders {
    /// Creates platform providers configured for iOS.
    ///
    /// This provides:
    /// - `IOSAppLifecycleProvider` for app lifecycle events
    /// - `IOSDeviceInfo` for device information
    /// - `IOSPushNotificationRegistrar` for push notification management
    ///
    /// Must be called from the main actor (typically during app initialization).
    @MainActor
    public static func iOS(accessGroup: String) -> PlatformProviders {
        let appLifecycle = IOSAppLifecycleProvider()
        let deviceInfo = IOSDeviceInfo()
        let pushNotificationRegistrar = IOSPushNotificationRegistrar()

        DeviceInfo.configure(deviceInfo)
        PushNotificationRegistrar.configure(pushNotificationRegistrar)
        ImageCompression.configure(IOSImageCompression())
        RichLinkMetadata.configure(IOSRichLinkMetadataProvider())

        return PlatformProviders(
            appLifecycle: appLifecycle,
            deviceInfo: deviceInfo,
            pushNotificationRegistrar: pushNotificationRegistrar,
            notificationCenter: UNUserNotificationCenter.current(),
            backgroundUploadManager: BackgroundUploadManager.shared,
            oauthSessionProvider: IOSOAuthSessionProvider(),
            identityKeyWrapper: makeIdentityKeyWrapper(accessGroup: accessGroup),
        )
    }

    /// Creates platform providers configured for iOS app extensions (e.g., Notification Service Extension).
    ///
    /// Unlike `.iOS`, this does not require main actor isolation since extensions
    /// may initialize providers outside of the main actor context. Uses mock providers
    /// for components that aren't needed in extensions.
    public static func iOSExtension(accessGroup: String) -> PlatformProviders {
        PlatformProviders(
            appLifecycle: MockAppLifecycleProvider(),
            deviceInfo: MockDeviceInfoProvider(),
            pushNotificationRegistrar: MockPushNotificationRegistrarProvider(),
            notificationCenter: MockUserNotificationCenter(),
            identityKeyWrapper: makeIdentityKeyWrapper(accessGroup: accessGroup),
        )
    }

    /// Best-effort SE-backed wrapper. Falls back to the pass-through on
    /// hardware that lacks an SE (Intel-Mac simulators, CI) so the code
    /// path still works for development. Production iOS devices have an
    /// SE since the iPhone 5s, so this only no-ops in non-shipping
    /// configurations.
    private static func makeIdentityKeyWrapper(accessGroup: String) -> any IdentityKeyWrapper {
        do {
            return try SecureEnclaveIdentityKeyWrapper(
                service: "org.convos.ios.SecureEnclaveWrapper.v1",
                account: "convos-se-identity-wrapper",
                accessGroup: accessGroup,
            )
        } catch {
            return PassThroughIdentityKeyWrapper()
        }
    }
}

@_exported import ConvosCore
#endif
