import ConvosCore
import Foundation
import SwiftUI

struct FeatureRowItem<AccessoryView: View>: View {
    let imageName: String?
    let symbolName: String?
    let title: String
    let subtitle: String?
    var iconBackgroundColor: Color = .colorOrange
    var iconForegroundColor: Color = .white
    @ViewBuilder let accessoryView: () -> AccessoryView

    private var hasIcon: Bool {
        imageName != nil || symbolName != nil
    }

    var image: Image? {
        if let imageName {
            Image(imageName)
        } else if let symbolName {
            Image(systemName: symbolName)
        } else {
            nil
        }
    }

    var body: some View {
        HStack(spacing: DesignConstants.Spacing.step2x) {
            if let image {
                Group {
                    image
                        .font(.headline)
                        .padding(.horizontal, DesignConstants.Spacing.step2x)
                        .padding(.vertical, DesignConstants.Spacing.step3x)
                        .foregroundStyle(iconForegroundColor)
                }
                .frame(width: DesignConstants.Spacing.step10x, height: DesignConstants.Spacing.step10x)
                .background(
                    RoundedRectangle(cornerRadius: DesignConstants.CornerRadius.regular)
                        .fill(iconBackgroundColor)
                        .aspectRatio(1.0, contentMode: .fit)
                )
            }

            VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                Text(title)
                    .font(.body)
                    .foregroundStyle(.colorTextPrimary)

                if let subtitle {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(.colorTextSecondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            accessoryView()
        }
    }
}

#Preview {
    FeatureRowItem(imageName: nil, symbolName: "eyeglasses", title: "Peek-a-boo", subtitle: "Blur when people peek") {
        SoonLabel()
    }
    .padding(DesignConstants.Spacing.step4x)
}

struct ConversationInfoView: View {
    @Bindable var viewModel: ConversationViewModel
    let focusCoordinator: FocusCoordinator

    @State private var connectionsViewModel: ConversationConnectionsViewModel?

    @Environment(\.dismiss) private var dismiss: DismissAction
    @State private var showingExplodeSheet: Bool = false
    @State private var presentingEditView: Bool = false
    @State private var showingLockedInfo: Bool = false
    @State private var showingFullInfo: Bool = false
    @State private var presentingShareView: Bool = false
    @State private var exportedLogsURL: URL?
    @State private var metadataDebugText: String = "Loading…"
    @State private var showingRestoreInviteTagAlert: Bool = false
    @State private var restoreInviteTagText: String = ""
    @State private var seatPlan: GoldilocksSeatPlan = GoldilocksSeatPlan.shared
    @State private var advisoryCoverage: ConvosAPI.GoldilocksBillingStatusResponse?
    @State private var selectedAdvisoryPerson: SeatMember?

    /// Parses the backend's ISO-8601 `activeUntil` timestamp.
    private static let coverageDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private let maxMembersToShow: Int = 6
    private var displayedMembers: [ConversationMember] {
        let sortedMembers = viewModel.conversation.members.sortedByRole()
        return Array(sortedMembers.prefix(maxMembersToShow))
    }
    private var showViewAllMembers: Bool {
        viewModel.conversation.members.count > maxMembersToShow
    }

    @ViewBuilder
    private var assistantSection: some View {
        if viewModel.conversation.hasEverHadVerifiedAssistant {
            Section {
                filesAndLinksRow
            }
        }
    }

    private var convoCodeSection: some View {
        Section {
            convoCodeRow

            lockRow
        }
    }

