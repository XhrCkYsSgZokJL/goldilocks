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
    case membership
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

    private var currentTierLabel: String {
        GoldilocksMembershipTier(
            activeMembers: GoldilocksSeatPlan.shared.billableSeatCount,
            hasActiveCoverage: GoldilocksSeatPlan.shared.coverageActive
        ).displayName
    }

    @ViewBuilder
    private var membershipSection: some View {
        Section {
            NavigationLink {
                MembershipView(session: session)
            } label: {
                HStack {
                    Image(systemName: "creditcard.fill")
                        .foregroundStyle(.colorTextPrimary)

                    Text("Membership")
                        .foregroundStyle(.colorTextPrimary)

                    Spacer()

                    Text(currentTierLabel)
                        .foregroundStyle(.colorTextSecondary)
                }
            }
            .listRowInsets(.init(top: 0, leading: DesignConstants.Spacing.step4x, bottom: 0, trailing: 10.0))
        } footer: {
            Text("Your Goldilocks Digital plan")
        }
    }

    @ViewBuilder
    private var invoicesSection: some View {
        Section {
            HStack {
                Image(systemName: "doc.text.fill")
                    .foregroundStyle(.colorTextSecondary)

                Text("Invoices")
                    .foregroundStyle(.colorTextSecondary)

                Spacer()

                Text("Coming soon")
                    .foregroundStyle(.colorTextTertiary)
            }
            .listRowInsets(.init(top: 0, leading: DesignConstants.Spacing.step4x, bottom: 0, trailing: 10.0))
        } footer: {
            Text("Reserved for Diamond tier clients")
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
                        TextField("1234-5678-9012-3456", text: $upgradeCode)
                            .keyboardType(.numberPad)
                            .onChange(of: upgradeCode) { _, newValue in
                                upgradeCode = formatAdminCode(newValue)
                            }
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

                membershipSection

                invoicesSection

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
                case .membership:
                    MembershipView(session: session)
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
        // Send the canonical digits — the field carries grouping dashes.
        let code: String = String(upgradeCode.filter { $0.isNumber })
        upgradeCode = ""
        Task {
            let success = await GoldilocksSession.shared.upgradeToAdmin(session: session, code: code)
            upgradeResultMessage = success
                ? "You're now an admin. Relaunch the app for all changes to take effect."
                : "Upgrade failed. Check the code and try again."
            showingUpgradeResult = true
        }
    }

    /// Group raw input into the dashed admin-code format
    /// ("1234-5678-9012-3456"). Strips non-digits and caps at 16 digits.
    private func formatAdminCode(_ raw: String) -> String {
        let digits: String = String(raw.filter { $0.isNumber }.prefix(16))
        var groups: [String] = []
        var index = digits.startIndex
        while index < digits.endIndex {
            let end = digits.index(index, offsetBy: 4, limitedBy: digits.endIndex) ?? digits.endIndex
            groups.append(String(digits[index..<end]))
            index = end
        }
        return groups.joined(separator: "-")
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

/// Membership screen, reached from the top of App Settings.
///
/// The client builds a list of people, each on a Light or Active plan.
/// That list sets a monthly rate and the client's Bronze/Silver/Gold
/// membership tier; the client buys blocks of coverage (a prepaid
/// balance) and the screen shows the date coverage runs out. Editing the
/// list just moves that date. Cancelling refunds the unused balance. The
/// client can also post the roster to their Advisory chat.
struct MembershipView: View {
    let session: any SessionManagerProtocol

    @Environment(\.openURL) private var openURL: OpenURLAction
    @Environment(\.scenePhase) private var scenePhase: ScenePhase

    @State private var plan: GoldilocksSeatPlan = GoldilocksSeatPlan.shared
    @State private var editingMember: SeatMember?
    @State private var showingAddPerson: Bool = false
    @State private var newMemberFirstName: String = ""
    @State private var newMemberMiddleName: String = ""
    @State private var newMemberLastName: String = ""
    @State private var newMemberEmail: String = ""
    @State private var newMemberEmailLabel: EmailLabel = .other
    @State private var pendingAdd: PendingAdd?
    @State private var verifyResultMessage: String?
    @State private var showingVerifyResult: Bool = false
    @State private var billingResultMessage: String?
    @State private var showingBillingResult: Bool = false
    @State private var showingCancelConfirm: Bool = false
    @State private var paymentMethod: GoldilocksPaymentMethod = .card
    @State private var prepaidDuration: GoldilocksPrepaidDuration = .oneMonth
    @State private var billingStatus: ConvosAPI.GoldilocksBillingStatusResponse?
    @State private var isStartingCheckout: Bool = false
    @State private var isRefreshingBilling: Bool = false
    @State private var isCancelling: Bool = false
    @State private var checkoutInitiated: Bool = false
    @State private var balanceBeforeCheckout: Int = 0

    /// Parses the backend's ISO-8601 `activeUntil` (JavaScript
    /// `toISOString()` always includes fractional seconds).
    private static let dateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    var body: some View {
        listContent
            .onChange(of: scenePhase) { _, newPhase in
                guard newPhase == .active, checkoutInitiated else { return }
                Task { await refreshBillingStatus() }
            }
            .onChange(of: plan.members) { _, _ in
                Task { await savePeopleList() }
            }
            .task {
                await plan.loadFromBackend(session: session)
                await syncSeats()
            }
    }

    private var listContent: some View {
        List {
            tierSection
            peopleSection
            coverageSection
            paymentSection
            pendingCheckoutSection
        }
        .scrollContentBackground(.hidden)
        .background(.colorBackgroundRaisedSecondary)
        .navigationTitle("Membership")
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !plan.members.isEmpty {
                    EditButton()
                }
            }
        }
        .sheet(item: $editingMember) { member in
            MemberEditSheet(
                member: member,
                onSave: { updated in
                    guard let index = plan.members.firstIndex(where: { $0.id == updated.id }) else { return }
                    plan.members[index] = updated
                },
                onRemove: {
                    plan.members.removeAll { $0.id == member.id }
                }
            )
        }
        .sheet(isPresented: $showingAddPerson) {
            AddPersonSheet(
                firstName: $newMemberFirstName,
                middleName: $newMemberMiddleName,
                lastName: $newMemberLastName,
                email: $newMemberEmail,
                emailLabel: $newMemberEmailLabel,
                pendingAdd: $pendingAdd,
                onAdded: handleVerifiedAdd,
                onTooManyAttempts: handleTooManyAttempts
            )
        }
        .alert("Verification", isPresented: $showingVerifyResult) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(verifyResultMessage ?? "")
        }
        .alert("Coverage", isPresented: $showingBillingResult) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(billingResultMessage ?? "")
        }
        .alert("Cancel coverage?", isPresented: $showingCancelConfirm) {
            Button("Keep coverage", role: .cancel) {}
            let confirmAction: () -> Void = { Task { await cancelCoverage() } }
            Button("Cancel & refund", role: .destructive, action: confirmAction)
        } message: {
            Text(cancelConfirmMessage)
        }
    }

    /// Verified-code success path. The new person is on the plan, the
    /// form clears, and the Add Person sheet dismisses so the user lands
    /// back on Membership and sees the new name in the list. The
    /// dismissal + alert are deferred by a short delay so the inner
    /// VerifyCodeSheet's dismiss animation finishes first — collapsing
    /// two sheets in the same runloop tick on iOS 26 tears down the
    /// whole settings sheet stack, bouncing the user back to the
    /// conversation list.
    private func handleVerifiedAdd(_ member: SeatMember) {
        plan.members.append(member)
        let addedLabel: String = member.displayName
        pendingAdd = nil
        newMemberFirstName = ""
        newMemberMiddleName = ""
        newMemberLastName = ""
        newMemberEmail = ""
        newMemberEmailLabel = .other
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            showingAddPerson = false
            try? await Task.sleep(nanoseconds: 250_000_000)
            showVerifyResult("\(addedLabel) was added to your plan.")
        }
    }

    /// Third wrong-code path. Drop the in-flight verification, close
    /// the Add Person sheet, and surface a "send a fresh code" alert —
    /// staggered for the same multi-sheet-collapse reason as the
    /// success path.
    private func handleTooManyAttempts() {
        pendingAdd = nil
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            showingAddPerson = false
            try? await Task.sleep(nanoseconds: 250_000_000)
            showVerifyResult("Too many incorrect codes. Tap Send verification code to send a fresh one.")
        }
    }

    private var tierSection: some View {
        let tier: GoldilocksMembershipTier = GoldilocksMembershipTier(
            activeMembers: plan.billableSeatCount,
            hasActiveCoverage: plan.coverageActive
        )
        return Section {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: tier.iconName)
                    .foregroundStyle(tier.accentColor)
                Text("\(tier.displayName) member")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
            }
            .listRowBackground(tier.tintColor)
        } header: {
            Text("Your tier")
        } footer: {
            Text(tier.membershipDetail)
        }
    }

    /// Visible whenever the client has a prepaid balance — even if they
    /// have zero billable people right now (rate = 0). That "paused"
    /// state still shows the row so the client can cancel + refund
    /// instead of stranding the balance.
    @ViewBuilder
    private var coverageSection: some View {
        if hasCoverageBalance {
            Section {
                let tapAction = { showingCancelConfirm = true }
                Button(action: tapAction) {
                    HStack(spacing: DesignConstants.Spacing.step2x) {
                        Text(coverageStatusText)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.colorTextPrimary)
                        Spacer()
                        let balance: Int = billingStatus?.balanceCents ?? 0
                        if balance > 0 {
                            Text("$\(balance / 100) left")
                                .font(.subheadline)
                                .foregroundStyle(.colorTextSecondary)
                        }
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.colorTextTertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isCancelling)
            } header: {
                Text("Coverage")
            } footer: {
                Text("Tap to close coverage and refund your unused balance to your card.")
            }
        }
    }

    @ViewBuilder
    private var paymentSection: some View {
        Section {
            paymentMethodPicker
            durationPicker
            billingDetailRow
            checkoutButton
        } header: {
            Text(isCoverageActive ? "Extend coverage" : "Add coverage")
        } footer: {
            paymentSectionFooter
        }
    }

    private var paymentMethodPicker: some View {
        Picker("Payment method", selection: $paymentMethod) {
            ForEach(GoldilocksPaymentMethod.allCases, id: \.self) { method in
                Text(method.displayName).tag(method)
            }
        }
        .pickerStyle(.segmented)
    }

    private var durationPicker: some View {
        Picker("Duration", selection: $prepaidDuration) {
            ForEach(GoldilocksPrepaidDuration.allCases, id: \.self) { duration in
                Text(duration.displayName).tag(duration)
            }
        }
        .pickerStyle(.menu)
    }

    private var billingDetailRow: some View {
        HStack {
            Text("Total today")
                .foregroundStyle(.colorTextSecondary)
            Spacer()
            Text("$\(chargeTotal)")
                .font(.body.weight(.semibold))
                .foregroundStyle(.colorTextPrimary)
        }
    }

    private var checkoutButton: some View {
        let action: () -> Void = { Task { await startCheckout() } }
        return Button(action: action) {
            HStack {
                Spacer()
                if isStartingCheckout {
                    ProgressView()
                } else {
                    Text(checkoutButtonLabel)
                        .font(.body.weight(.semibold))
                }
                Spacer()
            }
        }
        .disabled(!canStartCheckout || isStartingCheckout)
    }

    private var paymentSectionFooter: some View {
        let verb: String = isCoverageActive ? "Extends" : "Adds"
        return Text("\(verb) \(prepaidDuration.displayName) of coverage. Editing your membership moves the coverage date.")
    }

    @ViewBuilder
    private var pendingCheckoutSection: some View {
        if checkoutInitiated {
            Section {
                let refreshAction: () -> Void = { Task { await refreshBillingStatus() } }
                Button(action: refreshAction) {
                    HStack {
                        Spacer()
                        if isRefreshingBilling {
                            ProgressView()
                        } else {
                            Text("Refresh Payment Status")
                                .font(.body.weight(.semibold))
                        }
                        Spacer()
                    }
                }
                .disabled(isRefreshingBilling)
            } header: {
                Text("Pending payment")
            } footer: {
                Text("Finish checkout in your browser, then return here. Status also refreshes automatically when you reopen the app.")
            }
        }
    }

    private var chargeTotal: Int {
        plan.monthlyTotal * prepaidDuration.months
    }

    private var checkoutButtonLabel: String {
        if paymentMethod == .crypto {
            return "Coming Soon"
        }
        let verb: String = isCoverageActive ? "Extend" : "Add"
        return "\(verb) \(prepaidDuration.displayName)"
    }

    private var canStartCheckout: Bool {
        paymentMethod == .card && !plan.members.isEmpty
    }

    private var isCoverageActive: Bool {
        billingStatus?.activeUntil != nil
    }

    /// True whenever there's an unused prepaid balance, including the
    /// "paused" case where the client added cover, then removed every
    /// billable person (so the rate dropped to zero and the balance
    /// stopped burning). The Coverage section uses this so the client
    /// can still cancel + refund instead of stranding the credit.
    private var hasCoverageBalance: Bool {
        (billingStatus?.balanceCents ?? 0) > 0
    }

    private var coverageStatusText: String {
        guard let status = billingStatus else { return "Checking…" }
        if let activeUntil = status.activeUntil,
           let date = Self.dateFormatter.date(from: activeUntil) {
            return "Active until \(date.formatted(date: .abbreviated, time: .omitted))"
        }
        if (status.balanceCents) > 0 {
            return "Paused"
        }
        return "No active coverage"
    }

    private var cancelConfirmMessage: String {
        "Coverage ends now. Your unused balance is refunded to your card, pro-rata against your most recent top-ups."
    }

    @ViewBuilder
    private var peopleSection: some View {
        Section {
            if plan.members.isEmpty {
                Text("No people on your plan yet.")
                    .foregroundStyle(.colorTextSecondary)
            } else {
                ForEach(plan.members) { member in
                    memberRow(member)
                }
                .onDelete(perform: deleteMembers)
                .onMove(perform: moveMembers)
            }
            addSomeoneRow
        } header: {
            Text("People")
        } footer: {
            Text("\(GoldilocksPlan.priceLabel). Tap a person to edit their name, swipe to remove, or long press a row to reorder.")
        }
    }

    /// Bottom row of the People section. Tapping opens the Add Person
    /// sheet. If a verification is already in flight (the sheet was
    /// dismissed before it completed), the row labels itself
    /// "Continue adding…" with a hint, so the user can pick up where
    /// they left off.
    private var addSomeoneRow: some View {
        let title: String = pendingAdd != nil ? "Continue adding…" : "Add someone"
        let subtitle: String? = pendingAdd?.email
        let tapAction = { showingAddPerson = true }
        return Button(action: tapAction) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: "plus.circle.fill")
                    .foregroundStyle(.colorFillPrimary)
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.colorTextPrimary)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.colorTextSecondary)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.colorTextTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// One row per person. Tap opens a sheet to edit their info. Emails
    /// and other contact details are deliberately not shown here so the
    /// list reads as a clean roster of names.
    private func memberRow(_ member: SeatMember) -> some View {
        let displayName: String = member.displayName
        let tapAction = { editingMember = member }
        return Button(action: tapAction) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                    Text(displayName)
                        .font(.body)
                        .foregroundStyle(.colorTextPrimary)
                    if !member.enabled {
                        Text("Disabled")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.colorTextTertiary)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.colorTextTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func showVerifyResult(_ message: String) {
        verifyResultMessage = message
        showingVerifyResult = true
    }

    /// Push the current seat count to the backend so it can re-settle the
    /// balance and recompute the coverage date. Runs on appear and whenever
    /// the people list changes.
    private func syncSeats() async {
        do {
            billingStatus = try await session.syncGoldilocksSeats(
                seats: plan.billableSeatCount
            )
            cacheCoverageActive()
        } catch {
            Log.warning("[Goldilocks] Seat sync failed: \(error.localizedDescription)")
        }
    }

    /// Cache "has active coverage" onto the seat plan so the membership
    /// tier shown on other screens — the conversations-list chip and the
    /// App Settings row — reflects whether coverage is actually active.
    private func cacheCoverageActive() {
        plan.coverageActive = (billingStatus?.balanceCents ?? 0) > 0
    }

    /// Persist a people-list edit — push the encrypted list to the backend,
    /// then re-sync the billing seat counts.
    private func savePeopleList() async {
        await plan.saveToBackend(session: session)
        await syncSeats()
    }

    /// Ask the backend for a Stripe Checkout Session and open the hosted
    /// page in the browser. The webhook credits the balance; the screen
    /// reconciles via `refreshBillingStatus` once the user returns.
    private func startCheckout() async {
        guard paymentMethod == .card else { return }
        isStartingCheckout = true
        do {
            let response = try await session.createGoldilocksCheckout(
                paymentMethod: paymentMethod,
                durationMonths: prepaidDuration.months,
                seats: plan.billableSeatCount
            )
            if let url = URL(string: response.checkoutUrl) {
                balanceBeforeCheckout = billingStatus?.balanceCents ?? 0
                checkoutInitiated = true
                openURL(url)
            } else {
                showBillingResult("Couldn't open the checkout page.")
            }
        } catch {
            showBillingResult("Couldn't start checkout: \(error.localizedDescription)")
        }
        isStartingCheckout = false
    }

    /// Re-check billing state after a checkout. A balance higher than it
    /// was before the checkout means the top-up has landed.
    private func refreshBillingStatus() async {
        isRefreshingBilling = true
        do {
            let status = try await session.fetchGoldilocksBillingStatus()
            billingStatus = status
            cacheCoverageActive()
            if checkoutInitiated, status.balanceCents > balanceBeforeCheckout {
                checkoutInitiated = false
                showBillingResult("Your coverage is active.")
            }
        } catch {
            // Transient failures are expected while a payment settles; the
            // user can retry, so don't surface an alert here.
            Log.warning("[Goldilocks] Billing status refresh failed: \(error.localizedDescription)")
        }
        isRefreshingBilling = false
    }

    /// Stop coverage and refund the unused balance to the card.
    private func cancelCoverage() async {
        isCancelling = true
        do {
            let result = try await session.cancelGoldilocksBilling()
            billingStatus = try await session.fetchGoldilocksBillingStatus()
            cacheCoverageActive()
            showBillingResult("Coverage cancelled. $\(result.refundedCents / 100) refunded to your card.")
        } catch {
            showBillingResult("Couldn't cancel coverage: \(error.localizedDescription)")
        }
        isCancelling = false
    }

    private func showBillingResult(_ message: String) {
        billingResultMessage = message
        showingBillingResult = true
    }

    private func deleteMembers(at offsets: IndexSet) {
        plan.members.remove(atOffsets: offsets)
    }

    /// Client-side cosmetic reorder. The new order rides along in the
    /// encrypted blob the next time `plan.saveToBackend` runs (because
    /// `members` is the array being persisted), but the backend never
    /// reads or acts on order — it's purely the client's preferred
    /// arrangement.
    private func moveMembers(from source: IndexSet, to destination: Int) {
        plan.members.move(fromOffsets: source, toOffset: destination)
    }
}

