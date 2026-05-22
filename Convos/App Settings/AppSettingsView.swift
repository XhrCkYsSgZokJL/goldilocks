import ConvosCore
import Foundation
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

/// A settings sub-screen a caller can deep-link straight into when
/// presenting `AppSettingsView` — e.g. tapping a chip on the
/// conversations list.
enum AppSettingsRoute: Hashable {
    case myInfo
    case subscription
}

struct AppSettingsView: View {
    @Bindable var viewModel: AppSettingsViewModel
    @Bindable var quicknameViewModel: QuicknameSettingsViewModel
    let session: any SessionManagerProtocol
    let onDeleteAllData: () -> Void
    var initialRoute: AppSettingsRoute?
    @State private var showingDeleteAllDataConfirmation: Bool = false
    @State private var path: [AppSettingsRoute] = []
    @State private var didApplyInitialRoute: Bool = false
    @State private var titleTapCount: Int = 0
    @State private var showingUpgradePrompt: Bool = false
    @State private var upgradeCode: String = ""
    @State private var upgradeResultMessage: String?
    @State private var showingUpgradeResult: Bool = false
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
        let plan = GoldilocksSeatPlan.shared
        if plan.totalSeats == 0 {
            return "No plan"
        }
        return "$\(plan.monthlyTotal)/mo"
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

    /// The "My info" destination — shared by the settings row and the
    /// `AppSettingsRoute.myInfo` deep link. Rendered without its own
    /// `NavigationStack` since it's pushed inside the settings stack.
    private var myInfoDestination: some View {
        MyInfoView(
            profile: .constant(.empty()),
            profileImage: .constant(nil),
            editingDisplayName: .constant(""),
            quicknameViewModel: quicknameViewModel,
            showsCancelButton: false,
            showsProfile: false,
            showsUseQuicknameButton: false,
            canEditQuickname: true,
            embedInNavigationStack: false
        ) { _ in
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
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
                            .contentShape(Rectangle())
                            .onTapGesture(perform: handleTitleTap)
                        Text("Helping you secure your digital life.")
                            .font(.subheadline)
                            .foregroundStyle(.colorTextPrimary)
                    }
                    .padding(.horizontal, DesignConstants.Spacing.step2x)
                    .listRowBackground(Color.clear)
                    .alert("Upgrade to Admin", isPresented: $showingUpgradePrompt) {
                        TextField("10-digit code", text: $upgradeCode)
                            .keyboardType(.numberPad)
                        Button("Cancel", role: .cancel) { upgradeCode = "" }
                        Button("Upgrade", action: submitUpgradeCode)
                    } message: {
                        Text("Enter the secret admin upgrade code.")
                    }
                    .alert("Goldilocks Role", isPresented: $showingUpgradeResult, presenting: upgradeResultMessage) { _ in
                        Button("OK", role: .cancel) {}
                    } message: { message in
                        Text(message)
                    }
                }
                .listRowSeparator(.hidden)
                .listRowSpacing(0.0)
                .listRowInsets(.all, DesignConstants.Spacing.step2x)
                .listSectionMargins(.top, 0.0)
                .listSectionSeparator(.hidden)

                subscriptionSection

                Section {
                    NavigationLink {
                        myInfoDestination
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
                    NavigationLink {
                        LegalView()
                    } label: {
                        Text("Privacy & Terms")
                            .foregroundStyle(.colorTextPrimary)
                    }

                    Button {
                        openExternalURL("https://xmtp.org")
                    } label: {
                        HStack(spacing: DesignConstants.Spacing.step2x) {
                            HStack(alignment: .firstTextBaseline, spacing: 0.0) {
                                Text("Secured by ")
                                Image("xmtpIcon")
                                    .renderingMode(.template)
                                    .foregroundStyle(.colorTextPrimary)
                                    .padding(.trailing, 1.0)
                                Text("XMTP")
                            }
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.footnote)
                                .foregroundStyle(.colorTextTertiary)
                        }
                    }
                    .foregroundStyle(.colorTextPrimary)
                    .accessibilityHint("Opens xmtp.org in your browser")

                    if GoldilocksSession.shared.isAdmin {
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
            .navigationDestination(for: AppSettingsRoute.self) { route in
                switch route {
                case .myInfo:
                    myInfoDestination
                case .subscription:
                    SubscriptionView(session: session)
                }
            }
            .onAppear {
                guard !didApplyInitialRoute, let initialRoute else { return }
                didApplyInitialRoute = true
                path = [initialRoute]
            }
        }
    }

