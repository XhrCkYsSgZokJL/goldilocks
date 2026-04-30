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
                    .foregroundStyle(.colorFillPrimary)
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

                if FeatureFlags.shared.isAssistantEnabled {
                    Section {
                        NavigationLink {
                            AssistantSettingsView(session: session)
                        } label: {
                            Text("Assistants")
                                .foregroundStyle(.colorTextPrimary)
                        }
                        .listRowInsets(.init(top: 0, leading: DesignConstants.Spacing.step4x, bottom: 0, trailing: 10.0))
                    } footer: {
                        Text("Optional AI for groups")
                    }
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
