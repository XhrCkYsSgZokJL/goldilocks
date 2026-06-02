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
    @State private var selectedPerson: SeatMember?
    @State private var emeraldChannel: ConvosAPI.GoldilocksAdminChannel?
    private let maxMembersToShow: Int = 6
    private var displayedMembers: [ConversationMember] {
        let sortedMembers = viewModel.conversation.members.sortedByRole(creatorInboxId: viewModel.conversation.creator.profile.inboxId)
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

            PeopleAndCoverageSection(viewModel: viewModel, selectedPerson: $selectedPerson)

            AdminEmeraldTierSection(viewModel: viewModel, channel: $emeraldChannel)

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
        .sheet(item: $selectedPerson) { member in
            AdvisoryPersonSheet(
                member: member,
                enabled: personEnabledBinding(for: member.id)
            )
        }
    }

    private func personEnabledBinding(for id: UUID) -> Binding<Bool> {
        let seatPlan: GoldilocksSeatPlan = GoldilocksSeatPlan.shared
        return Binding(
            get: { seatPlan.members.first(where: { $0.id == id })?.enabled ?? false },
            set: { newValue in
                guard let index = seatPlan.members.firstIndex(where: { $0.id == id }) else { return }
                seatPlan.members[index].enabled = newValue
                Task { await viewModel.saveGoldilocksPeopleList() }
            }
        )
    }

    private func loadEmeraldChannelIfNeeded() async {
        guard GoldilocksConfig.role == .admin else {
            Log.info("[Emerald] skipped: role is not admin (role=\(GoldilocksConfig.role))")
            return
        }
        let name: String = viewModel.conversation.name ?? ""
        guard name.hasPrefix("Advisory") else {
            Log.info("[Emerald] skipped: conversation name '\(name)' does not start with Advisory")
            return
        }
        Log.info("[Emerald] parent loading admin channel for conversation \(viewModel.conversation.id)")
        emeraldChannel = await viewModel.loadAdminChannelForCurrentConversation()
        if let emeraldChannel {
            Log.info("[Emerald] loaded channel: clientNumber=\(emeraldChannel.clientNumber) emerald=\(emeraldChannel.emeraldMembershipEnabled)")
        } else {
            Log.warning("[Emerald] no matching admin channel found for conversation \(viewModel.conversation.id)")
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
                    await loadEmeraldChannelIfNeeded()
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

/// Admin-side companion to the client's `PersonEditorSheet`. Name and
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
                identitySection
                emailsSection
                if !member.phone.isEmpty {
                    phoneSection
                }
                if !member.address.isEmpty {
                    addressSection
                }
                enabledSection
            }
            .scrollContentBackground(.hidden)
            .background(.colorBackgroundRaisedSecondary)
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

    private var identitySection: some View {
        Section {
            LabeledContent("First name") {
                Text(member.firstName.isEmpty ? "—" : member.firstName)
                    .foregroundStyle(.colorTextSecondary)
            }
            if !member.middleName.isEmpty {
                LabeledContent("Middle name") {
                    Text(member.middleName)
                        .foregroundStyle(.colorTextSecondary)
                }
            }
            LabeledContent("Last name") {
                Text(member.lastName.isEmpty ? "—" : member.lastName)
                    .foregroundStyle(.colorTextSecondary)
            }
        } footer: {
            Text("The client owns this person's name and contact info. Reach out to them if anything needs to change.")
        }
    }

    private var emailsSection: some View {
        Section {
            if member.emails.isEmpty {
                Text("No emails on file")
                    .foregroundStyle(.colorTextSecondary)
            } else {
                ForEach(member.emails) { email in
                    emailRow(email)
                }
            }
        } header: {
            Text("Emails")
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
            } else {
                Text("Unverified")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.colorTextTertiary)
            }
        }
    }

    private var phoneSection: some View {
        Section {
            LabeledContent("Phone") {
                Text(member.phone)
                    .foregroundStyle(.colorTextSecondary)
            }
        }
    }

    private var addressSection: some View {
        Section {
            Text(member.address.singleLine)
                .foregroundStyle(.colorTextSecondary)
        } header: {
            Text("Address")
        }
    }

    private var enabledSection: some View {
        Section {
            Toggle("Enabled", isOn: $enabled)
        } footer: {
            Text("Enabled people are subscribed to the service and count toward this client's monthly rate.")
        }
    }
}

#Preview {
    @Previewable @State var viewModel: ConversationViewModel = .mock
    @Previewable @State var focusCoordinator: FocusCoordinator = FocusCoordinator(horizontalSizeClass: nil)
    ConversationInfoView(viewModel: viewModel, focusCoordinator: focusCoordinator)
}

/// Admin-only Emerald toggle that appears at the top of a client
/// Advisory chat's info screen. Extracted into its own view so
/// `ConversationInfoView` stays under SwiftLint's type-body-length
/// cap, and so the section's state (the fetched admin-channel row +
/// the toggle's in-flight saving / error flags) doesn't pollute the
/// parent's already-large state surface. Self-loads its data on
/// appear and self-refetches after every toggle.
private struct AdminEmeraldTierSection: View {
    let viewModel: ConversationViewModel
    @Binding var channel: ConvosAPI.GoldilocksAdminChannel?