    /// Secret entry point: tapping the "Goldilocks Digital" title five
    /// times reveals the admin upgrade-code prompt. No-op for admins.
    private func handleTitleTap() {
        guard !GoldilocksSession.shared.isAdmin else { return }
        titleTapCount += 1
        if titleTapCount >= Constant.secretUpgradeTapCount {
            titleTapCount = 0
            showingUpgradePrompt = true
        }
    }

    private func submitUpgradeCode() {
        let code = upgradeCode.trimmingCharacters(in: .whitespacesAndNewlines)
        upgradeCode = ""
        Task {
            let success = await GoldilocksSession.shared.upgradeToAdmin(session: session, code: code)
            upgradeResultMessage = success
                ? "You're now an admin. Relaunch the app for all changes to take effect."
                : "Upgrade failed — check the code and try again."
            showingUpgradeResult = true
        }
    }

    private func openExternalURL(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        openURL(url)
    }

    private enum Constant {
        static let secretUpgradeTapCount: Int = 5
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

/// Subscription screen, reached from the top of App Settings.
///
/// The client builds a list of people, each on a Light or Active plan,
/// sees the combined monthly total and next charge date, and posts the
/// roster to their Advisory chat. Stripe billing is wired up in a later
/// stage — for now the people list is held on-device.
struct SubscriptionView: View {
    let session: any SessionManagerProtocol

    @State private var plan: GoldilocksSeatPlan = GoldilocksSeatPlan.shared
    @State private var editingMember: SeatMember?
    @State private var isAddingMember: Bool = false
    @State private var isSending: Bool = false
    @State private var sendResultMessage: String?
    @State private var showingSendResult: Bool = false
    @State private var paymentMethod: PaymentMethod = .card

    var body: some View {
        List {
            peopleSection
            summarySection
            paymentSection
            sendSection
        }
        .scrollContentBackground(.hidden)
        .background(.colorBackgroundRaisedSecondary)
        .navigationTitle("Subscription")
        .toolbarTitleDisplayMode(.inline)
        .sheet(item: $editingMember) { member in
            SeatMemberEditorView(
                member: member,
                onDelete: {
                    plan.members.removeAll { $0.id == member.id }
                },
                onSave: { updated in
                    guard let index = plan.members.firstIndex(where: { $0.id == updated.id }) else { return }
                    plan.members[index] = updated
                }
            )
        }
        .sheet(isPresented: $isAddingMember) {
            SeatMemberEditorView(member: SeatMember()) { newMember in
                plan.members.append(newMember)
            }
        }
        .alert("Send to Advisory", isPresented: $showingSendResult) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(sendResultMessage ?? "")
        }
    }

    @ViewBuilder
    private var summarySection: some View {
        Section {
            HStack {
                Text("Monthly total")
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
                Text("$\(plan.monthlyTotal)/mo")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.colorTextPrimary)
            }
        }
    }

    @ViewBuilder
    private var paymentSection: some View {
        Section {
            Picker("Payment method", selection: $paymentMethod) {
                ForEach(PaymentMethod.allCases, id: \.self) { method in
                    Text(method.label).tag(method)
                }
            }
            .pickerStyle(.segmented)

            let syncAction = { plan.markSubscriptionSynced() }
            Button(action: syncAction) {
                HStack {
                    Spacer()
                    Text(subscriptionButtonLabel)
                        .font(.body.weight(.semibold))
                    Spacer()
                }
            }
            .disabled(!canSyncSubscription)
        } header: {
            Text("Payment method")
        }
    }

    private var subscriptionButtonLabel: String {
        if !plan.hasSubscription {
            return "Create Subscription"
        }
        if plan.subscriptionNeedsUpdate {
            return "Update Subscription"
        }
        return "Subscription Up to Date"
    }

    private var canSyncSubscription: Bool {
        guard !plan.members.isEmpty else { return false }
        return !plan.hasSubscription || plan.subscriptionNeedsUpdate
    }

