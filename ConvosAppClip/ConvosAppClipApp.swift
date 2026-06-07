import ConvosCore
import ConvosCoreiOS
import SwiftUI

@main
struct ConvosAppClipApp: App {
    private let clipSession: ClipIdentityBootstrap.ClipSession

    init() {
        ConfigManager.configure(overrides: ConvosSecretOverrides(
            apiBaseURL: Secrets.CONVOS_API_BASE_URL,
            xmtpCustomHost: Secrets.XMTP_CUSTOM_HOST,
            gatewayURL: Secrets.GATEWAY_URL
        ))
        let environment = ConfigManager.shared.currentEnvironment
        ConvosLog.configure(environment: environment)
        ConvosLog.info("App Clip starting with environment: \(environment)", namespace: "ConvosAppClip")

        // Firebase App Check removed — see Convos/ConvosApp.swift for the
        // rationale (Path B of security plan item 7).

        // Dedicated clip bootstrap: seeds the shared-app-group keychain with
        // a single-inbox identity so the main app install skips onboarding.
        // Skips push-token registration, asset renewal, and
        // unused-conversation prewarm — all wasted (or actively wrong) in
        // the clip's ephemeral runtime.
        clipSession = MainActor.assumeIsolated {
            // App Clip has no PostHog SDK or user session — explicit no-op
            // sink. Goldilocks also scopes the clip identity to its keychain
            // access group.
            ClipIdentityBootstrap.bootstrap(
                environment: environment,
                platformProviders: .iOS(accessGroup: environment.keychainAccessGroup),
                coreActions: NoOpCoreActions()
            )
        }
    }

    var body: some Scene {
        WindowGroup {
            AppClipRootView()
        }
    }
}
