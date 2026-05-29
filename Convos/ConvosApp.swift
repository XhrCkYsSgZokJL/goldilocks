import ConvosCore
import ConvosCoreiOS
import SwiftUI
import UserNotifications
import XMTPiOS

@main
struct ConvosApp: App {
    @UIApplicationDelegateAdaptor(ConvosAppDelegate.self) private var appDelegate: ConvosAppDelegate

    private let convos: ConvosClient
    let conversationsViewModel: ConversationsViewModel
    let quicknameViewModel: QuicknameSettingsViewModel = .shared

    init() {
        FileDescriptorDiagnostics.raiseSoftLimit(to: 512)

        // Goldilocks dual-identity: pin the keychain slot to the active
        // role's suffix BEFORE anything reads keys. Must be the first
        // thing in init().
        GoldilocksRolePrefs.applyToKeychain()

        ConfigManager.configure(overrides: ConvosSecretOverrides(
            apiBaseURL: Secrets.CONVOS_API_BASE_URL,
            xmtpCustomHost: Secrets.XMTP_CUSTOM_HOST,
            gatewayURL: Secrets.GATEWAY_URL
        ))
        let environment = ConfigManager.shared.currentEnvironment
        ConvosLog.configure(environment: environment)

        if !environment.isProduction {
            Log.info("Activating LibXMTP Log Writer...")
            Client.activatePersistentLibXMTPLogWriter(
                logLevel: .debug,
                rotationSchedule: .hourly,
                maxFiles: 10,
                customLogDirectory: environment.defaultXMTPLogsDirectoryURL,
                processType: .main
            )
        }
        Log.info("App starting with environment: \(environment)")
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        let appBuild = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"
        Log.info("Launch: version=\(appVersion) build=\(appBuild) commit=\(Secrets.GIT_COMMIT_SHA) environment=\(environment.name)")
        QAEvent.emit(.app, "launched", ["environment": environment.name])

        // Firebase App Check is removed from Goldilocks (Path B of security
        // plan item 7) — the backend doesn't verify the token, so sending
        // one is dead weight. The unauth `/v2/auth/token` and
        // `/v2/device/register` surface is defended by per-route rate
        // limits (item 8) and SIWE signature verification.

        let agentKeyset = AgentKeyset(endpointURL: AgentKeyset.endpointURL(for: environment))
        AgentKeysetStore.instance.configure(agentKeyset)

        self.convos = .client(
            environment: environment,
            platformProviders: .iOS(accessGroup: environment.keychainAccessGroup),
        )

        let dbWriter = convos.databaseWriter
        Task {
            await agentKeyset.prefetch()
            try? await AgentVerificationWriter.reverifyUnverifiedAgents(in: dbWriter)
        }
        self.conversationsViewModel = .init(session: convos.session)
        appDelegate.session = convos.session
        appDelegate.pushNotificationRegistrar = convos.platformProviders.pushNotificationRegistrar
    }

    var body: some Scene {
        WindowGroup {
            ConversationsView(
                viewModel: conversationsViewModel,
                quicknameViewModel: quicknameViewModel
            )
            .additionalTopSafeArea(DesignConstants.Spacing.stepX)
            .withSafeAreaEnvironment()
            // Blur the app + show a clear "recording detected" cue
            // whenever the system reports a screen capture is active.
            // The compositor-level block sits in SecureWindow; this is
            // the matching user-visible signal.
            .captureProtected(monitor: appDelegate.captureMonitor)
        }
    }
}