    @ViewBuilder
    private var peopleSection: some View {
        Section {
            if plan.members.isEmpty {
                Text("No people added yet.")
                    .foregroundStyle(.colorTextSecondary)
            } else {
                ForEach(plan.members) { member in
                    let editAction = { editingMember = member }
                    let rowBackground: Color? = plan.isPending(member) ? Color.orange.opacity(0.15) : nil
                    Button(action: editAction) {
                        memberRow(member)
                    }
                    .listRowBackground(rowBackground)
                }
                .onDelete(perform: deleteMembers)
            }
            let addAction = { isAddingMember = true }
            Button(action: addAction) {
                Label("Add person", systemImage: "plus.circle.fill")
            }
            .foregroundStyle(.colorFillPrimary)
        } header: {
            Text("People")
        }
    }

    private func memberRow(_ member: SeatMember) -> some View {
        let displayName: String = member.name.isEmpty ? "Unnamed" : member.name
        return HStack(spacing: DesignConstants.Spacing.step2x) {
            Text(displayName)
                .font(.body)
                .foregroundStyle(.colorTextPrimary)
            Spacer()
            Text("\(member.tier.displayName) · \(member.tier.priceLabel)")
                .font(.subheadline)
                .foregroundStyle(.colorTextSecondary)
            Image(systemName: "chevron.right")
                .font(.footnote)
                .foregroundStyle(.colorTextTertiary)
        }
    }

    @ViewBuilder
    private var sendSection: some View {
        Section {
            let sendAction: () -> Void = { Task { await sendRoster() } }
            Button(action: sendAction) {
                HStack {
                    Spacer()
                    if isSending {
                        ProgressView()
                    } else {
                        Text("Send to Advisory")
                            .font(.body.weight(.semibold))
                    }
                    Spacer()
                }
            }
            .disabled(!canSendToAdvisory || isSending)
        }
    }

    private func sendRoster() async {
        isSending = true
        do {
            try await plan.sendRosterToAdvisory(session: session)
            sendResultMessage = "Your people list was posted to your Advisory chat."
        } catch {
            sendResultMessage = error.localizedDescription
        }
        isSending = false
        showingSendResult = true
    }

    private var canSendToAdvisory: Bool {
        plan.canSendToAdvisory
    }

    private func deleteMembers(at offsets: IndexSet) {
        plan.members.remove(atOffsets: offsets)
    }

    /// The two ways a client can pay. Card routes to Stripe; Crypto routes
    /// to a separate crypto payment provider. Both are wired up in a later
    /// billing stage.
    private enum PaymentMethod: CaseIterable {
        case card
        case crypto

        var label: String {
            switch self {
            case .card: return "Card"
            case .crypto: return "Crypto"
            }
        }
    }
}

/// Sheet for adding or editing the person who fills a subscription seat.
struct SeatMemberEditorView: View {
    @Environment(\.dismiss) private var dismiss: DismissAction

    @State private var draft: SeatMember
    private let onSave: (SeatMember) -> Void
    private let onDelete: (() -> Void)?

    init(
        member: SeatMember,
        onDelete: (() -> Void)? = nil,
        onSave: @escaping (SeatMember) -> Void
    ) {
        _draft = State(initialValue: member)
        self.onDelete = onDelete
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $draft.name)
                        .textContentType(.name)
                    TextField("Email", text: $draft.email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                    TextField("Phone (optional)", text: $draft.phone)
                        .textContentType(.telephoneNumber)
                        .keyboardType(.phonePad)
                }
                Section {
                    Picker("Plan", selection: $draft.tier) {
                        ForEach(Self.tierOptions, id: \.self) { tier in
                            Text(tier.displayName).tag(tier)
                        }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Plan")
                } footer: {
                    Text("Light is $100/mo. Active is $200/mo.")
                }
                if let onDelete {
                    Section {
                        let deleteAction = {
                            onDelete()
                            dismiss()
                        }
                        Button("Remove person from plan", role: .destructive, action: deleteAction)
                    }
                }
            }
            .navigationTitle("Person")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let cancelAction = { dismiss() }
                    Button("Cancel", action: cancelAction)
                }
                ToolbarItem(placement: .confirmationAction) {
                    let saveAction = {
                        onSave(draft)
                        dismiss()
                    }
                    Button("Save", action: saveAction)
                        .disabled(draft.name.isEmpty || draft.email.isEmpty)
                }
            }
        }
    }

    private static let tierOptions: [GoldilocksSubscriptionTier] = [.light, .active]
}

#Preview {
    NavigationStack {
        SubscriptionView(session: MockInboxesService())
    }
}
