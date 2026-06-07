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
                    .renderingMode(.original)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 24.0, height: 24.0)
                    .accessibilityHidden(true)

                Text(BrandConfig.shared.brand.name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.brandLogoText)
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
    @State private var showingAppShareQR: Bool = false
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
                .listRowBackground(Color.colorFillMinimal)
            } footer: {
                Text("Share services with conversations")
                    .foregroundStyle(.colorTextSecondary)
            }
        }
    }

    private var settingsTier: GoldilocksMembershipTier {
        let emerald: Bool = GoldilocksSession.shared.identity?.emeraldMembershipEnabled ?? false
        return GoldilocksMembershipTier(
            activeMembers: GoldilocksSeatPlan.shared.billableSeatCount,
            hasActiveCoverage: GoldilocksSeatPlan.shared.coverageActive,
            emeraldEnabled: emerald
        )
    }

    @ViewBuilder
    private var membershipAndInvoicesSection: some View {
        let tier: GoldilocksMembershipTier = settingsTier
        Section {
            NavigationLink {
                MembershipView(session: session)
            } label: {
                HStack(spacing: DesignConstants.Spacing.step2x) {
                    Image(systemName: tier.iconName)
                        .foregroundStyle(tier.accentColor)
                        .frame(width: Constant.settingsIconWidth, alignment: .center)
                    Text("Membership")
                        .foregroundStyle(.colorTextPrimary)
                    Spacer()
                    Text(tier.displayName)
                        .foregroundStyle(.colorTextSecondary)
                }
            }
            .listRowInsets(.init(top: 0, leading: DesignConstants.Spacing.step4x, bottom: 0, trailing: 10.0))
        } footer: {
            Text("Your \(BrandConfig.shared.brand.name) plan")
                .foregroundStyle(.colorTextSecondary)
        }
        .listRowBackground(Color.colorFillMinimal)
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
                .foregroundStyle(.colorTextSecondary)
        }
        .listRowBackground(Color.colorFillMinimal)
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
                .listRowBackground(Color.colorFillMinimal)

                if GoldilocksSession.shared.isAdmin {
                    Section {
                        NavigationLink {
                            StatsView(session: session)
                        } label: {
                            Text("Stats")
                                .foregroundStyle(.colorTextPrimary)
                        }

                        NavigationLink {
                            DebugExportView(environment: ConfigManager.shared.currentEnvironment, session: session)
                        } label: {
                            Text("Debug")
                                .foregroundStyle(.colorTextPrimary)
                        }
                    }
                    .listRowSeparatorTint(.colorBorderSubtle)
                    .listRowBackground(Color.colorFillMinimal)
                }

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
                    .listRowBackground(Color.colorFillMinimal)
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

                ToolbarItem(placement: .topBarTrailing) {
                    let showShareQR = { showingAppShareQR = true }
                    Button(action: showShareQR) {
                        Image(systemName: "qrcode")
                    }
                    .accessibilityLabel("Share \(BrandConfig.shared.brand.name)")
                    .accessibilityIdentifier("settings-share-button")
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
            .sheet(isPresented: $showingAppShareQR) {
                AppShareQRSheet()
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
    @State private var paymentMethod: GoldilocksPaymentMethod = .card
    @State private var billingStatus: ConvosAPI.GoldilocksBillingStatusResponse?
    @State private var isStartingCheckout: Bool = false
    @State private var isCancelling: Bool = false
    @State private var checkoutSessionId: String?
    @State private var paymentMethodSessionId: String?
    @State private var isSettingUpPaymentMethod: Bool = false
    @State private var reconcileTask: Task<Void, Never>?
    @State private var prepaidDuration: GoldilocksPrepaidDuration = .oneMonth
    @State private var pendingActivation: SeatMember?
    @State private var showingActivationConfirm: Bool = false
    @State private var showingBillingInfo: Bool = false
    @State private var showingReactivationConfirm: Bool = false
    @State private var activatedPersonIds: Set<UUID> = []
    @State private var showingTierInfo: Bool = false
    @State private var showingNeedsPaymentMethod: Bool = false
    @State private var showingPaymentMethodOptions: Bool = false

    var body: some View {
        listContent
            .onChange(of: scenePhase) { _, newPhase in
                guard newPhase == .active else { return }
                if checkoutSessionId != nil {
                    Task { await reconcileCheckout() }
                }
                if paymentMethodSessionId != nil {
                    Task { await confirmPaymentMethod() }
                }
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
        listWithSheets
            .alert("Membership", isPresented: $showingVerifyResult) {
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
                Text(activationConfirmMessage)
            }
            .alert("Restart coverage?", isPresented: $showingReactivationConfirm) {
                let confirmAction: () -> Void = {
                    guard let member = pendingActivation else { return }
                    Task { await confirmActivation(member) }
                }
                Button("Restart", action: confirmAction)
                Button("Cancel", role: .cancel) { pendingActivation = nil }
            } message: {
                Text("This person will be added to your membership for no extra charge.")
            }
            .alert("Cancel coverage?", isPresented: $showingCancelConfirm) {
                Button("Keep coverage", role: .cancel) {}
                let confirmAction: () -> Void = { Task { await cancelCoverage() } }
                Button("Cancel coverage", role: .destructive, action: confirmAction)
            } message: {
                Text("Coverage stops at the end of the current period. The current period and initial report fees are non-refundable.")
            }
            .alert("Add a payment method", isPresented: $showingNeedsPaymentMethod) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Add a payment method before enabling someone.")
            }
            .alert("Billing", isPresented: $showingBillingInfo) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(billingInfoMessage)
            }
    }

    private var listWithSheets: some View {
        listBase
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
                        showVerifyResult("\(label) was removed from your membership.")
                    }
                )
            }
            .sheet(isPresented: $showingAddPerson) {
                PersonEditorSheet(
                    mode: .add,
                    onSave: { newMember in
                        plan.members.append(newMember)
                        showVerifyResult("\(newMember.displayName) was added to your membership.")
                    }
                )
            }
            .sheet(isPresented: $showingTierInfo) {
                TierInfoSheet(currentTier: currentTier)
            }
    }

    private var listBase: some View {
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
    }

    private var cancelAlertTitle: String {
        hasBalance ? "Request refund?" : "Balance"
    }

    /// True when the admin has flipped this client's Emerald flag on.
    /// Emerald clients get the Emerald tier badge regardless of seats /
    /// coverage, can't buy more coverage (it's granted), and can open
    /// the Invoices section (which is "Coming soon" for everyone else).
    private var isEmerald: Bool {
        GoldilocksSession.shared.identity?.emeraldMembershipEnabled ?? false
    }

    /// How many people this Emerald client may enable — granted by the
    /// admin alongside the Emerald flag; billed externally.
    private var emeraldSeatLimit: Int {
        GoldilocksSession.shared.identity?.emeraldSeatLimit ?? 0
    }

    private var activationConfirmMessage: String {
        if isEmerald {
            return "Coverage is included with your Emerald membership."
        }
        return "Your card will be charged $\(GoldilocksPlan.monthlyPricePerPerson) now for the initial report. Coverage runs through the end of next month, then renews at $\(GoldilocksPlan.monthlyPricePerPerson)/mo."
    }

    private var currentTier: GoldilocksMembershipTier {
        GoldilocksMembershipTier(
            activeMembers: plan.billableSeatCount,
            hasActiveCoverage: plan.coverageActive,
            emeraldEnabled: isEmerald
        )
    }

    private static let rowIconWidth: CGFloat = 28.0

    private var tierRow: some View {
        let tier: GoldilocksMembershipTier = currentTier
        let tapAction = { showingTierInfo = true }
        return Button(action: tapAction) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: tier.iconName)
                    .font(.body)
                    .foregroundStyle(tier.accentColor)
                    .frame(width: Self.rowIconWidth, alignment: .center)
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                    Text("\(tier.displayName) member")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.colorTextPrimary)
                    Text(tier.membershipDetail)
                        .font(.caption)
                        .foregroundStyle(.colorTextSecondary)
                    if isEmerald, emeraldSeatLimit > 0 {
                        Text("Add up to \(emeraldSeatLimit) people.")
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
        .listRowBackground(tier.tintColor)
    }

    private var balanceSection: some View {
        Section {
            nextChargeRow
            referralCreditRow
        } header: {
            Text("Account")
        }
    }

    @State private var showingReferralSheet: Bool = false

    private var referralCreditCents: Int {
        GoldilocksSession.shared.identity?.referralCreditCents ?? 0
    }

    private var referralCreditRow: some View {
        let tapAction = { showingReferralSheet = true }
        let creditLabel: String = "$\(referralCreditCents / 100)"
        return Button(action: tapAction) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: "gift.fill")
                    .font(.body)
                    .foregroundStyle(.colorFillPrimary)
                    .frame(width: Self.rowIconWidth, alignment: .center)
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                    Text("Referral credit")
                        .foregroundStyle(.colorTextPrimary)
                    Text("$50 credit for every paying client.")
                        .font(.caption)
                        .foregroundStyle(.colorTextSecondary)
                }
                Spacer()
                Text(creditLabel)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.colorTextSecondary)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.colorTextTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .alignmentGuide(.listRowSeparatorLeading) { dimensions in dimensions[.leading] }
        .sheet(isPresented: $showingReferralSheet) {
            ReferralCreditSheet(session: session)
        }
    }

    private var paymentSection: some View {
        Section {
            addPaymentMethodRow
        } header: {
            Text("Payments")
        }
    }

    private var hasPaymentMethod: Bool {
        billingStatus?.hasPaymentMethod ?? false
    }

    @ViewBuilder
    private var addPaymentMethodRow: some View {
        let tapAction: () -> Void = {
            if hasPaymentMethod {
                showingPaymentMethodOptions = true
            } else {
                Task { await startPaymentMethodSetup() }
            }
        }
        let title: String = (hasPaymentMethod || isEmerald) ? "Payment method" : "Add payment method"
        let subtitle: String = {
            if isEmerald { return "Emerald members are billed externally." }
            if hasPaymentMethod { return "Tap to update or cancel coverage." }
            return "Required before enabling people."
        }()
        let rowOpacity: Double = isEmerald ? 0.5 : 1.0
        Button(action: tapAction) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: "creditcard.fill")
                    .foregroundStyle(.colorFillPrimary)
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.colorTextPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.colorTextSecondary)
                }
                Spacer()
                addPaymentMethodTrailing
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(rowOpacity)
        .disabled(isEmerald || isSettingUpPaymentMethod)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if hasPaymentMethod, !isEmerald {
                let removeAction: () -> Void = { Task { await removePaymentMethod() } }
                Button("Remove", role: .destructive, action: removeAction)
            }
        }
        .confirmationDialog("Payment method", isPresented: $showingPaymentMethodOptions, titleVisibility: .visible) {
            let updateAction: () -> Void = { Task { await startPaymentMethodSetup() } }
            Button("Update method", action: updateAction)
            if billingStatus?.coverageActive == true {
                let cancelAction: () -> Void = { showingCancelConfirm = true }
                Button("Cancel coverage", role: .destructive, action: cancelAction)
            }
            Button("Dismiss", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var addPaymentMethodTrailing: some View {
        if isEmerald {
            EmptyView()
        } else if isSettingUpPaymentMethod {
            ProgressView()
        } else if hasPaymentMethod {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        } else {
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.colorTextTertiary)
        }
    }

    private var balanceRow: some View {
        let balance: Int = billingStatus?.balanceCents ?? 0
        let rate: Int = billingStatus?.monthlyRateCents ?? 0
        let refundableCents: Int = max(0, balance - rate)
        let balanceLabel: String = "$\(refundableCents / 100)"
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var nextChargeRow: some View {
        let tapAction = { showingBillingInfo = true }
        return Button(action: tapAction) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: "calendar")
                    .font(.body)
                    .foregroundStyle(.colorFillPrimary)
                    .frame(width: Self.rowIconWidth, alignment: .center)
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                    Text("Billing cycle")
                        .foregroundStyle(.colorTextPrimary)
                    Text("\(GoldilocksPlan.priceLabel).")
                        .font(.caption)
                        .foregroundStyle(.colorTextSecondary)
                }
                Spacer()
                Text(nextChargeLabel)
                    .foregroundStyle(.colorTextSecondary)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.colorTextTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .alignmentGuide(.listRowSeparatorLeading) { dimensions in dimensions[.leading] }
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
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        let dateString: String = formatter.string(from: firstOfNextMonth)
        return "\(dateString) · $\(chargeDollars)"
    }

    private var durationPicker: some View {
        Picker("Duration", selection: $prepaidDuration) {
            ForEach(GoldilocksPrepaidDuration.allCases, id: \.self) { duration in
                Text(duration.displayName).tag(duration)
            }
        }
        .pickerStyle(.menu)
    }

    private var paymentMethodPicker: some View {
        Picker("Payment method", selection: $paymentMethod) {
            ForEach(GoldilocksPaymentMethod.selectableCases, id: \.self) { method in
                if method == .apple {
                    Image(systemName: "apple.logo").tag(method)
                } else {
                    Text(method.displayName).tag(method)
                }
            }
        }
        .pickerStyle(.segmented)
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

    /// Apple Pay and card payments are recurring subscriptions; crypto is
    /// a one-time prepaid deposit.
    private var isSubscriptionCheckout: Bool {
        paymentMethod == .apple || paymentMethod == .card
    }

    private var chargeTotal: Int {
        let months: Int = isSubscriptionCheckout ? 1 : prepaidDuration.months
        return plan.billableSeatCount * GoldilocksPlan.monthlyPricePerPerson * months
    }

    private var checkoutButtonLabel: String {
        isSubscriptionCheckout ? "Subscribe $\(chargeTotal)/mo" : "Deposit $\(chargeTotal)"
    }

    private var canStartCheckout: Bool {
        plan.billableSeatCount > 0
    }

    private var billingInfoMessage: String {
        let now = Date()
        let calendar = Calendar.current
        let nextMonth: Date = calendar.date(byAdding: .month, value: 1, to: now) ?? now
        let components: DateComponents = calendar.dateComponents([.year, .month], from: nextMonth)
        guard let firstOfNextMonth = calendar.date(from: components) else {
            return "Billing runs at midnight on the 1st of each month."
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM d"
        let dateString: String = formatter.string(from: firstOfNextMonth)
        return "Billing runs at midnight on \(dateString)."
    }

    private var hasBalance: Bool {
        (billingStatus?.balanceCents ?? 0) > 0
    }

    private var cancelConfirmMessage: String {
        guard hasBalance else {
            let creditCents: Int = GoldilocksSession.shared.identity?.referralCreditCents ?? 0
            guard creditCents > 0 else {
                return "You can request a refund on your balance at any time."
            }
            let creditDollars: Int = creditCents / 100
            return "You have $\(creditDollars) in referral credit. Credit is applied to your monthly charges and new members, and isn't refundable to your payment method."
        }
        let balance: Int = billingStatus?.balanceCents ?? 0
        let rate: Int = billingStatus?.monthlyRateCents ?? 0
        let refundCents: Int = max(0, balance - rate)
        guard refundCents > 0 else {
            return "Coverage will not be renewed. The current month is non-refundable, so no balance will be returned."
        }
        let refundDollars: Int = refundCents / 100
        return "Coverage will not be renewed and $\(refundDollars) will be returned to your payment method. The current month is non-refundable."
    }

    @ViewBuilder
    private var peopleSection: some View {
        // With no members the tier row sits directly above "Add someone";
        // drop the separator between them so they read as one block.
        let tierSeparatorVisibility: Visibility = plan.members.isEmpty ? .hidden : .automatic
        Section {
            tierRow
                .listRowSeparator(tierSeparatorVisibility, edges: .bottom)
            ForEach(plan.members) { member in
                memberRow(member)
            }
            .onDelete(perform: deleteMembers)
            .onMove(perform: moveMembers)
            addSomeoneRow
        } header: {
            Text("People")
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
                    .font(.body)
                    .foregroundStyle(.colorFillPrimary)
                    .frame(width: Self.rowIconWidth, alignment: .center)
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                    Text("Add coverage")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.colorTextPrimary)
                    Text("Toggle people to start/stop coverage.")
                        .font(.caption)
                        .foregroundStyle(.colorTextSecondary)
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
                    Image(systemName: member.icon)
                        .font(.body)
                        .foregroundStyle(member.iconSwiftUIColor)
                        .frame(width: Self.rowIconWidth, alignment: .center)
                    VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                        Text(rowLabel)
                            .font(.body)
                            .foregroundStyle(.colorTextPrimary)
                        let summary: String = contactSummary(for: member)
                        if !summary.isEmpty {
                            Text(summary)
                                .font(.caption)
                                .foregroundStyle(.colorTextSecondary)
                        }
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            memberToggle(for: member)
        }
    }

    /// One-line summary of what's on file for a person, e.g.
    /// "3 emails, 2 phones, 1 address". Zero-count items are skipped.
    private func contactSummary(for member: SeatMember) -> String {
        var parts: [String] = []
        if !member.emails.isEmpty {
            parts.append(countLabel(member.emails.count, singular: "email", plural: "emails"))
        }
        if !member.phones.isEmpty {
            parts.append(countLabel(member.phones.count, singular: "phone", plural: "phones"))
        }
        if !member.addresses.isEmpty {
            parts.append(countLabel(member.addresses.count, singular: "address", plural: "addresses"))
        }
        return parts.joined(separator: ", ")
    }

    private func countLabel(_ count: Int, singular: String, plural: String) -> String {
        count == 1 ? "1 \(singular)" : "\(count) \(plural)"
    }

    private func memberToggle(for member: SeatMember) -> some View {
        let binding = Binding<Bool>(
            get: { member.enabled },
            set: { newValue in
                if newValue {
                    if isEmerald {
                        let enabledCount: Int = plan.members.filter(\.enabled).count
                        guard enabledCount < emeraldSeatLimit else {
                            showBillingResult("Your Emerald membership covers up to \(emeraldSeatLimit) people.")
                            return
                        }
                    } else if !hasPaymentMethod {
                        showingNeedsPaymentMethod = true
                        return
                    }
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
                reportDay: response.reportDay,
                hasPaymentMethod: response.hasPaymentMethod
            )
            cacheCoverageActive()
            if response.activated, response.deductedCents > 0 {
                let dollars: Int = response.deductedCents / 100
                showBillingResult("Coverage activated for \(member.displayName). Your card was charged $\(dollars) for their initial report.")
            }
        } catch is APIError {
            showBillingResult("Couldn't activate coverage. Make sure a payment method is on file, then try again.")
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

    /// Open a Stripe Checkout (setup mode) so the client can save a card.
    /// The card is confirmed when the app returns to the foreground.
    private func startPaymentMethodSetup() async {
        isSettingUpPaymentMethod = true
        do {
            let response = try await session.setupGoldilocksPaymentMethod()
            if let url = URL(string: response.checkoutUrl) {
                paymentMethodSessionId = response.sessionId
                openURL(url)
            } else {
                showBillingResult("Couldn't open the card setup page.")
            }
        } catch let apiError as APIError {
            switch apiError {
            case .authenticationFailed, .notAuthenticated, .forbidden:
                showBillingResult("Couldn't authenticate with the server. Reopen the app and try again; if it keeps happening, delete app data in Settings to sign in fresh.")
            default:
                showBillingResult("Couldn't start card setup: \(apiError.description)")
            }
        } catch {
            showBillingResult("Couldn't start card setup: \(error.localizedDescription)")
        }
        isSettingUpPaymentMethod = false
    }

    /// After returning from the setup checkout, confirm the saved card and
    /// refresh billing status so the row shows the card is on file.
    private func confirmPaymentMethod() async {
        guard let sessionId = paymentMethodSessionId else { return }
        do {
            let result = try await session.confirmGoldilocksPaymentMethod(sessionId: sessionId)
            guard result.hasPaymentMethod else { return }
            paymentMethodSessionId = nil
            billingStatus = try await session.fetchGoldilocksBillingStatus()
            showBillingResult("Your card has been saved.")
        } catch {
            Log.warning("[Goldilocks] Payment method confirm failed: \(error.localizedDescription)")
        }
    }

    /// Detach the saved card from the Stripe customer. Recurring invoices
    /// will fail without a card, so the row prompts to add a new one.
    private func removePaymentMethod() async {
        do {
            _ = try await session.removeGoldilocksPaymentMethod()
            billingStatus = try await session.fetchGoldilocksBillingStatus()
            showBillingResult("Payment method removed. Add a new one before your next renewal.")
        } catch {
            showBillingResult("Couldn't remove payment method: \(error.localizedDescription)")
        }
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
            showBillingResult("Product not available. Please try again later.")
        }
    }

    private func startStripeCheckout() async {
        isStartingCheckout = true
        let amountCents: Int = chargeTotal * 100
        do {
            let response = try await session.createGoldilocksCheckout(
                paymentMethod: paymentMethod,
                amountCents: amountCents
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
        let amountCents: Int = chargeTotal * 100
        let store: GoldilocksStore = GoldilocksStore.shared
        let success: Bool = await store.purchase(
            amountCents: amountCents,
            session: session
        )
        if success {
            await syncSeats()
            showBillingResult("Your balance has been updated.")
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
                showBillingResult("Deposit received. Toggle a person on to activate coverage.")
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

    /// Stop the subscription at the end of the current paid period.
    private func cancelCoverage() async {
        isCancelling = true
        do {
            _ = try await session.cancelGoldilocksBilling()
            billingStatus = try await session.fetchGoldilocksBillingStatus()
            cacheCoverageActive()
            showBillingResult("Coverage will end at the close of the current period.")
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
/// "Remove" section (edit only), and what gets done on Save. Emails,
/// phones, and addresses are lists; each entry is added through its
/// own pop-up (emails verify a 6-digit code before they land in the
/// list). At least one verified email is required before Save is
/// enabled — the person's identity on the plan is the set of verified
/// email addresses.
private struct PersonEditorSheet: View {
    enum Mode {
        case add
        case edit(SeatMember)
    }

    @Environment(\.dismiss) private var dismiss: DismissAction

    let mode: Mode
    let onSave: (SeatMember) -> Void
    let onRemove: (() -> Void)?

    @State private var icon: String
    @State private var iconColor: String
    @State private var firstName: String
    @State private var middleName: String
    @State private var lastName: String
    @State private var emails: [LabeledEmail]
    @State private var phones: [String]
    @State private var addresses: [String]
    @State private var showingRemoveConfirm: Bool = false
    @State private var showingAddEmail: Bool = false
    @State private var showingAddPhone: Bool = false
    @State private var showingAddAddress: Bool = false

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
            self._icon = State(initialValue: Self.defaultIconChoice)
            self._iconColor = State(initialValue: SeatMember.defaultIconColor)
            self._firstName = State(initialValue: "")
            self._middleName = State(initialValue: "")
            self._lastName = State(initialValue: "")
            self._emails = State(initialValue: [])
            self._phones = State(initialValue: [])
            self._addresses = State(initialValue: [])
        case .edit(let member):
            self.originalMember = member
            self._icon = State(initialValue: member.icon)
            self._iconColor = State(initialValue: member.iconColor)
            self._firstName = State(initialValue: member.firstName)
            self._middleName = State(initialValue: member.middleName)
            self._lastName = State(initialValue: member.lastName)
            self._emails = State(initialValue: member.emails)
            self._phones = State(initialValue: member.phones)
            self._addresses = State(initialValue: member.addresses)
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                iconSection
                nameSection
                emailsSection
                phonesSection
                addressesSection
                if onRemove != nil { removeSection }
            }
            .scrollContentBackground(.hidden)
            .background(.colorBackgroundRaisedSecondary)
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
            .sheet(isPresented: $showingAddEmail) {
                AddEmailSheet { added in
                    emails.append(LabeledEmail(address: added, label: .other, verified: true))
                }
            }
            .sheet(isPresented: $showingAddPhone) {
                AddPhoneSheet { added in
                    phones.append(added)
                }
            }
            .sheet(isPresented: $showingAddAddress) {
                AddAddressSheet { added in
                    addresses.append(added)
                }
            }
        }
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
        return "Remove \(label) from your membership?"
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

    private static let iconChoices: [String] = [
        "person.circle.fill", "star.fill", "heart.fill", "leaf.fill", "pawprint.fill", "crown.fill"
    ]

    private static let defaultIconChoice: String = iconChoices.first ?? SeatMember.defaultIcon

    private var iconSection: some View {
        Section {
            // Six equal-width slots per row so the cells distribute evenly
            // across any iPhone width, and the two rows column-align.
            HStack(spacing: 0) {
                ForEach(Self.iconChoices, id: \.self) { choice in
                    iconCell(choice)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, DesignConstants.Spacing.stepX)
            HStack(spacing: 0) {
                ForEach(SeatMember.iconColorNames, id: \.self) { name in
                    colorCell(name)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, DesignConstants.Spacing.stepX)
        } header: {
            Text("Icon")
        }
    }

    private func iconCell(_ choice: String) -> some View {
        let isSelected: Bool = choice == icon
        let selectedTint: Color = SeatMember.color(named: iconColor)
        let background: Color = isSelected ? selectedTint : .colorFillMinimal
        let foreground: Color = isSelected ? .white : .colorTextPrimary
        let tapAction: () -> Void = { icon = choice }
        return Button(action: tapAction) {
            Image(systemName: choice)
                .font(.title3)
                .foregroundStyle(foreground)
                .frame(width: 44.0, height: 44.0)
                .background(background, in: Circle())
        }
        .buttonStyle(.plain)
    }

    private func colorCell(_ name: String) -> some View {
        let isSelected: Bool = name == iconColor
        let fill: Color = SeatMember.color(named: name)
        let tapAction: () -> Void = { iconColor = name }
        return Button(action: tapAction) {
            Circle()
                .fill(fill)
                .frame(width: 32.0, height: 32.0)
                .overlay {
                    if isSelected {
                        Image(systemName: "checkmark")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white)
                    }
                }
        }
        .buttonStyle(.plain)
    }

    private var nameSection: some View {
        Section {
            TextField("First name", text: $firstName)
                .textContentType(.givenName)
            TextField("Middle name (optional)", text: $middleName)
                .textContentType(.middleName)
            TextField("Last name (optional)", text: $lastName)
                .textContentType(.familyName)
        } header: {
            Text("Name")
        }
    }

    private var emailsSection: some View {
        Section {
            ForEach(emails) { email in
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text(email.address)
                        .foregroundStyle(.colorTextPrimary)
                    Spacer()
                }
            }
            .onDelete(perform: deleteEmails)
            addRowButton(label: "Add email") { showingAddEmail = true }
        } header: {
            Text("Emails")
        } footer: {
            Text("At least one verified email is required.")
                .foregroundStyle(.colorTextSecondary)
        }
    }

    private var phonesSection: some View {
        Section {
            ForEach(phones, id: \.self) { phone in
                Text(phone)
                    .foregroundStyle(.colorTextPrimary)
            }
            .onDelete(perform: deletePhones)
            addRowButton(label: "Add phone") { showingAddPhone = true }
        } header: {
            Text("Phones (optional)")
        }
    }

    private var addressesSection: some View {
        Section {
            ForEach(addresses, id: \.self) { line in
                Text(line)
                    .foregroundStyle(.colorTextPrimary)
            }
            .onDelete(perform: deleteAddresses)
            addRowButton(label: "Add address") { showingAddAddress = true }
        } header: {
            Text("Addresses (optional)")
        }
    }

    private func addRowButton(label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: "plus.circle.fill")
                    .foregroundStyle(.colorFillPrimary)
                Text(label)
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func deletePhones(at offsets: IndexSet) {
        phones.remove(atOffsets: offsets)
    }

    private func deleteAddresses(at offsets: IndexSet) {
        addresses.remove(atOffsets: offsets)
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

    private var canSave: Bool {
        guard !firstName.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        guard !emails.isEmpty else { return false }
        guard let original = originalMember else { return true }
        return assembledMember != original
    }

    /// The SeatMember that would be persisted if Save was tapped now.
    /// Free-form fields are trimmed so a stray space isn't mistaken for
    /// a real edit.
    private var assembledMember: SeatMember {
        // New people start disabled — enabling them later is what charges
        // the $100 initial-report fee and starts coverage.
        var member: SeatMember = originalMember ?? SeatMember(enabled: false)
        member.firstName = firstName.trimmingCharacters(in: .whitespaces)
        member.middleName = middleName.trimmingCharacters(in: .whitespaces)
        member.lastName = lastName.trimmingCharacters(in: .whitespaces)
        member.emails = emails
        member.phones = phones
        member.addresses = addresses
        member.icon = icon
        member.iconColor = iconColor
        return member
    }

    private func deleteEmails(at offsets: IndexSet) {
        emails.remove(atOffsets: offsets)
    }
}

/// Palette for person icons. Names are what's persisted on
/// `SeatMember.iconColor`; the mapping to SwiftUI colors lives here so
/// the model stays UI-framework-free.
extension SeatMember {
    static let iconColorNames: [String] = ["blue", "green", "orange", "purple", "pink", "red"]

    static func color(named name: String) -> Color {
        switch name {
        case "green": return .green
        case "orange": return .orange
        case "purple": return .purple
        case "pink": return .pink
        case "red": return .red
        default: return .blue
        }
    }

    var iconSwiftUIColor: Color {
        Self.color(named: iconColor)
    }
}

/// Pop-up for adding one email: enter the address, receive a 6-digit
/// code, verify, and the verified address is handed back to the editor.
/// Validation is permissive and unicode-friendly — any non-empty user
/// part, an "@", and a dotted domain — so international addresses work.
private struct AddEmailSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction
    let onAdd: (String) -> Void

    @State private var address: String = ""
    @State private var codeSent: Bool = false
    @State private var code: String = ""
    @State private var attemptsLeft: Int = EmailCodeVerification.maxAttempts
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email address", text: $address)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .foregroundStyle(.colorTextPrimary)
                        .disabled(codeSent)
                } header: {
                    Text("Email")
                }
                if codeSent {
                    Section {
                        TextField("000000", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .onChange(of: code) { _, newValue in
                                code = String(newValue.filter { $0.isNumber }.prefix(EmailCodeVerification.codeLength))
                            }
                    } header: {
                        Text("Verification code")
                    } footer: {
                        Text(codeFooter)
                            .foregroundStyle(.colorTextSecondary)
                    }
                }
                Section {
                    primaryButton
                }
            }
            .scrollContentBackground(.hidden)
            .background(.colorBackgroundRaisedSecondary)
            .navigationTitle("Add email")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let cancelAction = { dismiss() }
                    Button("Cancel", action: cancelAction)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private var codeFooter: String {
        if let errorMessage { return errorMessage }
        return "A 6-digit code was sent to \(address)."
    }

    @ViewBuilder
    private var primaryButton: some View {
        if codeSent {
            let verifyAction: () -> Void = { verify() }
            Button(action: verifyAction) {
                centeredLabel("Verify")
            }
            .disabled(code.count < EmailCodeVerification.codeLength)
        } else {
            let sendAction: () -> Void = { codeSent = true }
            Button(action: sendAction) {
                centeredLabel("Send verification code")
            }
            .disabled(!isValidEmail)
        }
    }

    private func centeredLabel(_ label: String) -> some View {
        HStack {
            Spacer()
            Text(label)
                .font(.body.weight(.semibold))
            Spacer()
        }
    }

    private var isValidEmail: Bool {
        let trimmed: String = address.trimmingCharacters(in: .whitespaces)
        guard let at = trimmed.firstIndex(of: "@") else { return false }
        let local: Substring = trimmed[..<at]
        let domain: Substring = trimmed[trimmed.index(after: at)...]
        return !local.isEmpty && !domain.isEmpty && domain.contains(".")
    }

    private func verify() {
        if EmailCodeVerification.isValid(code) {
            onAdd(address.trimmingCharacters(in: .whitespaces))
            dismiss()
        } else {
            attemptsLeft -= 1
            code = ""
            if attemptsLeft <= 0 {
                codeSent = false
                attemptsLeft = EmailCodeVerification.maxAttempts
                errorMessage = nil
            } else {
                errorMessage = "Wrong code. \(attemptsLeft) attempts left."
            }
        }
    }
}

/// Pop-up for adding one phone number. The country code is its own
/// small field (defaulting to +1, the "+" maintained automatically)
/// separate from the number. +1 numbers dash-format as 555-123-4567;
/// other codes keep plain digits up to E.164's 15.
private struct AddPhoneSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction
    let onAdd: (String) -> Void

    @State private var countryCode: String = "+1"
    @State private var number: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: DesignConstants.Spacing.step2x) {
                        TextField("+1", text: countryCodeBinding)
                            .keyboardType(.phonePad)
                            .multilineTextAlignment(.center)
                            .frame(width: 56.0)
                            .foregroundStyle(.colorTextPrimary)
                        Divider()
                        TextField("555-123-4567", text: numberBinding)
                            .textContentType(.telephoneNumber)
                            .keyboardType(.phonePad)
                            .foregroundStyle(.colorTextPrimary)
                    }
                } header: {
                    Text("Phone")
                }
                Section {
                    addButton
                }
            }
            .scrollContentBackground(.hidden)
            .background(.colorBackgroundRaisedSecondary)
            .navigationTitle("Add phone")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let cancelAction = { dismiss() }
                    Button("Cancel", action: cancelAction)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private var addButton: some View {
        let addAction: () -> Void = {
            onAdd("\(countryCode) \(number.trimmingCharacters(in: .whitespaces))")
            dismiss()
        }
        return Button(action: addAction) {
            HStack {
                Spacer()
                Text("Add phone")
                    .font(.body.weight(.semibold))
                Spacer()
            }
        }
        .disabled(!canAdd)
    }

    /// Formats on every keystroke via the binding setter, so the dash
    /// grouping can't be skipped by view-update timing.
    private var numberBinding: Binding<String> {
        Binding(
            get: { number },
            set: { newValue in number = formatNumber(newValue) }
        )
    }

    /// Keeps the leading "+", digits only (codes are 1–3 digits), and
    /// re-formats the number whenever the code changes.
    private var countryCodeBinding: Binding<String> {
        Binding(
            get: { countryCode },
            set: { newValue in
                let digits: String = String(newValue.filter { $0.isNumber }.prefix(3))
                countryCode = "+\(digits)"
                number = formatNumber(number)
            }
        )
    }

    private var isUSCode: Bool {
        countryCode == "+1"
    }

    /// US numbers must be the full 10 digits; other countries vary, so
    /// anything from 5 digits up is accepted.
    private var canAdd: Bool {
        let codeDigits: Int = countryCode.filter(\.isNumber).count
        let numberDigits: Int = number.filter(\.isNumber).count
        guard codeDigits >= 1 else { return false }
        return isUSCode ? numberDigits == 10 : numberDigits >= 5
    }

    /// Dash-format for +1; plain digits (E.164 cap) for everything else.
    private func formatNumber(_ raw: String) -> String {
        let digits: String = String(raw.filter { $0.isNumber })
        guard isUSCode else {
            return String(digits.prefix(15))
        }
        return Self.dashFormat(digits)
    }

    /// Group up to 10 digits as XXX-XXX-XXXX.
    private static func dashFormat(_ digits: String) -> String {
        let capped: String = String(digits.prefix(10))
        var result: String = ""
        for (index, character) in capped.enumerated() {
            if index == 3 || index == 6 {
                result.append("-")
            }
            result.append(character)
        }
        return result
    }
}

/// Pop-up for adding one mailing address, matching the email / phone
/// pop-ups. Country sits at the top and drives which fields appear and
/// what they're called (e.g. ZIP vs Postcode, postal-before-city for
/// Germany / Japan), so international addresses enter naturally. The
/// result is stored as a single line.
private struct AddAddressSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction
    let onAdd: (String) -> Void

    /// One country's address-entry shape. This is the single config to
    /// edit when adding country support: the picker entry (flag + name),
    /// the field labels, the field ordering, and the postal keyboard all
    /// derive from a row here. Keep "United States" first; list every
    /// other country alphabetically. A country is either supported here
    /// or not offered at all.
    private struct CountryFormat {
        let flag: String
        let name: String
        let cityLabel: String
        /// nil = the country's addresses don't use a region field.
        let regionLabel: String?
        let postalLabel: String
        /// Postal code is written before the city (Germany, France, Japan…).
        let postalBeforeCity: Bool
        /// Postal codes are digits-only — opens the number pad.
        let numericPostal: Bool
    }

    private static let formats: [CountryFormat] = [
        CountryFormat(flag: "🇺🇸", name: "United States", cityLabel: "City", regionLabel: "State", postalLabel: "ZIP code", postalBeforeCity: false, numericPostal: true),
        CountryFormat(flag: "🇦🇺", name: "Australia", cityLabel: "Suburb", regionLabel: "State", postalLabel: "Postcode", postalBeforeCity: false, numericPostal: true),
        CountryFormat(flag: "🇨🇦", name: "Canada", cityLabel: "City", regionLabel: "Province", postalLabel: "Postal code", postalBeforeCity: false, numericPostal: false),
        CountryFormat(flag: "🇫🇷", name: "France", cityLabel: "City", regionLabel: nil, postalLabel: "Postal code", postalBeforeCity: true, numericPostal: true),
        CountryFormat(flag: "🇩🇪", name: "Germany", cityLabel: "City", regionLabel: nil, postalLabel: "Postal code", postalBeforeCity: true, numericPostal: true),
        CountryFormat(flag: "🇯🇵", name: "Japan", cityLabel: "City", regionLabel: "Prefecture", postalLabel: "Postal code", postalBeforeCity: true, numericPostal: true),
        CountryFormat(flag: "🇲🇽", name: "Mexico", cityLabel: "City", regionLabel: "State", postalLabel: "Postal code", postalBeforeCity: true, numericPostal: true),
        CountryFormat(flag: "🇬🇧", name: "United Kingdom", cityLabel: "Town / City", regionLabel: nil, postalLabel: "Postcode", postalBeforeCity: false, numericPostal: false)
    ]

    @State private var country: String = "United States"
    @State private var showingCountryPicker: Bool = false
    @State private var line1: String = ""
    @State private var city: String = ""
    @State private var region: String = ""
    @State private var postal: String = ""

    private var format: CountryFormat {
        Self.formats.first(where: { $0.name == country }) ?? Self.formats[0]
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    countryRow
                    TextField("Address", text: $line1)
                        .textContentType(.fullStreetAddress)
                    if format.postalBeforeCity {
                        postalField
                        regionField
                        cityField
                    } else {
                        cityField
                        regionField
                        postalField
                    }
                } header: {
                    Text("Address")
                }
                Section {
                    addButton
                }
            }
            .scrollContentBackground(.hidden)
            .background(.colorBackgroundRaisedSecondary)
            .navigationTitle("Add address")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let cancelAction = { dismiss() }
                    Button("Cancel", action: cancelAction)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var countryRow: some View {
        let tapAction: () -> Void = { showingCountryPicker = true }
        return Button(action: tapAction) {
            HStack {
                Text("Country")
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
                Text("\(format.flag) \(format.name)")
                    .foregroundStyle(.colorTextSecondary)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.colorTextTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showingCountryPicker) {
            countryPickerSheet
        }
    }

    private var countryPickerSheet: some View {
        NavigationStack {
            List {
                ForEach(Self.formats, id: \.name) { entry in
                    countryPickerRow(entry)
                }
            }
            .scrollContentBackground(.hidden)
            .background(.colorBackgroundRaisedSecondary)
            .navigationTitle("Country")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let cancelAction = { showingCountryPicker = false }
                    Button("Cancel", action: cancelAction)
                }
            }
        }
        // A medium detent steals the list's scroll gesture to resize the
        // sheet; scrolling must win here, so prefer it explicitly and
        // keep the sheet at full height.
        .presentationDetents([.large])
        .presentationContentInteraction(.scrolls)
    }

    private func countryPickerRow(_ entry: CountryFormat) -> some View {
        let selectAction: () -> Void = {
            country = entry.name
            showingCountryPicker = false
        }
        return Button(action: selectAction) {
            HStack {
                Text("\(entry.flag) \(entry.name)")
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
                if entry.name == country {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.colorFillPrimary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var cityField: some View {
        TextField(format.cityLabel, text: $city)
            .textContentType(.addressCity)
    }

    @ViewBuilder
    private var regionField: some View {
        if let regionLabel = format.regionLabel {
            TextField(regionLabel, text: $region)
                .textContentType(.addressState)
        }
    }

    private var postalField: some View {
        let keyboard: UIKeyboardType = format.numericPostal ? .numberPad : .default
        return TextField(format.postalLabel, text: $postal)
            .textContentType(.postalCode)
            .keyboardType(keyboard)
    }

    private var addButton: some View {
        let addAction: () -> Void = {
            onAdd(singleLine)
            dismiss()
        }
        return Button(action: addAction) {
            HStack {
                Spacer()
                Text("Add address")
                    .font(.body.weight(.semibold))
                Spacer()
            }
        }
        .disabled(line1.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    /// Compose the parts in the country's reading order, skipping blanks.
    private var singleLine: String {
        let includeRegion: Bool = format.regionLabel != nil
        let middle: [String] = format.postalBeforeCity
            ? [postal, includeRegion ? region : "", city]
            : [city, includeRegion ? region : "", postal]
        let parts: [String] = [line1] + middle + [country]
        return parts
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
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

private struct TierInfoSheet: View {
    let currentTier: GoldilocksMembershipTier
    @Environment(\.dismiss) private var dismiss: DismissAction

    var body: some View {
        NavigationStack {
            List {
                ForEach(GoldilocksMembershipTier.allCases, id: \.self) { tier in
                    tierInfoRow(tier)
                }
            }
            .scrollContentBackground(.hidden)
            .background(.colorBackgroundRaisedSecondary)
            .navigationTitle("Membership tiers")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let cancelAction = { dismiss() }
                    Button("Done", action: cancelAction)
                }
            }
        }
    }

    private func tierInfoRow(_ tier: GoldilocksMembershipTier) -> some View {
        let isCurrent: Bool = tier == currentTier
        return HStack(spacing: DesignConstants.Spacing.step2x) {
            Image(systemName: tier.iconName)
                .foregroundStyle(tier.accentColor)
                .frame(width: 24, alignment: .center)
            VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                HStack(spacing: DesignConstants.Spacing.stepX) {
                    Text(tier.displayName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.colorTextPrimary)
                    if isCurrent {
                        Text("Current")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(tier.accentColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(tier.tintColor, in: Capsule())
                    }
                }
                Text(tier.membershipDetail)
                    .font(.callout)
                    .foregroundStyle(.colorTextSecondary)
            }
        }
        .listRowBackground(isCurrent ? tier.tintColor : Color.colorFillMinimal)
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
                    .listRowBackground(Color.colorFillMinimal)
            } footer: {
                Text("Emerald membership invoices will appear here.")
                    .foregroundStyle(.colorTextSecondary)
            }
        }
        .scrollContentBackground(.hidden)
        .background(.colorBackgroundRaisedSecondary)
        .navigationTitle("Invoices")
        .toolbarTitleDisplayMode(.inline)
    }
}

private struct AppShareQRSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction

    private var shareURL: URL {
        let domain: String = ConfigManager.shared.currentEnvironment.relyingPartyIdentifier
        let base: String = "https://\(domain)"
        guard let url = URL(string: base) else {
            return URL(string: "https://goldilocksdigital.xyz")
                ?? URL(fileURLWithPath: "/")
        }
        return url
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: DesignConstants.Spacing.step6x) {
                QRCodeView(
                    url: shareURL,
                    centerImage: Image(BrandConfig.shared.assets.logoImageName)
                )

                ShareLink(
                    item: shareURL,
                    subject: Text(BrandConfig.shared.brand.name),
                    message: Text("Join me on \(BrandConfig.shared.brand.name)")
                ) {
                    HStack(spacing: DesignConstants.Spacing.stepX) {
                        Image(systemName: "square.and.arrow.up")
                        Text("Share link")
                    }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.colorTextPrimaryInverted)
                    .padding(.vertical, DesignConstants.Spacing.step3x)
                    .padding(.horizontal, DesignConstants.Spacing.step6x)
                    .background(Color.colorFillPrimary, in: Capsule())
                }
            }
            .padding(DesignConstants.Spacing.step6x)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.colorBackgroundRaisedSecondary)
            .navigationTitle("Invite")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let cancelAction = { dismiss() }
                    Button("Done", action: cancelAction)
                }
            }
        }
    }
}

