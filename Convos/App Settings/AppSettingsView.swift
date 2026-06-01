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
                Image(BrandConfig.shared.assets.logoImageName)
                    .resizable()
                    .renderingMode(.template)
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(.colorFillPrimary)
                    .frame(width: 24.0, height: 24.0)
                    .accessibilityHidden(true)

                Text(BrandConfig.shared.brand.name)
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
        let emerald: Bool = GoldilocksSession.shared.identity?.emeraldMembershipEnabled ?? false
        return GoldilocksMembershipTier(
            activeMembers: GoldilocksSeatPlan.shared.billableSeatCount,
            hasActiveCoverage: GoldilocksSeatPlan.shared.coverageActive,
            emeraldEnabled: emerald
        ).displayName
    }

    @ViewBuilder
    private var membershipAndInvoicesSection: some View {
        Section {
            NavigationLink {
                MembershipView(session: session)
            } label: {
                HStack(spacing: DesignConstants.Spacing.step2x) {
                    Image(systemName: "creditcard.fill")
                        .foregroundStyle(.colorTextPrimary)
                        .frame(width: Constant.settingsIconWidth, alignment: .center)
                    Text("Membership")
                        .foregroundStyle(.colorTextPrimary)
                    Spacer()
                    Text(currentTierLabel)
                        .foregroundStyle(.colorTextSecondary)
                }
            }
            .listRowInsets(.init(top: 0, leading: DesignConstants.Spacing.step4x, bottom: 0, trailing: 10.0))
        } footer: {
            Text("Your \(BrandConfig.shared.brand.name) plan")
        }
    }

    @ViewBuilder
    private var myInfoAndContactsSection: some View {
        Section {
            NavigationLink {
                myInfoDestination
            } label: {
                HStack(spacing: DesignConstants.Spacing.step2x) {
                    Image(systemName: "lanyardcard.fill")
                        .foregroundStyle(.colorTextPrimary)
                        .frame(width: Constant.settingsIconWidth, alignment: .center)
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

            NavigationLink {
                let messagingService = session.messagingService()
                ContactsView(
                    contactsRepository: messagingService.contactsRepository(),
                    contactsWriter: messagingService.contactsWriter(),
                    session: session
                )
            } label: {
                HStack(spacing: DesignConstants.Spacing.step2x) {
                    Image(systemName: "person.crop.circle")
                        .foregroundStyle(.colorTextPrimary)
                        .frame(width: Constant.settingsIconWidth, alignment: .center)
                    Text("Contacts")
                        .foregroundStyle(.colorTextPrimary)
                    Spacer()
                }
            }
            .accessibilityIdentifier("contacts-row")
        } footer: {
            Text("Private unless you choose to share")
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
                        Text(BrandConfig.shared.brand.name)
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
                    .alert("\(BrandConfig.shared.brand.name) Role", isPresented: $showingUpgradeResult, presenting: upgradeResultMessage) { _ in
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

                membershipAndInvoicesSection

                myInfoAndContactsSection

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
                            Text(BrandConfig.shared.brand.footerCredit)
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
        static let settingsIconWidth: CGFloat = 24.0
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
    @State private var verifyResultMessage: String?
    @State private var showingVerifyResult: Bool = false
    @State private var billingResultMessage: String?
    @State private var showingBillingResult: Bool = false
    @State private var showingCancelConfirm: Bool = false
    @State private var paymentMethod: GoldilocksPaymentMethod = .apple
    @State private var billingStatus: ConvosAPI.GoldilocksBillingStatusResponse?
    @State private var isStartingCheckout: Bool = false
    @State private var isCancelling: Bool = false
    @State private var checkoutSessionId: String?
    @State private var reconcileTask: Task<Void, Never>?
    @State private var depositAmount: Int = 100
    @State private var pendingActivation: SeatMember?
    @State private var showingActivationConfirm: Bool = false
    @State private var showingBillingInfo: Bool = false
    @State private var showingReactivationConfirm: Bool = false
    @State private var activatedPersonIds: Set<UUID> = []

    var body: some View {
        listContent
            .onChange(of: scenePhase) { _, newPhase in
                guard newPhase == .active, checkoutSessionId != nil else { return }
                Task { await reconcileCheckout() }
            }
            .onChange(of: plan.members) { _, _ in
                Task { await savePeopleList() }
            }
            .task {
                await plan.loadFromBackend(session: session)
                activatedPersonIds = Set(plan.members.filter { $0.enabled }.map(\.id))
                await syncSeats()
                await GoldilocksStore.shared.loadProducts()
            }
    }

    private var listContent: some View {
        List {
            peopleSection
            balanceSection
            paymentSection
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
            PersonEditorSheet(
                mode: .edit(member),
                onSave: { updated in
                    guard let index = plan.members.firstIndex(where: { $0.id == updated.id }) else { return }
                    plan.members[index] = updated
                },
                onRemove: {
                    let label: String = member.displayName
                    plan.members.removeAll { $0.id == member.id }
                    showVerifyResult("Removed \(label) from your plan.")
                }
            )
        }
        .sheet(isPresented: $showingAddPerson) {
            PersonEditorSheet(
                mode: .add,
                onSave: { newMember in
                    plan.members.append(newMember)
                    showVerifyResult("\(newMember.displayName) was added to your plan.")
                }
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
        .alert("Activate coverage?", isPresented: $showingActivationConfirm) {
            let confirmAction: () -> Void = {
                guard let member = pendingActivation else { return }
                Task { await confirmActivation(member) }
            }
            Button("Activate", action: confirmAction)
            Button("Cancel", role: .cancel) { pendingActivation = nil }
        } message: {
            Text("$\(GoldilocksPlan.monthlyPricePerPerson)/mo will be deducted from your balance.")
        }
        .alert("Re-activate coverage?", isPresented: $showingReactivationConfirm) {
            let confirmAction: () -> Void = {
                guard let member = pendingActivation else { return }
                Task { await confirmActivation(member) }
            }
            Button("Re-activate", action: confirmAction)
            Button("Cancel", role: .cancel) { pendingActivation = nil }
        } message: {
            Text("This person will be re-added to your membership.")
        }
        .alert("Request refund?", isPresented: $showingCancelConfirm) {
            Button("Keep balance", role: .cancel) {}
            let confirmAction: () -> Void = { Task { await cancelCoverage() } }
            Button("Refund balance", role: .destructive, action: confirmAction)
        } message: {
            Text(cancelConfirmMessage)
        }
        .alert("Billing", isPresented: $showingBillingInfo) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(billingInfoMessage)
        }
    }

    /// True when the admin has flipped this client's Emerald flag on.
    /// Emerald clients get the Emerald tier badge regardless of seats /
    /// coverage, can't buy more coverage (it's granted), and can open
    /// the Invoices section (which is "Coming soon" for everyone else).
    private var isEmerald: Bool {
        GoldilocksSession.shared.identity?.emeraldMembershipEnabled ?? false
    }

    private var tierRow: some View {
        let tier: GoldilocksMembershipTier = GoldilocksMembershipTier(
            activeMembers: plan.billableSeatCount,
            hasActiveCoverage: plan.coverageActive,
            emeraldEnabled: isEmerald
        )
        return HStack(spacing: DesignConstants.Spacing.step2x) {
            Image(systemName: tier.iconName)
                .foregroundStyle(tier.accentColor)
            Text("\(tier.displayName) member")
                .font(.body.weight(.semibold))
                .foregroundStyle(.colorTextPrimary)
            Spacer()
        }
        .listRowBackground(tier.tintColor)
    }

    private var balanceSection: some View {
        Section {
            balanceRow
            nextChargeRow
        } header: {
            Text("Account")
        }
    }

    private var paymentSection: some View {
        Section {
            paymentMethodPicker
            depositAmountRow
            checkoutButton
        } header: {
            Text("Payments")
        }
    }

    private var balanceRow: some View {
        let balance: Int = billingStatus?.balanceCents ?? 0
        let balanceLabel: String = {
            if balance > 0 { return "$\(balance / 100)" }
            if balance < 0 { return "-$\(abs(balance) / 100)" }
            return "$0"
        }()
        let tapAction = { showingCancelConfirm = true }
        return Button(action: tapAction) {
            HStack {
                Text("Balance")
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
                Text(balanceLabel)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.colorTextPrimary)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.colorTextTertiary)
            }
        }
        .buttonStyle(.plain)
    }

    private var nextChargeRow: some View {
        let tapAction = { showingBillingInfo = true }
        return Button(action: tapAction) {
            HStack {
                Text("Billing")
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
                Text(nextChargeLabel)
                    .foregroundStyle(.colorTextSecondary)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.colorTextTertiary)
            }
        }
        .buttonStyle(.plain)
    }

    private var nextChargeLabel: String {
        let chargeDollars: Int = plan.billableSeatCount * GoldilocksPlan.monthlyPricePerPerson
        let now = Date()
        let calendar = Calendar.current
        let nextMonth: Date = calendar.date(byAdding: .month, value: 1, to: now) ?? now
        let components: DateComponents = calendar.dateComponents([.year, .month], from: nextMonth)
        guard let firstOfNextMonth = calendar.date(from: components) else {
            return "$\(chargeDollars)"
        }
        guard let chargeDate = calendar.date(byAdding: .day, value: -3, to: firstOfNextMonth) else {
            return "$\(chargeDollars)"
        }
        let displayDate: Date = chargeDate <= now
            ? calendar.date(byAdding: .month, value: 1, to: chargeDate) ?? chargeDate
            : chargeDate
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        let dateString: String = formatter.string(from: displayDate)
        return "\(dateString) · $\(chargeDollars)"
    }

    private var peoplePicker: some View {
        HStack {
            Text("People")
                .foregroundStyle(.colorTextPrimary)
            Spacer()
            let minusAction = { if checkoutPeople > 1 { checkoutPeople -= 1 } }
            Button(action: minusAction) {
                Image(systemName: "minus.circle.fill")
                    .foregroundStyle(checkoutPeople > 1 ? .colorFillPrimary : .colorTextTertiary)
            }
            .buttonStyle(.plain)
            .disabled(checkoutPeople <= 1)
            Text("\(checkoutPeople)")
                .font(.body.weight(.semibold))
                .foregroundStyle(.colorTextPrimary)
                .frame(minWidth: 28)
            let plusAction = { checkoutPeople += 1 }
            Button(action: plusAction) {
                Image(systemName: "plus.circle.fill")
                    .foregroundStyle(.colorFillPrimary)
            }
            .buttonStyle(.plain)
        }
    }

    private var paymentMethodPicker: some View {
        Picker("Payment method", selection: $paymentMethod) {
            ForEach(GoldilocksPaymentMethod.allCases, id: \.self) { method in
                if method == .apple {
                    Image(systemName: "apple.logo").tag(method)
                } else {
                    Text(method.displayName).tag(method)
                }
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

    private var chargeTotal: Int {
        checkoutPeople * GoldilocksPlan.monthlyPricePerPerson * prepaidDuration.months
    }

    private var checkoutButtonLabel: String {
        if paymentMethod == .crypto {
            return "Coming Soon"
        }
        return "Deposit $\(chargeTotal)"
    }

    private var canStartCheckout: Bool {
        switch paymentMethod {
        case .apple, .card:
            return checkoutPeople > 0
        case .crypto:
            return false
        }
    }

    private var billingInfoMessage: String {
        let now = Date()
        let calendar = Calendar.current
        let nextMonth: Date = calendar.date(byAdding: .month, value: 1, to: now) ?? now
        let components: DateComponents = calendar.dateComponents([.year, .month], from: nextMonth)
        guard let firstOfNextMonth = calendar.date(from: components),
              let cutoff = calendar.date(byAdding: .day, value: -3, to: firstOfNextMonth) else {
            return "Disable people in your membership before the billing date to avoid being charged."
        }
        let displayDate: Date = cutoff <= now
            ? calendar.date(byAdding: .month, value: 1, to: cutoff) ?? cutoff
            : cutoff
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM d"
        let dateString: String = formatter.string(from: displayDate)
        return "Disable people in your membership before \(dateString) to not be charged."
    }

    private var cancelConfirmMessage: String {
        "Coverage will not be renewed and your balance will be returned to your payment method."
    }

    @ViewBuilder
    private var peopleSection: some View {
        Section {
            tierRow
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
            Text("\(GoldilocksPlan.priceLabel). Toggle a person on to start coverage. Tap to edit, swipe to remove.")
        }
    }

    /// Bottom row of the People section — tapping opens the Add Person
    /// sheet. In-flight verification state lives inside the sheet
    /// itself now, so there's nothing parent-side to resume; the row
    /// is a simple "Add someone" affordance.
    private var addSomeoneRow: some View {
        let tapAction = { showingAddPerson = true }
        return Button(action: tapAction) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: "plus.circle.fill")
                    .foregroundStyle(.colorFillPrimary)
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                    Text("Add someone")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.colorTextPrimary)
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

    private func memberRow(_ member: SeatMember) -> some View {
        let rowLabel: String = member.firstName.isEmpty ? member.displayName : member.firstName
        let tapAction = { editingMember = member }
        return HStack(spacing: DesignConstants.Spacing.step2x) {
            Button(action: tapAction) {
                HStack(spacing: DesignConstants.Spacing.step2x) {
                    VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                        Text(rowLabel)
                            .font(.body)
                            .foregroundStyle(.colorTextPrimary)
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            memberToggle(for: member)
        }
    }

    private func memberToggle(for member: SeatMember) -> some View {
        let binding = Binding<Bool>(
            get: { member.enabled },
            set: { newValue in
                if newValue {
                    pendingActivation = member
                    if activatedPersonIds.contains(member.id) {
                        showingReactivationConfirm = true
                    } else {
                        showingActivationConfirm = true
                    }
                } else {
                    Task { await togglePerson(member, enabled: false) }
                }
            }
        )
        return Toggle("", isOn: binding)
            .labelsHidden()
    }

    private func confirmActivation(_ member: SeatMember) async {
        pendingActivation = nil
        await togglePerson(member, enabled: true)
    }

    private func togglePerson(_ member: SeatMember, enabled: Bool) async {
        do {
            let response = try await session.toggleGoldilocksPersonCoverage(
                personId: member.id.uuidString,
                displayName: member.displayName,
                enabled: enabled
            )
            guard let index = plan.members.firstIndex(where: { $0.id == member.id }) else { return }
            plan.members[index].enabled = enabled
            if enabled { activatedPersonIds.insert(member.id) }
            billingStatus = ConvosAPI.GoldilocksBillingStatusResponse(
                activeUntil: response.activeUntil,
                coverageActive: response.coverageActive,
                coverageEnabled: response.coverageEnabled,
                balanceCents: response.balanceCents,
                monthlyRateCents: response.monthlyRateCents,
                seats: response.seats,
                coveredPeople: response.coveredPeople,
                reportDay: response.reportDay
            )
            cacheCoverageActive()
            if response.activated, response.deductedCents > 0 {
                let dollars: Int = response.deductedCents / 100
                showBillingResult("Coverage activated for \(member.displayName). $\(dollars) deducted.")
            }
        } catch let apiError as APIError {
            showBillingResult("Not enough balance to activate.")
        } catch {
            showBillingResult(error.localizedDescription)
        }
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

    private func cacheCoverageActive() {
        plan.coverageActive = billingStatus?.coverageActive ?? false
    }

    /// Persist a people-list edit — push the encrypted list to the backend,
    /// then re-sync the billing seat counts.
    private func savePeopleList() async {
        await plan.saveToBackend(session: session)
        await syncSeats()
    }

    /// Start the checkout flow for the selected payment method. Card
    /// opens a Stripe-hosted session in the browser; Apple triggers a
    /// native StoreKit2 purchase sheet.
    private func startCheckout() async {
        switch paymentMethod {
        case .apple:
            await startAppleCheckout()
        case .card:
            await startStripeCheckout()
        case .crypto:
            break
        }
    }

    private func startStripeCheckout() async {
        isStartingCheckout = true
        do {
            let response = try await session.createGoldilocksCheckout(
                paymentMethod: paymentMethod,
                durationMonths: prepaidDuration.months,
                seats: checkoutPeople
            )
            if let url = URL(string: response.checkoutUrl) {
                checkoutSessionId = response.sessionId
                openURL(url)
                startReconcilePolling(sessionId: response.sessionId)
            } else {
                showBillingResult("Couldn't open the checkout page.")
            }
        } catch {
            showBillingResult("Couldn't start checkout: \(error.localizedDescription)")
        }
        isStartingCheckout = false
    }

    private func startAppleCheckout() async {
        isStartingCheckout = true
        let store: GoldilocksStore = GoldilocksStore.shared
        let success: Bool = await store.purchase(
            duration: prepaidDuration,
            seats: checkoutPeople,
            session: session
        )
        if success {
            await syncSeats()
            showBillingResult("Your coverage is active.")
        } else if let error = store.lastError {
            showBillingResult(error)
        }
        store.resetState()
        isStartingCheckout = false
    }

    private func reconcileCheckout() async {
        guard let sessionId = checkoutSessionId else { return }
        do {
            let status = try await session.reconcileGoldilocksCheckout(sessionId: sessionId)
            billingStatus = status
            cacheCoverageActive()
            if status.balanceCents > 0 {
                checkoutSessionId = nil
                reconcileTask?.cancel()
                reconcileTask = nil
                showBillingResult("Your coverage is active.")
            }
        } catch {
            Log.warning("[Goldilocks] Checkout reconcile failed: \(error.localizedDescription)")
        }
    }

    private func startReconcilePolling(sessionId: String) {
        reconcileTask?.cancel()
        reconcileTask = Task {
            for attempt in 0..<10 {
                let delay: UInt64 = attempt < 3 ? 3_000_000_000 : 5_000_000_000
                try? await Task.sleep(nanoseconds: delay)
                guard !Task.isCancelled, checkoutSessionId != nil else { return }
                await reconcileCheckout()
                if checkoutSessionId == nil { return }
            }
        }
    }

    /// Stop coverage and refund the unused balance to the card.
    private func cancelCoverage() async {
        isCancelling = true
        do {
            let result = try await session.cancelGoldilocksBilling()
            billingStatus = try await session.fetchGoldilocksBillingStatus()
            cacheCoverageActive()
            let refundDollars: Int = result.refundedCents / 100
            if refundDollars > 0 {
                showBillingResult("Coverage cancelled. $\(refundDollars) refunded to your card.")
            } else {
                showBillingResult("Coverage cancelled. No refund, the current month is non-refundable.")
            }
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

/// Unified Add / Edit sheet for one person on the plan. Same UX for
/// both flows — the only difference is the title, the destructive
/// "Remove" section (edit only), and what gets done on Save. Email
/// addresses are managed as a per-row list with inline verification:
/// the user types one or more addresses, taps "Send verification
/// codes" to dispatch codes for every unverified row at once, then
/// types each 6-digit code into its row's inline field. Auto-focus
/// hops to the next pending row as each one verifies. At least one
/// verified email is required before Save is enabled — the person's
/// identity on the plan is the set of verified email addresses.
private struct PersonEditorSheet: View {
    enum Mode {
        case add
        case edit(SeatMember)
    }

    @Environment(\.dismiss) private var dismiss: DismissAction

    let mode: Mode
    let onSave: (SeatMember) -> Void
    let onRemove: (() -> Void)?

    @State private var firstName: String
    @State private var middleName: String
    @State private var lastName: String
    @State private var phone: String
    @State private var address: PersonAddress
    @State private var emails: [EditableEmail]
    @State private var showingRemoveConfirm: Bool = false
    @State private var verifyingEmailID: UUID?
    @State private var verificationCode: String = ""
    @State private var verificationError: String?
    @State private var resendCooldown: Int = 0

    private let originalMember: SeatMember?

    init(
        mode: Mode,
        onSave: @escaping (SeatMember) -> Void,
        onRemove: (() -> Void)? = nil
    ) {
        self.mode = mode
        self.onSave = onSave
        self.onRemove = onRemove
        switch mode {
        case .add:
            self.originalMember = nil
            self._firstName = State(initialValue: "")
            self._middleName = State(initialValue: "")
            self._lastName = State(initialValue: "")
            self._phone = State(initialValue: "")
            self._address = State(initialValue: PersonAddress())
            // Start with one draft row so the user sees the email
            // section immediately without having to tap "Add email".
            self._emails = State(initialValue: [EditableEmail.draft()])
        case .edit(let member):
            self.originalMember = member
            self._firstName = State(initialValue: member.firstName)
            self._middleName = State(initialValue: member.middleName)
            self._lastName = State(initialValue: member.lastName)
            self._phone = State(initialValue: member.phone)
            self._address = State(initialValue: member.address)
            self._emails = State(initialValue: member.emails.map(EditableEmail.fromLabeled))
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                nameSection
                emailsSection
                phoneSection
                addressSection
                if onRemove != nil { removeSection }
            }
            .navigationTitle(title)
            .toolbarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .confirmationDialog(
                removeConfirmTitle,
                isPresented: $showingRemoveConfirm,
                titleVisibility: .visible
            ) {
                let removeAction = {
                    onRemove?()
                    dismiss()
                }
                Button("Remove", role: .destructive, action: removeAction)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("They'll stop counting toward your coverage and be unsubscribed from the service.")
            }
            .alert("Enter verification code", isPresented: showingVerificationAlert) {
                TextField("000000", text: $verificationCode)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .onChange(of: verificationCode) { _, newValue in
                        let digits: String = String(newValue.filter { $0.isNumber }.prefix(EmailCodeVerification.codeLength))
                        verificationCode = digits
                    }
                Button("Verify", action: submitVerificationCode)
                    .disabled(verificationCode.count < EmailCodeVerification.codeLength)
                if resendCooldown > 0 {
                    Button("Resend (\(resendCooldown)s)", role: .cancel) {}
                        .disabled(true)
                } else {
                    Button("Resend", action: resendCode)
                }
                Button("Cancel", role: .cancel, action: cancelVerification)
            } message: {
                if let error = verificationError {
                    Text(error)
                } else {
                    let emailAddress: String = verifyingEmail?.address ?? ""
                    Text("A 6-digit code was sent to \(emailAddress).")
                }
            }
        }
    }

    private var showingVerificationAlert: Binding<Bool> {
        Binding(
            get: { verifyingEmailID != nil },
            set: { showing in
                if !showing { cancelVerification() }
            }
        )
    }

    private var verifyingEmail: EditableEmail? {
        guard let id = verifyingEmailID else { return nil }
        return emails.first(where: { $0.id == id })
    }

    private var title: String {
        switch mode {
        case .add: return "Add a person"
        case .edit: return "Edit person"
        }
    }

    private var saveButtonTitle: String {
        switch mode {
        case .add: return "Add"
        case .edit: return "Save"
        }
    }

    private var removeConfirmTitle: String {
        let label: String = originalMember?.displayName ?? "this person"
        return "Remove \(label) from your plan?"
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            let cancelAction = { dismiss() }
            Button("Cancel", action: cancelAction)
        }
        ToolbarItem(placement: .confirmationAction) {
            let saveAction = {
                onSave(assembledMember)
                dismiss()
            }
            Button(saveButtonTitle, action: saveAction)
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
        } footer: {
            Text("Name fields are optional — the person is identified by their verified emails.")
        }
    }

    private var emailsSection: some View {
        Section {
            ForEach($emails) { $email in
                emailRow(email: $email)
            }
            .onDelete(perform: deleteEmails)
            addEmailButton
            if validUnsentCount > 0 { sendCodesButton }
        } header: {
            Text("Emails")
        } footer: {
            Text(emailsFooterText)
        }
    }

    @ViewBuilder
    private func emailRow(email: Binding<EditableEmail>) -> some View {
        switch email.wrappedValue.status {
        case .draft:
            draftRow(email: email)
        case .awaiting:
            awaitingRow(email: email)
        case .verified:
            verifiedRow(email: email.wrappedValue)
        case .exhausted:
            exhaustedRow(email: email)
        }
    }

    private func draftRow(email: Binding<EditableEmail>) -> some View {
        TextField("Email", text: email.address)
            .textContentType(.emailAddress)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }

    private func awaitingRow(email: Binding<EditableEmail>) -> some View {
        let tapAction = { openVerificationDialog(for: email.wrappedValue.id) }
        return Button(action: tapAction) {
            HStack {
                Text(email.wrappedValue.address)
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
                Text("Enter code")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.colorFillPrimary)
            }
        }
        .buttonStyle(.plain)
    }

    private func verifiedRow(email: EditableEmail) -> some View {
        HStack {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Text(email.address)
                .foregroundStyle(.colorTextPrimary)
            Spacer()
            Text("Verified")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.colorTextSecondary)
        }
    }

    private func exhaustedRow(email: Binding<EditableEmail>) -> some View {
        let tapAction = {
            email.wrappedValue.status = .awaiting
            email.wrappedValue.code = ""
            email.wrappedValue.attemptsLeft = EmailCodeVerification.maxAttempts
            openVerificationDialog(for: email.wrappedValue.id)
        }
        return Button(action: tapAction) {
            HStack {
                Text(email.wrappedValue.address)
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
                Text("Resend code")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.red)
            }
        }
        .buttonStyle(.plain)
    }

    private var addEmailButton: some View {
        let tapAction = {
            emails.append(EditableEmail.draft())
        }
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

    private var sendCodesButton: some View {
        let count: Int = validUnsentCount
        let buttonLabel: String = count == 1
            ? "Send verification code"
            : "Send \(count) verification codes"
        return Button(action: sendVerificationCodes) {
            HStack {
                Spacer()
                Text(buttonLabel)
                    .font(.body.weight(.semibold))
                Spacer()
            }
        }
        .disabled(count == 0)
    }

    private var phoneSection: some View {
        Section {
            TextField("Phone", text: $phone)
                .textContentType(.telephoneNumber)
                .keyboardType(.phonePad)
        } header: {
            Text("Phone (optional)")
        }
    }

    private var addressSection: some View {
        Section {
            TextField("Street", text: $address.street)
                .textContentType(.fullStreetAddress)
            TextField("City", text: $address.city)
                .textContentType(.addressCity)
            TextField("State / Region", text: $address.state)
                .textContentType(.addressState)
            TextField("Postal code", text: $address.postalCode)
                .textContentType(.postalCode)
            TextField("Country", text: $address.country)
                .textContentType(.countryName)
        } header: {
            Text("Address (optional)")
        } footer: {
            Text("Phone and address are optional and can be edited later.")
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

    // MARK: - Helpers

    private var emailsFooterText: String {
        if emails.contains(where: { $0.status == .verified }) {
            return "Every email is verified before it's saved. At least one verified email is required."
        }
        return "Add one or more emails, then tap Send verification codes to receive a 6-digit code for each."
    }

    private var validUnsentCount: Int {
        emails.filter { $0.status == .draft && isValidEmailAddress($0.address) }.count
    }

    private var canSave: Bool {
        guard emails.contains(where: { $0.status == .verified }) else { return false }
        guard let original = originalMember else { return true }
        return assembledMember != original
    }

    /// The SeatMember that would be persisted if Save was tapped now.
    /// Unverified rows are dropped. Free-form fields are trimmed so a
    /// stray space isn't mistaken for a real edit.
    private var assembledMember: SeatMember {
        let trimmedAddress: PersonAddress = PersonAddress(
            street: address.street.trimmingCharacters(in: .whitespaces),
            city: address.city.trimmingCharacters(in: .whitespaces),
            state: address.state.trimmingCharacters(in: .whitespaces),
            postalCode: address.postalCode.trimmingCharacters(in: .whitespaces),
            country: address.country.trimmingCharacters(in: .whitespaces)
        )
        let verifiedEmails: [LabeledEmail] = emails.compactMap { $0.toLabeled }
        var member: SeatMember = originalMember ?? SeatMember()
        member.firstName = firstName.trimmingCharacters(in: .whitespaces)
        member.middleName = middleName.trimmingCharacters(in: .whitespaces)
        member.lastName = lastName.trimmingCharacters(in: .whitespaces)
        member.emails = verifiedEmails
        member.phone = phone.trimmingCharacters(in: .whitespaces)
        member.address = trimmedAddress
        return member
    }

    private func sendVerificationCodes() {
        var firstSentID: UUID?
        for index in emails.indices where emails[index].status == .draft {
            let trimmed: String = emails[index].address.trimmingCharacters(in: .whitespaces)
            guard isValidEmailAddress(trimmed) else { continue }
            emails[index].address = trimmed
            emails[index].status = .awaiting
            emails[index].code = ""
            emails[index].attemptsLeft = EmailCodeVerification.maxAttempts
            if firstSentID == nil { firstSentID = emails[index].id }
        }
        if let first = firstSentID {
            openVerificationDialog(for: first)
        }
    }

    private func openVerificationDialog(for emailID: UUID) {
        verifyingEmailID = emailID
        verificationCode = ""
        verificationError = nil
        startResendCooldown()
    }

    private func submitVerificationCode() {
        guard let id = verifyingEmailID,
              let index = emails.firstIndex(where: { $0.id == id }) else { return }
        if EmailCodeVerification.isValid(verificationCode) {
            emails[index].status = .verified
            emails[index].code = ""
            verifyingEmailID = nil
            verificationCode = ""
            verificationError = nil
            // Auto-open the next awaiting email if any.
            if let next = emails.first(where: { $0.status == .awaiting }) {
                openVerificationDialog(for: next.id)
            }
        } else {
            emails[index].attemptsLeft -= 1
            verificationCode = ""
            if emails[index].attemptsLeft <= 0 {
                emails[index].status = .exhausted
                verifyingEmailID = nil
                verificationError = nil
            } else {
                verificationError = "Wrong code. \(emails[index].attemptsLeft) attempts left."
            }
        }
    }

    private func resendCode() {
        guard let id = verifyingEmailID,
              let index = emails.firstIndex(where: { $0.id == id }) else { return }
        emails[index].attemptsLeft = EmailCodeVerification.maxAttempts
        emails[index].code = ""
        verificationCode = ""
        verificationError = nil
        startResendCooldown()
    }

    private func cancelVerification() {
        verifyingEmailID = nil
        verificationCode = ""
        verificationError = nil
    }

    private func startResendCooldown() {
        resendCooldown = 60
        Task { @MainActor in
            while resendCooldown > 0 {
                try? await Task.sleep(for: .seconds(1))
                resendCooldown -= 1
            }
        }
    }

    private func deleteEmails(at offsets: IndexSet) {
        emails.remove(atOffsets: offsets)
    }

    private func isValidEmailAddress(_ raw: String) -> Bool {
        let trimmed: String = raw.trimmingCharacters(in: .whitespaces)
        guard let at = trimmed.firstIndex(of: "@") else { return false }
        let local: Substring = trimmed[..<at]
        let domain: Substring = trimmed[trimmed.index(after: at)...]
        return !local.isEmpty && !domain.isEmpty && domain.contains(".")
    }
}

/// Per-row state for an email in the person editor. `LabeledEmail` is
/// the persisted shape; `EditableEmail` adds the transient
/// verification state — code typed so far, attempts remaining, what
/// stage the row is in — that exists only while the sheet is open.
private struct EditableEmail: Identifiable, Equatable {
    var id: UUID
    var address: String
    var status: Status
    var code: String
    var attemptsLeft: Int
    /// Preserved so an existing email loaded in edit mode round-trips
    /// without losing its on-disk label, even though we no longer
    /// surface labels in the UI.
    var label: EmailLabel

    enum Status: Equatable {
        case draft       // user is typing the address, no code sent yet
        case awaiting    // code dispatched, awaiting code entry
        case verified    // correct code entered
        case exhausted   // all attempts used, needs a resend
    }

    static func draft() -> EditableEmail {
        EditableEmail(
            id: UUID(),
            address: "",
            status: .draft,
            code: "",
            attemptsLeft: EmailCodeVerification.maxAttempts,
            label: .other
        )
    }

    static func fromLabeled(_ stored: LabeledEmail) -> EditableEmail {
        EditableEmail(
            id: stored.id,
            address: stored.address,
            status: stored.verified ? .verified : .draft,
            code: "",
            attemptsLeft: EmailCodeVerification.maxAttempts,
            label: stored.label
        )
    }

    var toLabeled: LabeledEmail? {
        guard status == .verified else { return nil }
        return LabeledEmail(id: id, address: address, label: label, verified: true)
    }
}

/// Static 6-digit code used by the dev / QA email-verification flow
/// in the person editor until the real email send is wired up.
/// Centralised here so the field validator and the verifier agree on
/// the length, the accepted value, and the per-code attempt cap.
private enum EmailCodeVerification {
    static let codeLength: Int = 6
    static let acceptedCode: String = "555555"
    /// Attempts allowed per issued code before that email's row is
    /// marked exhausted and needs a fresh code — matches the rate-
    /// limiting that the real email flow will enforce on the backend.
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

/// Emerald-tier clients' invoices destination. Pushed from the
/// Invoices row in `AppSettingsView`. Empty for now — billing for
/// Emerald hasn't been built yet; this is a placeholder so the row
/// is tappable and the structure is in place for when it lands.
struct InvoicesView: View {
    var body: some View {
        List {
            Section {
                Text("No invoices yet.")
                    .foregroundStyle(.colorTextSecondary)
            } footer: {
                Text("Emerald membership invoices will appear here.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(.colorBackgroundRaisedSecondary)
        .navigationTitle("Invoices")
        .toolbarTitleDisplayMode(.inline)
    }
}
