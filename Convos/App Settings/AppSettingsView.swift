import ConvosCore
import SwiftUI

struct ConvosToolbarButton: View {
    let padding: Bool
    let action: () -> Void

    var body: some View {
        Button {
            action()
        } label: {
            HStack(spacing: DesignConstants.Spacing.stepX) {
                Image("goldilocksLogo")
                    .resizable()
                    .renderingMode(.template)
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(.colorFillPrimary)
                    .frame(width: 24.0, height: 24.0)
                    .accessibilityHidden(true)

                Text("Goldilocks Digital")
                    .font(.body)
                    .foregroundStyle(.colorTextPrimary)
                    .padding(.trailing, DesignConstants.Spacing.stepX)
            }
            .padding(padding ? DesignConstants.Spacing.step2x : 0)
        }
        .accessibilityIdentifier("convos-logo-button")
    }
}

struct AppSettingsView: View {
    @Bindable var viewModel: AppSettingsViewModel
    @Bindable var quicknameViewModel: QuicknameSettingsViewModel
    let session: any SessionManagerProtocol
    let onDeleteAllData: () -> Void
    @State private var showingDeleteAllDataConfirmation: Bool = false
    @Environment(\.openURL) private var openURL: OpenURLAction
    @Environment(\.dismiss) private var dismiss: DismissAction

    @ViewBuilder
    private var connectionsSection: some View {
        if FeatureFlags.shared.isCloudConnectionsEnabled {
            Section {
                NavigationLink {
                    ConnectionsListView(viewModel: viewModel.connectionsListViewModel)
                } label: {
                    Text("Connections")
                        .foregroundStyle(.colorTextPrimary)
                }
                .listRowInsets(.init(top: 0, leading: DesignConstants.Spacing.step4x, bottom: 0, trailing: 10.0))
            } footer: {
                Text("Share services with conversations")
            }
        }
    }

    private var currentPlanLabel: String {
        if let tier = GoldilocksSession.shared.subscriptionTier {
            return tier.displayName
        }
        if GoldilocksSession.shared.requestedTier != nil {
            return "Pending"
        }
        return "No plan"
    }

    @ViewBuilder
    private var subscriptionSection: some View {
        if !GoldilocksSession.shared.isAdmin {
            Section {
                NavigationLink {
                    SubscriptionView(session: session)
                } label: {
                    HStack {
                        Image(systemName: "creditcard.fill")
                            .foregroundStyle(.colorTextPrimary)

                        Text("Subscription")
                            .foregroundStyle(.colorTextPrimary)

                        Spacer()

                        Text(currentPlanLabel)
                            .foregroundStyle(.colorTextSecondary)
                    }
                }
                .listRowInsets(.init(top: 0, leading: DesignConstants.Spacing.step4x, bottom: 0, trailing: 10.0))
            } footer: {
                Text("Your Goldilocks Digital plan")
            }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepX) {
                        Text("Goldilocks Digital")
                            .font(.title)
                            .fontWeight(.bold)
                            .tracking(Font.convosTitleTracking)
                            .foregroundStyle(.colorTextPrimary)
                            .minimumScaleFactor(0.7)
                            .lineLimit(1)
                        Text("Digital asset security tailored to the way you live.")
                            .font(.subheadline)
                            .foregroundStyle(.colorTextPrimary)
                    }
                    .padding(.horizontal, DesignConstants.Spacing.step2x)
                    .listRowBackground(Color.clear)
                }
                .listRowSeparator(.hidden)
                .listRowSpacing(0.0)
                .listRowInsets(.all, DesignConstants.Spacing.step2x)
                .listSectionMargins(.top, 0.0)
                .listSectionSeparator(.hidden)

                subscriptionSection

