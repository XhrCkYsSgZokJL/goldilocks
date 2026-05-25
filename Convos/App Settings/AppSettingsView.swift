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
        GoldilocksMembershipTier(monthlyTotalDollars: GoldilocksSeatPlan.shared.monthlyTotal).displayName
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
            Text("Invoices from Goldilocks Digital")
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
                : "Upgrade failed — check the code and try again."
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
    @State private var isAddingMember: Bool = false
    @State private var isSending: Bool = false
    @State private var sendResultMessage: String?
    @State private var showingSendResult: Bool = false
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
                Task { await syncSeats() }
            }
            .task {
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
            cancelSection
            sendSection
        }
        .scrollContentBackground(.hidden)
        .background(.colorBackgroundRaisedSecondary)
        .navigationTitle("Membership")
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

    private var tierSection: some View {
        let tier: GoldilocksMembershipTier = GoldilocksMembershipTier(monthlyTotalDollars: plan.monthlyTotal)
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

    @ViewBuilder
    private var coverageSection: some View {
        Section {
            HStack {
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
            }
        } header: {
            Text("Coverage")
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
            Text("Add coverage")
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
        Text("Adds \(prepaidDuration.displayName) of coverage. Editing your membership moves the coverage date.")
    }

    @ViewBuilder
    private var cancelSection: some View {
        if isCoverageActive {
            Section {
                let cancelAction: () -> Void = { showingCancelConfirm = true }
                Button(role: .destructive, action: cancelAction) {
                    HStack {
                        Spacer()
                        if isCancelling {
                            ProgressView()
                        } else {
                            Text("Cancel coverage & refund")
                                .font(.body.weight(.semibold))
                        }
                        Spacer()
                    }
                }
                .disabled(isCancelling)
            }
        }
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
            return "Crypto Coming Soon"
        }
        return "Add \(prepaidDuration.displayName)"
    }

    private var canStartCheckout: Bool {
        paymentMethod == .card && !plan.members.isEmpty
    }

    private var isCoverageActive: Bool {
        billingStatus?.activeUntil != nil
    }

    private var coverageStatusText: String {
        guard let status = billingStatus else { return "Checking…" }
        guard let activeUntil = status.activeUntil,
              let date = Self.dateFormatter.date(from: activeUntil) else {
            return "No active coverage"
        }
        return "Active until \(date.formatted(date: .abbreviated, time: .omitted))"
    }

    private var cancelConfirmMessage: String {
        let refund: Int = (billingStatus?.balanceCents ?? 0) / 100
        return "Coverage ends now and the unused $\(refund) is refunded to your card."
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
                    Button(action: editAction) {
                        memberRow(member)
                    }
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
            try await plan.sendRosterToChannel(session: session)
            sendResultMessage = "Your people list was posted to your Advisory chat."
        } catch {
            sendResultMessage = error.localizedDescription
        }
        isSending = false
        showingSendResult = true
    }

    /// Push the current seat mix to the backend so it can re-settle the
    /// balance and recompute the coverage date. Runs on appear and whenever
    /// the people list changes.
    private func syncSeats() async {
        do {
            billingStatus = try await session.syncGoldilocksSeats(
                lightSeats: plan.lightSeats,
                activeSeats: plan.activeSeats
            )
        } catch {
            Log.warning("[Goldilocks] Seat sync failed: \(error.localizedDescription)")
        }
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
                lightSeats: plan.lightSeats,
                activeSeats: plan.activeSeats
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
            if checkoutInitiated, status.balanceCents > balanceBeforeCheckout {
                checkoutInitiated = false
                showBillingResult("Payment confirmed — your coverage is active.")
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

    private var canSendToAdvisory: Bool {
        plan.canSendToAdvisory
    }

    private func deleteMembers(at offsets: IndexSet) {
        plan.members.remove(atOffsets: offsets)
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
        MembershipView(session: MockInboxesService())
    }
}