/// Modal editor for a person already on the plan. Name, phone, and
/// address are free-form. Emails are managed as a list — adding a new
/// email triggers the same verify-code handshake as the initial add,
/// so every address on the person's profile is verified before it
/// lands in the saved list. At least one verified email must remain on
/// the person at save time. A confirmation dialog gates the
/// destructive remove.
private struct MemberEditSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction

    let member: SeatMember
    let onSave: (SeatMember) -> Void
    let onRemove: () -> Void

    @State private var firstName: String
    @State private var middleName: String
    @State private var lastName: String
    @State private var emails: [LabeledEmail]
    @State private var phone: String
    @State private var address: PersonAddress
    @State private var showingRemoveConfirm: Bool = false
    @State private var presentingAddEmail: Bool = false

    init(
        member: SeatMember,
        onSave: @escaping (SeatMember) -> Void,
        onRemove: @escaping () -> Void
    ) {
        self.member = member
        self.onSave = onSave
        self.onRemove = onRemove
        self._firstName = State(initialValue: member.firstName)
        self._middleName = State(initialValue: member.middleName)
        self._lastName = State(initialValue: member.lastName)
        self._emails = State(initialValue: member.emails)
        self._phone = State(initialValue: member.phone)
        self._address = State(initialValue: member.address)
    }

    var body: some View {
        NavigationStack {
            Form {
                nameSection
                emailsSection
                phoneSection
                addressSection
                removeSection
            }
            .navigationTitle("Edit person")
            .toolbarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .sheet(isPresented: $presentingAddEmail) {
                AddEmailSheet { newEmail in
                    emails.append(newEmail)
                }
            }
            .confirmationDialog(
                "Remove \(member.displayName) from your plan?",
                isPresented: $showingRemoveConfirm,
                titleVisibility: .visible
            ) {
                let removeAction = {
                    onRemove()
                    dismiss()
                }
                Button("Remove", role: .destructive, action: removeAction)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("They'll stop counting toward your coverage and be unsubscribed from the service.")
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            let cancelAction = { dismiss() }
            Button("Cancel", action: cancelAction)
        }
        ToolbarItem(placement: .confirmationAction) {
            let saveAction = {
                onSave(updatedMember)
                dismiss()
            }
            Button("Save", action: saveAction)
                .disabled(!canSave)
        }
    }

    private var nameSection: some View {
        Section {
            TextField("First name", text: $firstName)
                .textContentType(.givenName)
            TextField("Middle name", text: $middleName)
                .textContentType(.middleName)
            TextField("Last name", text: $lastName)
                .textContentType(.familyName)
        } header: {
            Text("Name")
        }
    }

    private var emailsSection: some View {
        Section {
            if emails.isEmpty {
                Text("No emails on file")
                    .foregroundStyle(.colorTextSecondary)
            } else {
                ForEach(emails) { email in
                    emailRow(email)
                }
                .onDelete(perform: deleteEmails)
            }
            addEmailButton
        } header: {
            Text("Emails")
        } footer: {
            Text("Every email must be verified before it's saved. At least one verified email is required.")
        }
    }

    private func emailRow(_ email: LabeledEmail) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                Text(email.address)
                    .foregroundStyle(.colorTextPrimary)
                Text(email.label.displayName)
                    .font(.caption)
                    .foregroundStyle(.colorTextSecondary)
            }
            Spacer()
            if email.verified {
                Text("Verified")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.colorTextSecondary)
            }
        }
    }

    private var addEmailButton: some View {
        let tapAction = { presentingAddEmail = true }
        return Button(action: tapAction) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: "plus.circle.fill")
                    .foregroundStyle(.colorFillPrimary)
                Text("Add email")
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
            }
        }
        .buttonStyle(.plain)
    }

    private var phoneSection: some View {
        Section {
            TextField("Phone", text: $phone)
                .textContentType(.telephoneNumber)
                .keyboardType(.phonePad)
        } header: {
            Text("Phone")
        }
    }

    private var addressSection: some View {
        Section {
            TextField("Street", text: $address.street)
                .textContentType(.streetAddressLine1)
            TextField("City", text: $address.city)
                .textContentType(.addressCity)
            TextField("State / Region", text: $address.state)
                .textContentType(.addressState)
            TextField("Postal code", text: $address.postalCode)
                .textContentType(.postalCode)
            TextField("Country", text: $address.country)
                .textContentType(.countryName)
        } header: {
            Text("Address")
        }
    }

    private var removeSection: some View {
        Section {
            let removeAction = { showingRemoveConfirm = true }
            Button(role: .destructive, action: removeAction) {
                HStack {
                    Spacer()
                    Text("Remove from plan")
                        .font(.body.weight(.semibold))
                    Spacer()
                }
            }
        }
    }

    private func deleteEmails(at offsets: IndexSet) {
        emails.remove(atOffsets: offsets)
    }

    /// Save is allowed when at least one verified email is present and
    /// the form differs from what was loaded.
    private var canSave: Bool {
        let hasVerifiedEmail: Bool = emails.contains(where: { $0.verified })
        return hasVerifiedEmail && updatedMember != member
    }

    /// The `SeatMember` that would be persisted if the user tapped
    /// Save right now. Whitespace is trimmed off every free-form
    /// field so an accidental trailing space doesn't masquerade as a
    /// real edit.
    private var updatedMember: SeatMember {
        var updated: SeatMember = member
        updated.firstName = firstName.trimmingCharacters(in: .whitespaces)
        updated.middleName = middleName.trimmingCharacters(in: .whitespaces)
        updated.lastName = lastName.trimmingCharacters(in: .whitespaces)
        updated.emails = emails
        updated.phone = phone.trimmingCharacters(in: .whitespaces)
        updated.address = PersonAddress(
            street: address.street.trimmingCharacters(in: .whitespaces),
            city: address.city.trimmingCharacters(in: .whitespaces),
            state: address.state.trimmingCharacters(in: .whitespaces),
            postalCode: address.postalCode.trimmingCharacters(in: .whitespaces),
            country: address.country.trimmingCharacters(in: .whitespaces)
        )
        return updated
    }
}