                Section {
                    NavigationLink {
                        MyInfoView(
                            profile: .constant(.empty()),
                            profileImage: .constant(nil),
                            editingDisplayName: .constant(""),
                            quicknameViewModel: quicknameViewModel,
                            showsCancelButton: false,
                            showsProfile: false,
                            showsUseQuicknameButton: false,
                            canEditQuickname: true
                        ) { _ in
                        }
                    } label: {
                        HStack {
                            Image(systemName: "lanyardcard.fill")
                                .foregroundStyle(.colorTextPrimary)

                            Text("My info")
                                .foregroundStyle(.colorTextPrimary)

                            Spacer()

                            if !quicknameViewModel.quicknameSettings.isDefault {
                                Text(quicknameViewModel.editingDisplayName)
                                    .foregroundStyle(.colorTextSecondary)

                                ProfileAvatarView(
                                    profile: quicknameViewModel.profile,
                                    profileImage: quicknameViewModel.profileImage,
                                    useSystemPlaceholder: false
                                )
                                .frame(width: 16.0, height: 16.0)
                            }
                        }
                    }
                    .accessibilityIdentifier("my-info-row")
                } footer: {
                    Text("Private unless you choose to share")
                }

                connectionsSection

                Section {
                    NavigationLink {
                        CustomizeSettingsView()
                    } label: {
                        HStack(spacing: DesignConstants.Spacing.step2x) {
                            Text("Customize")
                                .foregroundStyle(.colorTextPrimary)

                            Spacer()
                        }
                    }
                    .listRowInsets(.init(top: 0, leading: DesignConstants.Spacing.step4x, bottom: 0, trailing: 10.0))
                }
                .listRowSeparatorTint(.colorBorderSubtle)

                Section {
                    Button {
                        openExternalURL("https://xmtp.org")
                    } label: {
                        NavigationLink {
                            EmptyView()
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 0.0) {
                                Text("Secured by ")
                                Image("xmtpIcon")
                                    .renderingMode(.template)
                                    .foregroundStyle(.colorTextPrimary)
                                    .padding(.trailing, 1.0)
                                Text("XMTP")
                            }
                            .foregroundStyle(.colorTextPrimary)
                        }
                    }
                    .foregroundStyle(.colorTextPrimary)

                    Button {
                        openExternalURL("https://hq.convos.org/privacy-and-terms")
                    } label: {
                        NavigationLink("Privacy & Terms", destination: EmptyView())
                    }
                    .foregroundStyle(.colorTextPrimary)

                    Button {
                        sendFeedback()
                    } label: {
                        Text("Send feedback")
                    }
                    .foregroundStyle(.colorTextPrimary)

                    if !ConfigManager.shared.currentEnvironment.isProduction {
                        NavigationLink {
                            DebugExportView(environment: ConfigManager.shared.currentEnvironment, session: session)
                        } label: {
                            Text("Debug")
                        }
                        .foregroundStyle(.colorTextPrimary)
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text("Made in the open by XMTP Labs")
                            Spacer()
                            Text("V\(Bundle.appVersion)")
                                .foregroundStyle(.colorTextTertiary)
                        }
                        HStack {
                            Text("Modified in private by Goldilocks Digital")
                            Spacer()
                            Text("V1.0.0")
                                .foregroundStyle(.colorTextTertiary)
                        }
                    }
                    .foregroundStyle(.colorTextSecondary)
                }
                .listRowSeparatorTint(.colorBorderSubtle)

                Section {
                    Button(role: .destructive) {
                        showingDeleteAllDataConfirmation = true
                    } label: {
                        Text("Delete all app data")
                    }
                    .accessibilityLabel("Delete all app data")
                    .accessibilityHint("Permanently deletes all conversations and your quickname")
                    .accessibilityIdentifier("delete-all-data-button")
                    .selfSizingSheet(isPresented: $showingDeleteAllDataConfirmation) {
                        DeleteAllDataView(
                            viewModel: viewModel,
                            onComplete: {
                                dismiss()
                                onDeleteAllData()
                            }
                        )
                        .interactiveDismissDisabled(viewModel.isDeleting)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(.colorBackgroundRaisedSecondary)
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            .contentMargins(.top, 0.0)
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .cancel) {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .principal) {
                    ConvosToolbarButton(padding: true) {}
                        .glassEffect(.regular.tint(.colorBackgroundSurfaceless).interactive(), in: Capsule())
                        .disabled(true)
                }
            }
        }
    }

    private func sendFeedback() {
        let email = "convos@xmtp.com"
        let subject = "Convos Feedback"
        let mailtoString = "mailto:\(email)?subject=\(subject.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? subject)"

        if let mailtoURL = URL(string: mailtoString) {
            openURL(mailtoURL)
        }
    }

    private func openExternalURL(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        openURL(url)
    }
}