    @ViewBuilder
    private var filesAndLinksRow: some View {
        NavigationLink {
            AssistantFilesLinksView(
                repository: viewModel.makeAssistantFilesLinksRepository()
            )
        } label: {
            FeatureRowItem(
                imageName: nil,
                symbolName: "folder",
                title: "Files & Links",
                subtitle: "Managed by Assistants",
                iconBackgroundColor: .colorFillMinimal,
                iconForegroundColor: .colorTextPrimary
            ) {
                EmptyView()
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("files-links-row")
    }

    @ViewBuilder
    private var convoCodeRow: some View {
        if viewModel.isLocked && !viewModel.isCurrentUserSuperAdmin {
            EmptyView()
        } else {
            let isUnavailable = viewModel.isLocked || viewModel.isFull
            let subtitle = if isUnavailable {
                "None"
            } else {
                "\(ConfigManager.shared.currentEnvironment.relyingPartyIdentifier)/\(viewModel.invite.urlSlug)"
            }

            if !isUnavailable, let inviteURL = viewModel.invite.inviteURL {
                ShareLink(item: inviteURL) {
                    convoCodeRowContent(subtitle: subtitle, showShareIcon: true)
                }
                .buttonStyle(.plain)
            } else {
                convoCodeRowContent(subtitle: subtitle, showShareIcon: false)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if viewModel.isFull {
                            showingFullInfo = true
                        }
                    }
                    .opacity(viewModel.isLocked ? 0.5 : 1.0)
            }
        }
    }

    @ViewBuilder
    private func convoCodeRowContent(subtitle: String, showShareIcon: Bool) -> some View {
        HStack(spacing: DesignConstants.Spacing.step2x) {
            Group {
                Image(systemName: "qrcode")
                    .font(.headline)
                    .padding(.horizontal, DesignConstants.Spacing.step2x)
                    .padding(.vertical, 10.0)
                    .foregroundStyle(viewModel.isFull ? .colorTextSecondary : .colorTextPrimary)
            }
            .frame(width: 40.0, height: 40.0)
            .background(
                RoundedRectangle(cornerRadius: DesignConstants.CornerRadius.regular)
                    .fill(Color.colorFillMinimal)
                    .aspectRatio(1.0, contentMode: .fit)
            )

            VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                Text("Gold code")
                    .font(.body)
                    .foregroundStyle(.colorTextPrimary)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.colorTextSecondary)
                    .lineLimit(1)
            }

            Spacer()

            if showShareIcon {
                Image(systemName: "square.and.arrow.up")
                    .foregroundStyle(.colorTextSecondary)
            }
        }
    }

    @ViewBuilder
    private var lockRow: some View {
        if viewModel.isCurrentUserSuperAdmin {
            FeatureRowItem(
                imageName: nil,
                symbolName: "lock.fill",
                title: "Lock",
                subtitle: "Nobody new can join",
                iconBackgroundColor: .colorFillMinimal,
                iconForegroundColor: .colorTextPrimary
            ) {
                Toggle("", isOn: Binding(
                    get: { viewModel.isLocked },
                    set: { _ in
                        showingLockedInfo = true
                    }
                ))
                .labelsHidden()
                .accessibilityLabel("Lock conversation")
                .accessibilityValue(viewModel.isLocked ? "locked" : "unlocked")
                .accessibilityIdentifier("lock-toggle")
            }
        }
    }

    private var headerSection: some View {
        Section {
            HStack {
                Spacer()
                VStack(spacing: DesignConstants.Spacing.step4x) {
                    ConversationAvatarView(
                        conversation: viewModel.conversation,
                        conversationImage: viewModel.conversationImage
                    )
                    .frame(width: 160.0, height: 160.0)

                    VStack(spacing: DesignConstants.Spacing.step2x) {
                        Text(viewModel.conversation.computedDisplayName)
                            .font(.largeTitle.weight(.semibold))
                            .foregroundStyle(.colorTextPrimary)
                            .multilineTextAlignment(.center)
                        if !viewModel.conversationDescription.isEmpty {
                            Text(viewModel.conversationDescription)
                                .font(.subheadline)
                        }

                        Button {
                            presentingEditView = true
                        } label: {
                            Text("Edit info")
                                .font(.caption)
                                .foregroundStyle(.colorTextSecondary)
                        }
                        .buttonStyle(.bordered)
                        .hoverEffect(.lift)
                        .padding(.top, DesignConstants.Spacing.step2x)
                        .accessibilityLabel("Edit conversation info")
                        .accessibilityIdentifier("edit-info-button")
                        .sheet(isPresented: $presentingEditView) {
                            ConversationInfoEditView(viewModel: viewModel, focusCoordinator: focusCoordinator)
                        }
                    }
                }
                Spacer()
            }
            .listRowBackground(Color.clear)
        }
        .listSectionMargins(.top, 0.0)
        .listSectionSeparator(.hidden)
    }