/// Sub-sheet for adding a new email to an existing person. Same verify-
/// code handshake as the initial add — the new address only lands in
/// the parent's emails list once the code clears, which is what
/// guarantees every saved email is verified.
private struct AddEmailSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction

    let onVerified: (LabeledEmail) -> Void

    @State private var address: String = ""
    @State private var label: EmailLabel = .other
    @State private var code: String = ""
    @State private var attemptsLeft: Int = EmailCodeVerification.maxAttempts
    @State private var codeSent: Bool = false
    @State private var alertMessage: String?
    @State private var showingAlert: Bool = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $address)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .disabled(codeSent)
                    Picker("Label", selection: $label) {
                        ForEach(EmailLabel.allCases) { option in
                            Text(option.displayName).tag(option)
                        }
                    }
                    .disabled(codeSent)
                } footer: {
                    Text(footerText)
                }
                if codeSent {
                    codeSection
                } else {
                    sendSection
                }
            }
            .navigationTitle("Add email")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .alert("Verification", isPresented: $showingAlert) {
                Button("OK", role: .cancel) { codeFocused = true }
            } message: {
                Text(alertMessage ?? "")
            }
        }
    }

    private var sendSection: some View {
        Section {
            let trimmed: String = address.trimmingCharacters(in: .whitespaces)
            let canSend: Bool = !trimmed.isEmpty
            let sendAction = {
                guard canSend else { return }
                codeSent = true
                codeFocused = true
            }
            Button(action: sendAction) {
                HStack {
                    Spacer()
                    Text("Send verification code")
                        .font(.body.weight(.semibold))
                    Spacer()
                }
            }
            .disabled(!canSend)
        }
    }

    private var codeSection: some View {
        Section {
            TextField("000000", text: codeBinding)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.system(.title2, design: .monospaced).weight(.semibold))
                .multilineTextAlignment(.center)
                .tracking(8)
                .focused($codeFocused)
        } header: {
            Text("Enter code")
        } footer: {
            Text("We sent a 6-digit code to \(address).")
        }
    }

    private var footerText: String {
        codeSent
            ? "Enter the code we sent to add this email to the person's profile."
            : "We'll email a 6-digit code so this address can be verified before it's saved."
    }

    private var codeBinding: Binding<String> {
        Binding(
            get: { code },
            set: { newValue in
                let digitsOnly: String = String(newValue.filter { $0.isNumber }.prefix(EmailCodeVerification.codeLength))
                code = digitsOnly
                if digitsOnly.count == EmailCodeVerification.codeLength {
                    Task { @MainActor in verifyCode() }
                }
            }
        )
    }

    private func verifyCode() {
        if EmailCodeVerification.isValid(code) {
            let verified: LabeledEmail = LabeledEmail(
                address: address.trimmingCharacters(in: .whitespaces),
                label: label,
                verified: true
            )
            onVerified(verified)
            dismiss()
            return
        }
        attemptsLeft -= 1
        code = ""
        if attemptsLeft <= 0 {
            alertMessage = "Too many incorrect codes. Cancel and try again."
            showingAlert = true
            return
        }
        let triesLabel: String = attemptsLeft == 1 ? "1 try left" : "\(attemptsLeft) tries left"
        alertMessage = "That code didn't match — \(triesLabel)."
        showingAlert = true
    }
}