#Preview {
    let quicknameViewModel = QuicknameSettingsViewModel.shared
    NavigationStack {
        AppSettingsView(
            viewModel: .mock,
            quicknameViewModel: quicknameViewModel,
            session: MockInboxesService(),
            onDeleteAllData: {}
        )
    }
}

/// Subscription plans screen, reached from the top of App Settings.
/// Shows the three Goldilocks Digital tiers, marks the client's current
/// plan, and lets them request a change — the request is parked on the
/// backend for the Goldilocks team to approve from the `clients` CLI.
struct SubscriptionView: View {
    let session: any SessionManagerProtocol

    @State private var requestingTier: GoldilocksSubscriptionTier?
    @State private var resultMessage: String?
    @State private var showingResult: Bool = false

    var body: some View {
        List {
            Section {
                ForEach(GoldilocksSubscriptionTier.allCases, id: \.self) { tier in
                    planRow(for: tier)
                }
            } footer: {
                Text(footerText)
                    .foregroundStyle(.colorTextSecondary)
            }
        }
        .scrollContentBackground(.hidden)
        .background(.colorBackgroundRaisedSecondary)
        .navigationTitle("Subscription")
        .toolbarTitleDisplayMode(.inline)
        .alert("Subscription", isPresented: $showingResult) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(resultMessage ?? "")
        }
    }

    private func planRow(for tier: GoldilocksSubscriptionTier) -> some View {
        let isCurrent = GoldilocksSession.shared.subscriptionTier == tier
        let isRequested = GoldilocksSession.shared.requestedTier == tier
        let isBusy = requestingTier == tier
        let action: @MainActor () -> Void = {
            Task { @MainActor in
                requestingTier = tier
                let success = await GoldilocksSession.shared.requestSubscription(
                    session: session,
                    tier: tier
                )
                requestingTier = nil
                if success {
                    resultMessage = "Your request for the \(tier.displayName) plan has been sent. " +
                        "The Goldilocks team will confirm it shortly."
                } else {
                    resultMessage = "Couldn't send your request. " +
                        (GoldilocksSession.shared.lastError ?? "Please try again.")
                }
                showingResult = true
            }
        }

        return Button(action: action) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepX) {
                    Text(tier.displayName)
                        .font(.body)
                        .foregroundStyle(.colorTextPrimary)

                    Text(tier.priceLabel)
                        .font(.subheadline)
                        .foregroundStyle(.colorTextSecondary)
                }

                Spacer()

                planTrailing(isCurrent: isCurrent, isRequested: isRequested, isBusy: isBusy)
            }
        }
        .disabled(isCurrent || isRequested || requestingTier != nil)
    }

    @ViewBuilder
    private func planTrailing(isCurrent: Bool, isRequested: Bool, isBusy: Bool) -> some View {
        if isBusy {
            ProgressView()
        } else if isCurrent {
            Label("Current", systemImage: "checkmark.circle.fill")
                .font(.subheadline)
                .foregroundStyle(.colorFillPrimary)
        } else if isRequested {
            Text("Requested")
                .font(.subheadline)
                .foregroundStyle(.colorTextSecondary)
        } else {
            Image(systemName: "chevron.right")
                .font(.footnote)
                .foregroundStyle(.colorTextTertiary)
        }
    }

    private var footerText: String {
        if GoldilocksSession.shared.subscriptionTier == nil {
            return "You don't have an active plan yet. Request one and the Goldilocks team will set you up."
        }
        return "Choosing a plan sends a request to the Goldilocks team for approval."
    }
}

#Preview {
    NavigationStack {
        SubscriptionView(session: MockInboxesService())
    }
}
