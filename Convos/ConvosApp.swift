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
    let profileSettingsViewModel: ProfileSettingsViewModel = .shared

    init() {
        FileDescriptorDiagnostics.raiseSoftLimit(to: 512)

        GoldilocksRolePrefs.applyToKeychain()

        ConfigManager.configure(overrides: ConvosSecretOverrides(
            apiBaseURL: Secrets.CONVOS_API_BASE_URL,
            xmtpCustomHost: Secrets.XMTP_CUSTOM_HOST,
            gatewayURL: Secrets.GATEWAY_URL
        ))
        let environment = ConfigManager.shared.currentEnvironment
        ConvosLog.configure(environment: environment)

        // Config-drift tripwire: the local stack's backend validates SIWE
        // registration against the local XMTP node, so a Local build pointed
        // at any other XMTP network can never register (the node's inbox
        // ledger is empty for it -> address_not_bound 401s, and the app sits
        // on "Setting up your channels..."). Name the misconfiguration at
        // launch instead of letting it manifest downstream.
        if case .local = environment, environment.xmtpEnv != .local {
            Log.error(
                "[Goldilocks] Config drift: the Local environment is paired with XMTP network " +
                "\(environment.xmtpEnv) instead of .local. The local backend validates inbox " +
                "ledgers against the local node, so registration will fail with address_not_bound. " +
                "Set \"xmtpNetwork\": \"local\" in config.local.json."
            )
        }

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

        let agentKeyset = AgentKeyset(endpointURL: AgentKeyset.endpointURL(for: environment))
        AgentKeysetStore.instance.configure(agentKeyset)

        self.convos = .client(
            environment: environment,
            platformProviders: .iOS,
            coreActions: NoOpCoreActions()
        )

        let dbWriter = convos.databaseWriter
        Task {
            await agentKeyset.prefetch()
            try? await AgentVerificationWriter.reverifyUnverifiedAgents(in: dbWriter)
        }
        self.conversationsViewModel = .init(session: convos.session)
        profileSettingsViewModel.bind(session: convos.session)
        appDelegate.session = convos.session
        appDelegate.pushNotificationRegistrar = convos.platformProviders.pushNotificationRegistrar
    }

    var body: some Scene {
        WindowGroup {
            ConversationsView(
                viewModel: conversationsViewModel,
                profileSettingsViewModel: profileSettingsViewModel
            )
            .safeAreaPadding(.top, DesignConstants.Spacing.stepX)
            .withSafeAreaEnvironment()
            .captureProtected(monitor: appDelegate.captureMonitor)
            .preferredColorScheme(BrandConfig.shared.theme?.mode == "dark" ? .dark : nil)
        }
    }
}