/// Modal that hosts the two-stage Add Person flow. The form (name,
/// email, "Send verification code") lives here; tapping Send presents
/// `VerifyCodeSheet` on top. Dismissing the verify sheet (swipe down)
/// keeps the in-flight `PendingAdd`, and this sheet swaps the form's
/// final row for "Enter code" + "Cancel code" so the user can resume
/// or abandon the verification.
private struct AddPersonSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction

    @Binding var firstName: String
    @Binding var middleName: String
    @Binding var lastName: String
    @Binding var email: String
    @Binding var emailLabel: EmailLabel
    @Binding var pendingAdd: PendingAdd?
    let onAdded: (SeatMember) -> Void
    let onTooManyAttempts: () -> Void

    @State private var showingCodeEntry: Bool = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    firstNameField
                    middleNameField
                    lastNameField
                } header: {
                    Text("Name")
                } footer: {
                    Text("Name fields are optional — the person is identified by their verified email.")
                }
                Section {
                    emailField
                    emailLabelPicker
                    if pendingAdd != nil {
                        enterCodeButton
                        cancelCodeButton
                    } else {
                        sendCodeButton
                    }
                } header: {
                    Text("Verified email")
                } footer: {
                    Text(footerText)
                }
            }
            .navigationTitle("Add a person")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let doneAction = { dismiss() }
                    Button("Done", action: doneAction)
                }
            }
            .sheet(isPresented: $showingCodeEntry) {
                VerifyCodeSheet(
                    pendingAdd: $pendingAdd,
                    onVerified: { member in
                        showingCodeEntry = false
                        onAdded(member)
                    },
                    onTooManyAttempts: {
                        showingCodeEntry = false
                        onTooManyAttempts()
                    }
                )
            }
        }
    }

    private var firstNameField: some View {
        TextField("First name", text: $firstName)
            .textContentType(.givenName)
            .disabled(pendingAdd != nil)
    }

    private var middleNameField: some View {
        TextField("Middle name", text: $middleName)
            .textContentType(.middleName)
            .disabled(pendingAdd != nil)
    }

    private var lastNameField: some View {
        TextField("Last name", text: $lastName)
            .textContentType(.familyName)
            .disabled(pendingAdd != nil)
    }

    private var emailField: some View {
        TextField("Email", text: $email)
            .textContentType(.emailAddress)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .disabled(pendingAdd != nil)
    }

    private var emailLabelPicker: some View {
        Picker("Label", selection: $emailLabel) {
            ForEach(EmailLabel.allCases) { label in
                Text(label.displayName).tag(label)
            }
        }
        .disabled(pendingAdd != nil)
    }

    private var sendCodeButton: some View {
        let trimmedEmail: String = email.trimmingCharacters(in: .whitespaces)
        let canSend: Bool = !trimmedEmail.isEmpty
        let sendAction = {
            guard canSend else { return }
            // Real email send is a stub until the mailer ships; the
            // verify sheet trusts the static `EmailCodeVerification`
            // code so QA + early testers can complete the flow.
            pendingAdd = PendingAdd(
                firstName: firstName.trimmingCharacters(in: .whitespaces),
                middleName: middleName.trimmingCharacters(in: .whitespaces),
                lastName: lastName.trimmingCharacters(in: .whitespaces),
                email: trimmedEmail,
                emailLabel: emailLabel
            )
            showingCodeEntry = true
        }
        return Button(action: sendAction) {
            HStack {
                Spacer()
                Text("Send verification code")
                    .font(.body.weight(.semibold))
                Spacer()
            }
        }
        .disabled(!canSend)
    }

    private var enterCodeButton: some View {
        let reopenAction = { showingCodeEntry = true }
        return Button(action: reopenAction) {
            HStack {
                Spacer()
                Text("Enter code")
                    .font(.body.weight(.semibold))
                Spacer()
            }
        }
    }

    private var cancelCodeButton: some View {
        let cancelAction = { pendingAdd = nil }
        return Button(role: .destructive, action: cancelAction) {
            HStack {
                Spacer()
                Text("Cancel code")
                Spacer()
            }
        }
    }

    private var footerText: String {
        if let pending = pendingAdd {
            return "We sent a 6-digit code to \(pending.email). Tap Enter code to verify."
        }
        return "We'll email a 6-digit code so you can confirm this person before adding them to your plan."
    }
}