    private var membersSection: some View {
        Section {
            NavigationLink {
                ConversationMembersListView(viewModel: viewModel)
            } label: {
                HStack {
                    Text(viewModel.conversation.membersCountString)
                        .foregroundStyle(.colorTextPrimary)
                    Spacer()
                    if viewModel.isFull {
                        Text("Full")
                            .foregroundStyle(.colorTextSecondary)
                    } else if viewModel.conversation.members.count > 100 {
                        Text("\(Conversation.maxMembers) max")
                            .foregroundStyle(.colorTextSecondary)
                    }
                }
            }
        }
    }

    /// True when this conversation is the viewer's own Advisory or Reports
    /// chat — the two places the encrypted people list + coverage are
    /// surfaced. Both channels carry the same information so the client
    /// can review it from whichever chat they happen to have open.
    private var isOwnGoldilocksClientChannel: Bool {
        guard viewModel.conversation.goldilocksPinnedSection == .client else { return false }
        let name: String = viewModel.conversation.name ?? ""
        return name.hasPrefix("Advisory") || name.hasPrefix("Reports")
    }

    /// Coverage end-date, decrypted-people-list, and billing roll-up.
    /// Admin-only: clients manage their own roster from the Membership
    /// screen instead of inside a chat. Limited to the viewer's own
    /// Advisory / Reports chat because that's the only client list we
    /// hold locally; an admin who wants to manage a different client
    /// goes through `AdminChannelsView`.
    @ViewBuilder
    private var peopleAndCoverageSection: some View {
        if isOwnGoldilocksClientChannel && GoldilocksConfig.role == .admin {
            Section {
                HStack {
                    Text("Coverage")
                        .foregroundStyle(.colorTextPrimary)
                    Spacer()
                    Text(coverageSummary)
                        .font(.footnote)
                        .foregroundStyle(.colorTextSecondary)
                }
                if seatPlan.members.isEmpty {
                    Text("No people added yet.")
                        .foregroundStyle(.colorTextSecondary)
                } else {
                    ForEach(seatPlan.members) { member in
                        advisoryPersonRow(member)
                    }
                }
            } header: {
                Text("People & coverage")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.colorTextSecondary)
            } footer: {
                Text("Tap a person to view their info or toggle their coverage.")
                    .font(.caption)
                    .foregroundStyle(.colorTextSecondary)
            }
            .sheet(item: $selectedAdvisoryPerson) { member in
                AdvisoryPersonSheet(
                    member: member,
                    enabled: advisoryEnabledBinding(for: member.id)
                )
            }
        }
    }

    /// One row per person. Name on the left, a "Disabled" pill under it
    /// when off the bill, and a chevron on the right. Tapping opens the
    /// person sheet — the row deliberately doesn't carry the toggle so
    /// the primary action is unambiguous.
    private func advisoryPersonRow(_ member: SeatMember) -> some View {
        let name: String = member.name.isEmpty ? "Unnamed" : member.name
        let tapAction = { selectedAdvisoryPerson = member }
        return Button(action: tapAction) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
                    Text(name)
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

    /// Binding the AdvisoryPersonSheet's Toggle reads + writes through.
    /// Looking the member up by id every read keeps the toggle in lock-
    /// step with the seat plan even if the snapshot the sheet was
    /// opened with goes stale.
    private func advisoryEnabledBinding(for id: UUID) -> Binding<Bool> {
        Binding(
            get: { seatPlan.members.first(where: { $0.id == id })?.enabled ?? false },
            set: { newValue in
                guard let index = seatPlan.members.firstIndex(where: { $0.id == id }) else { return }
                seatPlan.members[index].enabled = newValue
                Task { await viewModel.saveGoldilocksPeopleList() }
            }
        )
    }

    private var coverageSummary: String {
        guard let coverage = advisoryCoverage else { return "Loading…" }
        guard let activeUntil = coverage.activeUntil,
              let date = Self.coverageDateFormatter.date(from: activeUntil) else {
            return "No active coverage"
        }
        return "Active until \(date.formatted(date: .abbreviated, time: .omitted))"
    }

    private var convoRulesSection: some View {
        Section {
            FeatureRowItem(
                imageName: nil,
                symbolName: "timer",
                title: "Disappear",
                subtitle: "Messages"
            ) {
                SoonLabel()
            }
        } header: {
            Text("Convo rules")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.colorTextSecondary)
        }
    }

    var body: some View {
        infoContent
    }

    private var vanishSection: some View {
        Section {
            HStack {
                Text("Vanish")
                    .foregroundStyle(.colorTextPrimary)
                Spacer()
                SoonLabel()
            }
        } footer: {
            Text("Choose when this convo disappears from your device")
                .foregroundStyle(.colorTextSecondary)
        }
        .disabled(true)
    }

    private var permissionsSection: some View {
        Section {
            NavigationLink {
                EmptyView()
            } label: {
                HStack {
                    Text("Permissions")
                        .foregroundStyle(.colorTextPrimary)
                    Spacer()
                    SoonLabel()
                }
            }
            .disabled(true)
        } footer: {
            Text("Choose who can manage the group")
                .foregroundStyle(.colorTextSecondary)
        }
    }

    private var infoList: some View {
        List {
            headerSection

            membersSection

            peopleAndCoverageSection

            assistantSection

            if FeatureFlags.shared.isCloudConnectionsEnabled,
               let connectionsViewModel,
               connectionsViewModel.hasConnections {
                ConversationConnectionsSection(viewModel: connectionsViewModel)
            }

            convoCodeSection

            if viewModel.canRemoveMembers {
                Section {
                    ExplodeInfoRow(
                        scheduledExplosionDate: viewModel.scheduledExplosionDate,
                        onTap: { showingExplodeSheet = true },
                        onExplodeNow: { viewModel.explodeConvo() }
                    )
                }
            }

            ConversationPreferencesSection(viewModel: viewModel)

            convoRulesSection

            vanishSection

            permissionsSection

            debugInfoSection
        }
    }

    @ViewBuilder
    private var debugInfoSection: some View {
        if !ConfigManager.shared.currentEnvironment.isProduction {
            Section {
                HStack {
                    Text("Fork status")
                    Spacer()
                    Text(viewModel.conversation.debugInfo.commitLogForkStatus.rawValue)
                        .foregroundStyle(.colorTextSecondary)
                }
                HStack {
                    Text("Epoch")
                    Spacer()
                    Text("\(viewModel.conversation.debugInfo.epoch)")
                        .foregroundStyle(.colorTextSecondary)
                }
                NavigationLink {
                    DebugLogsTextView(logs: viewModel.conversation.debugInfo.forkDetails)
                } label: {
                    Text("Fork details")
                }
                NavigationLink {
                    DebugLogsTextView(logs: viewModel.conversation.debugInfo.localCommitLog)
                } label: {
                    Text("Local commit log")
                }
                NavigationLink {
                    DebugLogsTextView(logs: viewModel.conversation.debugInfo.remoteCommitLog)
                } label: {
                    Text("Remote commit log")
                }
                NavigationLink {
                    DebugLogsTextView(logs: metadataDebugText)
                        .task {
                            metadataDebugText = await viewModel.conversationMetadataDebugText()
                        }
                } label: {
                    Text("Metadata")
                }
                Button {
                    showingRestoreInviteTagAlert = true
                } label: {
                    Text("Restore invite tag")
                }
                if let url = exportedLogsURL {
                    ShareLink(item: url) {
                        HStack {
                            Text("Share logs")
                            Spacer()
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                } else {
                    HStack {
                        Text("Preparing logs…")
                        Spacer()
                        ProgressView()
                    }
                    .foregroundStyle(.colorTextSecondary)
                }
            } header: {
                Text("Debug info")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.colorTextSecondary)
            }
            .task {
                do {
                    exportedLogsURL = try await viewModel.exportDebugLogs()
                } catch {
                    Log.error("Failed to export logs for conversation: \(error.localizedDescription)")
                }
            }
        }
    }

    private var navigationBarContent: some ToolbarContent {
        Group {
            ToolbarItem(placement: .topBarLeading) {
                Button(role: .cancel) {
                    dismiss()
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if viewModel.isLocked {
                    Button {
                        showingLockedInfo = true
                    } label: {
                        Image(systemName: "lock.fill")
                            .foregroundStyle(.colorTextSecondary)
                    }
                    .accessibilityLabel("Conversation locked")
                    .accessibilityIdentifier("info-lock-button")
                } else {
                    AddToConversationMenu(
                        isFull: viewModel.isFull,
                        hasAssistant: viewModel.conversation.hasAgent,
                        isEnabled: true,
                        onConvoCode: {
                            if viewModel.isFull {
                                showingFullInfo = true
                            } else {
                                presentingShareView = true
                            }
                        },
                        onCopyLink: {
                            viewModel.copyInviteLink()
                        },
                        onInviteAssistant: {
                            viewModel.requestAssistantJoin()
                        }
                    )
                    .accessibilityIdentifier("info-add-button")
                }
            }
        }
    }

    private var infoContent: some View {
        NavigationStack {
            infoList
                .task {
                    if FeatureFlags.shared.isCloudConnectionsEnabled, connectionsViewModel == nil {
                        connectionsViewModel = viewModel.makeConversationConnectionsViewModel()
                    }
                }
                .task {
                    if isOwnGoldilocksClientChannel {
                        advisoryCoverage = await viewModel.loadGoldilocksAdvisoryInfo()
                    }
                }
                .alert("Restore invite tag", isPresented: $showingRestoreInviteTagAlert) {
                    TextField("Invite tag", text: $restoreInviteTagText)
                    Button("Cancel", role: .cancel) {
                        restoreInviteTagText = ""
                    }
                    Button("Restore") {
                        let expectedTag = restoreInviteTagText
                        restoreInviteTagText = ""
                        Task {
                            do {
                                try await viewModel.restoreInviteTagIfMissing(expectedTag)
                                metadataDebugText = await viewModel.conversationMetadataDebugText()
                            } catch {
                                let refreshedDebugText = await viewModel.conversationMetadataDebugText()
                                metadataDebugText = "Restore failed: \(error.localizedDescription)\n\n\(refreshedDebugText)"
                            }
                        }
                    }
                } message: {
                    Text("Only use this if you know the expected invite tag for this convo.")
                }
                .scrollContentBackground(.hidden)
                .background(.colorBackgroundRaisedSecondary)
                .toolbarTitleDisplayMode(.inline)
                .toolbar { navigationBarContent }
                .selfSizingSheet(isPresented: $showingLockedInfo) {
                    LockedConvoInfoView(
                        isCurrentUserSuperAdmin: viewModel.isCurrentUserSuperAdmin,
                        isLocked: viewModel.isLocked,
                        onLock: {
                            viewModel.toggleLock()
                            showingLockedInfo = false
                        },
                        onDismiss: {
                            showingLockedInfo = false
                        }
                    )
                }
                .selfSizingSheet(isPresented: $showingFullInfo) {
                    FullConvoInfoView(onDismiss: {
                        showingFullInfo = false
                    })
                }
                .overlay {
                    if presentingShareView {
                        ConversationShareOverlay(
                            conversation: viewModel.conversation,
                            invite: viewModel.invite,
                            isPresented: $presentingShareView,
                            topSafeAreaInset: 0
                        )
                    }
                }
                .background {
                    Color.clear
                        .fullScreenCover(isPresented: $showingExplodeSheet) {
                            ExplodeConvoSheet(
                                isScheduled: viewModel.scheduledExplosionDate != nil,
                                onSchedule: { date in
                                    viewModel.scheduleExplosion(at: date)
                                    showingExplodeSheet = false
                                },
                                onExplodeNow: {
                                    viewModel.explodeConvo()
                                },
                                onDismiss: {
                                    showingExplodeSheet = false
                                }
                            )
                            .presentationBackground(.clear)
                        }
                        .transaction { transaction in
                            transaction.disablesAnimations = true
                        }
                }
        }
    }
}

struct DebugLogsTextView: View {
    let logs: String
    var body: some View {
        VStack {
            ScrollView {
                ScrollViewReader { proxy in
                    LazyVStack(alignment: .leading, spacing: 0) {
                        Text(logs)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.primary)
                            .padding()
                            .id("logs")
                    }
                    .onChange(of: logs) {
                        withAnimation(.easeOut(duration: 0.3)) {
                            proxy.scrollTo("logs", anchor: .bottom)
                        }
                    }
                }
            }
        }
    }
}