private struct ReferralCreditSheet: View {
    let session: any SessionManagerProtocol
    @Environment(\.dismiss) private var dismiss: DismissAction
    @State private var referralInput: String = ""
    @State private var resultMessage: String?
    @State private var showingResult: Bool = false
    @State private var showingShareQR: Bool = false
    @FocusState private var isInputFocused: Bool

    private var myCode: String {
        GoldilocksSession.shared.identity?.referralCode ?? "------"
    }

    private var referralCreditCents: Int {
        GoldilocksSession.shared.identity?.referralCreditCents ?? 0
    }

    private var referralCreditFormatted: String {
        let dollars: Int = referralCreditCents / 100
        return "$\(dollars)"
    }

    private var hasAppliedReferralCode: Bool {
        GoldilocksSession.shared.identity?.hasAppliedReferralCode ?? false
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: DesignConstants.Spacing.step8x) {
                Spacer()

                VStack(spacing: DesignConstants.Spacing.step2x) {
                    Text("Your referral code")
                        .font(.caption)
                        .foregroundStyle(.colorTextSecondary)
                        .textCase(.uppercase)
                        .kerning(1.0)

                    let copyAction = { UIPasteboard.general.string = myCode }
                    Button(action: copyAction) {
                        HStack(spacing: DesignConstants.Spacing.step2x) {
                            Text(myCode)
                                .font(.system(size: 36, weight: .bold, design: .monospaced))
                                .foregroundStyle(.colorTextPrimary)
                                .kerning(4.0)
                            Image(systemName: "doc.on.doc")
                                .font(.body)
                                .foregroundStyle(.colorTextTertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy referral code \(myCode)")

                    Text("$50 credit for every paying client.")
                        .font(.footnote)
                        .foregroundStyle(.colorTextSecondary)

                    if referralCreditCents > 0 {
                        Text("Referral credit: \(referralCreditFormatted)")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.brandIcon)
                    }
                }

                if !hasAppliedReferralCode {
                VStack(spacing: DesignConstants.Spacing.step3x) {
                    Text("Have a referral code?")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.colorTextPrimary)

                    TextField("000000", text: $referralInput)
                        .keyboardType(.numberPad)
                        .font(.system(size: 24, weight: .semibold, design: .monospaced))
                        .multilineTextAlignment(.center)
                        .padding(DesignConstants.Spacing.step3x)
                        .background(Color.colorFillMinimal, in: RoundedRectangle(cornerRadius: DesignConstants.CornerRadius.regular))
                        .focused($isInputFocused)
                        .onChange(of: referralInput) { _, newValue in
                            let digits: String = String(newValue.filter(\.isNumber).prefix(6))
                            if digits != newValue { referralInput = digits }
                        }
                        .accessibilityIdentifier("referral-code-input")

                    let applyAction = {
                        let code: String = referralInput.trimmingCharacters(in: .whitespaces)
                        guard code.count == 6 else {
                            resultMessage = "Please enter a 6-digit code."
                            showingResult = true
                            return
                        }
                        if code == myCode {
                            resultMessage = "You cannot use your own referral code."
                            showingResult = true
                            return
                        }
                        Task { await submitReferralCode(code) }
                    }
                    Button(action: applyAction) {
                        Text("Apply code")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.colorTextPrimaryInverted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, DesignConstants.Spacing.step3x)
                            .background(Color.colorFillPrimary, in: RoundedRectangle(cornerRadius: DesignConstants.CornerRadius.regular))
                    }
                    .disabled(referralInput.count != 6)
                    .opacity(referralInput.count == 6 ? 1.0 : 0.5)
                }
                .padding(.horizontal, DesignConstants.Spacing.step4x)
                }

                Spacer()
            }
            .padding(DesignConstants.Spacing.step6x)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.colorBackgroundRaisedSecondary)
            .navigationTitle("Referral")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let cancelAction = { dismiss() }
                    Button("Done", action: cancelAction)
                }

                ToolbarItem(placement: .topBarTrailing) {
                    let showShareQR = { showingShareQR = true }
                    Button(action: showShareQR) {
                        Image(systemName: "qrcode")
                    }
                    .accessibilityLabel("Show invite QR code")
                }
            }
            .sheet(isPresented: $showingShareQR) {
                AppShareQRSheet()
            }
            .onAppear { if !hasAppliedReferralCode { isInputFocused = true } }
            .alert("Referral", isPresented: $showingResult) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(resultMessage ?? "")
            }
        }
    }

    private func submitReferralCode(_ code: String) async {
        do {
            try await session.claimGoldilocksReferral(code: code)
            resultMessage = "Referral applied."
            referralInput = ""
        } catch {
            resultMessage = "Could not apply referral code. It may be invalid."
        }
        showingResult = true
    }
}