/// Compact modal for the code entry itself. Big centered monospaced
/// field, auto-submits the instant the user enters the sixth digit:
///   * Correct → calls `onVerified` with the new `SeatMember`.
///   * Wrong, with tries remaining → shows a "didn't match — N tries
///     left" alert and clears the field; the sheet stays open.
///   * Wrong, last try → calls `onTooManyAttempts`.
///
/// The caller's parent ("MembershipView") owns the success / too-many
/// alerts so they appear after this sheet (and the Add Person sheet
/// behind it) dismiss.
private struct VerifyCodeSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction

    @Binding var pendingAdd: PendingAdd?
    let onVerified: (SeatMember) -> Void
    let onTooManyAttempts: () -> Void

    @State private var alertMessage: String?
    @State private var showingAlert: Bool = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            verifyBody
                .navigationTitle("Verify person")
                .toolbarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        let cancelAction = { dismiss() }
                        Button("Cancel", action: cancelAction)
                    }
                }
                .alert("Verification", isPresented: $showingAlert) {
                    Button("OK", role: .cancel) { codeFocused = true }
                } message: {
                    Text(alertMessage ?? "")
                }
                .onAppear { codeFocused = true }
        }
        .presentationDetents([.fraction(0.4), .medium])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var verifyBody: some View {
        if let pending = pendingAdd {
            VStack(alignment: .center, spacing: DesignConstants.Spacing.step2x) {
                Text("Enter the 6-digit code we emailed to")
                    .font(.subheadline)
                    .foregroundStyle(.colorTextSecondary)
                Text(pending.email)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.colorTextPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.bottom, DesignConstants.Spacing.step2x)
                codeField
                Spacer()
            }
            .frame(maxWidth: .infinity)
            .padding(DesignConstants.Spacing.step4x)
        } else {
            Color.clear
        }
    }

    private var codeField: some View {
        TextField("", text: codeBinding, prompt: Text("000000").foregroundColor(.colorTextTertiary))
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
            .multilineTextAlignment(.center)
            .tracking(12)
            .foregroundStyle(.colorTextPrimary)
            .focused($codeFocused)
            .padding(.vertical, DesignConstants.Spacing.step3x)
    }

    private var codeBinding: Binding<String> {
        Binding(
            get: { pendingAdd?.code ?? "" },
            set: { newValue in
                let digitsOnly: String = String(newValue.filter { $0.isNumber }.prefix(EmailCodeVerification.codeLength))
                pendingAdd?.code = digitsOnly
                if digitsOnly.count == EmailCodeVerification.codeLength {
                    // Mutating @State during a Binding setter mid-render
                    // is undefined; queue verify on the next tick so the
                    // field commits the sixth digit first.
                    Task { @MainActor in verifyCode() }
                }
            }
        )
    }

    private func verifyCode() {
        guard var pending = pendingAdd else { return }
        if EmailCodeVerification.isValid(pending.code) {
            let verifiedEmail: LabeledEmail = LabeledEmail(
                address: pending.email,
                label: pending.emailLabel,
                verified: true
            )
            let member: SeatMember = SeatMember(
                firstName: pending.firstName,
                middleName: pending.middleName,
                lastName: pending.lastName,
                emails: [verifiedEmail]
            )
            onVerified(member)
            return
        }
        pending.attemptsLeft -= 1
        pending.code = ""
        if pending.attemptsLeft <= 0 {
            onTooManyAttempts()
            return
        }
        pendingAdd = pending
        let triesLeft: Int = pending.attemptsLeft
        let triesLabel: String = triesLeft == 1 ? "1 try left" : "\(triesLeft) tries left"
        alertMessage = "That code didn't match — \(triesLabel)."
        showingAlert = true
    }
}