    @State private var saving: Bool = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if GoldilocksConfig.role == .admin, let channel {
                Section {
                    toggleRow(for: channel)
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Tier override")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.colorTextSecondary)
                } footer: {
                    Text("Emerald overrides automatic tier selection.")
                        .font(.caption)
                        .foregroundStyle(.colorTextSecondary)
                }
            }
        }
        .task { await loadChannelIfAdmin() }
    }

    private func toggleRow(for channel: ConvosAPI.GoldilocksAdminChannel) -> some View {
        HStack {
            Text("Emerald membership")
                .foregroundStyle(.colorTextPrimary)
            Spacer()
            Toggle("", isOn: binding(for: channel))
                .labelsHidden()
                .disabled(saving)
                .opacity(saving ? 0.4 : 1.0)
        }
    }

    private func binding(for channel: ConvosAPI.GoldilocksAdminChannel) -> Binding<Bool> {
        Binding(
            get: { channel.emeraldMembershipEnabled },
            set: { newValue in
                Task { await setEmerald(to: newValue, for: channel) }
            }
        )
    }

    private func loadChannelIfAdmin() async {
        guard GoldilocksConfig.role == .admin else {
            Log.info("[Emerald] skipped: role is not admin (role=\(GoldilocksConfig.role))")
            return
        }
        let name: String = viewModel.conversation.name ?? ""
        guard name.hasPrefix("Advisory") else {
            Log.info("[Emerald] skipped: conversation name '\(name)' does not start with Advisory")
            return
        }
        Log.info("[Emerald] loading admin channel for conversation \(viewModel.conversation.id)")
        let loaded: ConvosAPI.GoldilocksAdminChannel? = await viewModel.loadAdminChannelForCurrentConversation()
        channel = loaded
        if let loaded {
            Log.info("[Emerald] loaded channel: clientNumber=\(loaded.clientNumber) emerald=\(loaded.emeraldMembershipEnabled)")
        } else {
            Log.warning("[Emerald] no matching admin channel found for conversation \(viewModel.conversation.id)")
        }
    }

    private func setEmerald(
        to newValue: Bool,
        for channel: ConvosAPI.GoldilocksAdminChannel
    ) async {
        saving = true
        errorMessage = nil
        let result: Bool? = await viewModel.setAdvisoryEmeraldMembership(
            clientInboxId: channel.clientInboxId,
            enabled: newValue
        )
        if result != nil {
            self.channel = await viewModel.loadAdminChannelForCurrentConversation()
            await viewModel.refreshGoldilocksIdentity()
        } else {
            errorMessage = "Couldn't update Emerald membership."
        }
        saving = false
    }
}

/// Coverage end-date + decrypted-people-list section that appears in
/// an admin's view of their own Advisory or Reports chat. Extracted
/// from `ConversationInfoView` so the parent struct stays under the
/// type-body-length cap and the section's transient state
/// (the loaded billing snapshot + the in-flight person sheet) stops
/// polluting the parent's already-large @State surface.
///
/// Limited to the viewer's own client channels because that's the
/// only people list we hold the decryption key for locally — an
/// admin who wants to manage a different client goes through
/// `AdminChannelsView` → `AdminClientPeopleListView`.
private struct PeopleAndCoverageSection: View {
    let viewModel: ConversationViewModel
    @Binding var selectedPerson: SeatMember?

    @State private var seatPlan: GoldilocksSeatPlan = GoldilocksSeatPlan.shared
    @State private var coverage: ConvosAPI.GoldilocksBillingStatusResponse?

    private static let coverageDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    var body: some View {
        Group {
            if shouldShow {
                Section {
                    coverageRow
                    if seatPlan.members.isEmpty {
                        Text("No people added yet.")
                            .foregroundStyle(.colorTextSecondary)
                    } else {
                        ForEach(seatPlan.members) { member in
                            personRow(member)
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
            }
        }
        .task {
            if shouldShow {
                coverage = await viewModel.loadGoldilocksAdvisoryInfo()
            }
        }
    }

    private var shouldShow: Bool {
        guard GoldilocksConfig.role == .admin else { return false }
        guard viewModel.conversation.goldilocksPinnedSection == .client else { return false }
        let name: String = viewModel.conversation.name ?? ""
        return name.hasPrefix("Advisory") || name.hasPrefix("Reports")
    }

    private var coverageRow: some View {
        HStack {
            Text("Coverage")
                .foregroundStyle(.colorTextPrimary)
            Spacer()
            Text(coverageSummary)
                .font(.footnote)
                .foregroundStyle(.colorTextSecondary)
        }
    }

    private var coverageSummary: String {
        guard let coverage else { return "Loading…" }
        guard let activeUntil = coverage.activeUntil,
              let date = Self.coverageDateFormatter.date(from: activeUntil) else {
            return "No active coverage"
        }
        return "Active until \(date.formatted(date: .abbreviated, time: .omitted))"
    }

    private func personRow(_ member: SeatMember) -> some View {
        let name: String = member.firstName.isEmpty ? member.displayName : member.firstName
        let tapAction = { selectedPerson = member }
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
}