private struct ConversationPreferencesSection: View {
    @Bindable var viewModel: ConversationViewModel

    var body: some View {
        Section {
            FeatureRowItem(
                imageName: nil,
                symbolName: "bell.fill",
                title: "Notifications",
                subtitle: nil
            ) {
                Toggle("", isOn: $viewModel.notificationsEnabled)
                    .labelsHidden()
                    .accessibilityLabel("Notifications")
                    .accessibilityValue(viewModel.notificationsEnabled ? "on" : "off")
                    .accessibilityIdentifier("notifications-toggle")
            }

            FeatureRowItem(
                imageName: nil,
                symbolName: "eye",
                title: "Read receipts",
                subtitle: "Let others know you've read"
            ) {
                Toggle("", isOn: Binding(
                    get: { viewModel.sendReadReceipts },
                    set: { viewModel.setSendReadReceipts($0) }
                ))
                .labelsHidden()
                .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .onTapGesture {
                viewModel.setSendReadReceipts(!viewModel.sendReadReceipts)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Read receipts")
            .accessibilityValue(viewModel.sendReadReceipts ? "on" : "off")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("convo-read-receipts-toggle")

            FeatureRowItem(
                imageName: nil,
                symbolName: "eye.circle.fill",
                title: "Reveal mode",
                subtitle: "Blur incoming pics"
            ) {
                Toggle("", isOn: Binding(
                    get: { !viewModel.autoRevealPhotos },
                    set: { viewModel.setAutoReveal(!$0) }
                ))
                .labelsHidden()
            }

            FeatureRowItem(
                imageName: nil,
                symbolName: "eyeglasses",
                title: "Peek-a-boo",
                subtitle: "Blur when people peek"
            ) {
                SoonLabel()
            }

            FeatureRowItem(
                imageName: nil,
                symbolName: "tray.fill",
                title: "Allow DMs",
                subtitle: "From group members"
            ) {
                SoonLabel()
            }

            FeatureRowItem(
                imageName: nil,
                symbolName: "faceid",
                title: "Require FaceID",
                subtitle: "Or passcode"
            ) {
                SoonLabel()
            }
        } header: {
            Text("Personal preferences")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.colorTextSecondary)
        }
    }
}

/// Admin-side companion to the client's `MemberEditSheet`. Name and
/// email are owned by the client (set when they verify the person), so
/// both are read-only here. The one admin lever is the enabled toggle,
/// which acts as a kill switch on the third-party subscription and the
/// per-client billing rate.
private struct AdvisoryPersonSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction

    let member: SeatMember
    @Binding var enabled: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Name") {
                        Text(member.name.isEmpty ? "Unnamed" : member.name)
                            .foregroundStyle(.colorTextSecondary)
                    }
                    LabeledContent("Email") {
                        Text(member.email)
                            .foregroundStyle(.colorTextSecondary)
                    }
                } footer: {
                    Text("The client owns this person's name and email. Reach out to them if either needs to change.")
                }

                Section {
                    Toggle("Enabled", isOn: $enabled)
                } footer: {
                    Text("Enabled people are subscribed to the service and count toward this client's monthly rate.")
                }
            }
            .navigationTitle("Person")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let doneAction = { dismiss() }
                    Button("Done", action: doneAction)
                }
            }
        }
    }
}

#Preview {
    @Previewable @State var viewModel: ConversationViewModel = .mock
    @Previewable @State var focusCoordinator: FocusCoordinator = FocusCoordinator(horizontalSizeClass: nil)
    ConversationInfoView(viewModel: viewModel, focusCoordinator: focusCoordinator)
}