/// In-flight Add Person flow: the user filled in the form and tapped
/// "Send code", but hasn't entered a valid 6-digit code yet. Held in
/// `MembershipView` state so the user can dismiss the verify sheet
/// (swipe down) and resume later without losing progress. Only one
/// email is required at this stage — additional emails can be added
/// (and verified one-by-one) later from `MemberEditSheet`.
private struct PendingAdd: Equatable {
    var firstName: String
    var middleName: String
    var lastName: String
    var email: String
    var emailLabel: EmailLabel
    var code: String = ""
    /// How many wrong codes the user has left before the in-flight add
    /// is dropped and they have to request a fresh code.
    var attemptsLeft: Int = EmailCodeVerification.maxAttempts
}

/// Static 6-digit code used by the dev / QA Add Person flow until the
/// real email send is wired up. Centralised here so the field validator
/// and the verifier agree on the length, the accepted value, and the
/// per-code attempt cap.
private enum EmailCodeVerification {
    static let codeLength: Int = 6
    static let acceptedCode: String = "555555"
    /// Attempts allowed per issued code before the in-flight add is
    /// dropped — matches the rate-limiting that the real email flow
    /// will enforce on the backend.
    static let maxAttempts: Int = 3

    static func isValid(_ code: String) -> Bool {
        code == acceptedCode
    }
}

#Preview {
    NavigationStack {
        MembershipView(session: MockInboxesService())
    }
}
