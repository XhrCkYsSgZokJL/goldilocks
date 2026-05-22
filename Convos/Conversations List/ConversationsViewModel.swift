import Combine
import ConvosCore
import Foundation
import Observation
import SwiftUI
import UIKit
import UserNotifications

@MainActor
@Observable
final class ConversationsViewModel {
    // MARK: - Public

    private(set) var focusCoordinator: FocusCoordinator

    // MARK: - Selection State

    @ObservationIgnored
    private var _selectedConversationId: String? {
        didSet {
            updateSelectionState()
        }
    }

    var selectedConversationId: Conversation.ID? {
        get { _selectedConversationId }
        set {
            guard _selectedConversationId != newValue else { return }
            _selectedConversationId = newValue
        }
    }

    private(set) var selectedConversation: Conversation? {
        get {
            guard let id = _selectedConversationId else { return nil }
            return conversations.first(where: { $0.id == id })
        }
        set {
            selectedConversationId = newValue?.id
        }
    }

    private(set) var selectedConversationViewModel: ConversationViewModel?

    @ObservationIgnored
    private var updateSelectionTask: Task<Void, Never>?

    private func updateSelectionState() {
        let conversation = selectedConversation
        let previousViewModelId = selectedConversationViewModel?.conversation.id

        if let conversation = conversation {
            if selectedConversationViewModel?.conversation.id != conversation.id {
                updateSelectionTask?.cancel()
                let viewModel = ConversationViewModel.createSync(
                    conversation: conversation,
                    session: session
                )
                selectedConversationViewModel = viewModel
                markConversationAsRead(conversation)
            }
        } else {
            if let previousViewModel = selectedConversationViewModel {
                markConversationAsRead(previousViewModel.conversation)
            }
            updateSelectionTask?.cancel()
            selectedConversationViewModel = nil
        }

        if previousViewModelId != _selectedConversationId {
            let userInfo: [AnyHashable: Any] = _selectedConversationId.map { ["conversationId": $0] } ?? [:]
            NotificationCenter.default.post(
                name: .activeConversationChanged,
                object: nil,
                userInfo: userInfo
            )
        }

        updateListVisibility()
    }

    var pendingGrantRequest: PendingGrantRequest?

    var newConversationViewModel: NewConversationViewModel? {
        didSet {
            oldValue?.cleanUpIfNeeded()
            if newConversationViewModel == nil {
                NotificationCenter.default.post(
                    name: .activeConversationChanged,
                    object: nil,
                    userInfo: [:]
                )
            }
            updateListVisibility()
        }
    }
    var presentingExplodeInfo: Bool = false
    var presentingPinLimitInfo: Bool = false

    var conversations: [Conversation] = []
    private(set) var hiddenConversationIds: Set<String> = []
    private var conversationsCount: Int = 0 {
        didSet {
            if conversationsCount > 1 {
                hasCreatedMoreThanOneConvo = true
            }
        }
    }

    enum ConversationFilter {
        case all
        case unread
        case exploding

        var emptyStateMessage: String {
            switch self {
            case .all:
                return "No convos"
            case .unread:
                return "No unread convos"
            case .exploding:
                return "No exploding convos"
            }
        }
    }

    var activeFilter: ConversationFilter = .all

    var pinnedConversations: [Conversation] {
        // The Goldilocks group is rendered as a standard row at the top of
        // the unpinned list — not as a "pinned tile" — so we exclude it here
        // even if the DB happens to flag it pinned (e.g. carryover from
        // earlier dev iterations).
        // One typed predicate instead of six chained `.filter` calls —
        // the chain blew past the type-checker's time budget.
        let baseConversations: [Conversation] = conversations
            .filter { (c: Conversation) -> Bool in
                c.isVisibleInCurrentRole
                    && c.isPinned
                    && c.kind == .group
                    && !c.isGoldilocksGroup
                    && !c.isStaleGoldilocksChannel
                    && !c.isEmptyPlaceholderConversation
            }
            .sorted { ($0.pinnedOrder ?? Int.max) < ($1.pinnedOrder ?? Int.max) }

        switch activeFilter {
        case .all:
            return baseConversations
        case .unread:
            return baseConversations.filter { $0.isUnread }
        case .exploding:
            return baseConversations.filter { $0.scheduledExplosionDate != nil }
        }
    }

    var unpinnedConversations: [Conversation] {
        // Include unpinned groups + the Goldilocks groups (regardless of
        // their pin flag), with Goldilocks always sorted to the front in
        // the order declared in `GoldilocksConfig.groupNames`.
        // One typed predicate instead of five chained `.filter` calls — the
        // chain was heavy for the type-checker. `isPinnedGoldilocksGroup`
        // overrides the stored `isPinned` for sort-to-top (admins: only
        // Admins; clients: Advisory + Reports); other rows flow with the
        // regular recency order.
        let baseConversations: [Conversation] = conversations
            .filter { (c: Conversation) -> Bool in
                c.isVisibleInCurrentRole
                    && c.kind == .group
                    && (!c.isPinned || c.isPinnedGoldilocksGroup)
                    && !c.isStaleGoldilocksChannel
                    && !c.isEmptyPlaceholderConversation
            }
            .sorted { lhs, rhs in
                switch (lhs.isPinnedGoldilocksGroup, rhs.isPinnedGoldilocksGroup) {
                case (true, false):
                    return true
                case (false, true):
                    return false
                case (true, true):
                    // Both pinned-Goldilocks. Match each name against the
                    // role's `groupNames` prefixes (since Advisory/Reports
                    // are now suffixed with `#N`) to preserve the
                    // declared ordering.
                    let lIdx = GoldilocksConfig.groupNames.firstIndex(where: { (lhs.name ?? "").hasPrefix($0) }) ?? Int.max
                    let rIdx = GoldilocksConfig.groupNames.firstIndex(where: { (rhs.name ?? "").hasPrefix($0) }) ?? Int.max
                    return lIdx < rIdx
                case (false, false):
                    // Preserve existing order (sort is stable).
                    return false
                }
            }
        switch activeFilter {
        case .all:
            return baseConversations
        case .unread:
            return baseConversations.filter { $0.isUnread }
        case .exploding:
            return baseConversations.filter { $0.scheduledExplosionDate != nil }
        }
    }

    var hasUnpinnedConversations: Bool {
        conversations.contains { !$0.isPinned && $0.kind == .group && $0.isVisibleInCurrentRole }
    }

    var isFilteredResultEmpty: Bool {
        activeFilter != .all && unpinnedConversations.isEmpty && hasUnpinnedConversations
    }

    private static let hasCreatedMoreThanOneConvoKey: String = "hasCreatedMoreThanOneConvo"
    private(set) var hasCreatedMoreThanOneConvo: Bool {
        get {
            UserDefaults.standard.bool(forKey: Self.hasCreatedMoreThanOneConvoKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.hasCreatedMoreThanOneConvoKey)
        }
    }

    static func resetUserDefaults() {
        UserDefaults.standard.removeObject(forKey: hasCreatedMoreThanOneConvoKey)
    }

    // MARK: - Private

    let session: any SessionManagerProtocol
    private let conversationsRepository: any ConversationsRepositoryProtocol
    private let conversationsCountRepository: any ConversationsCountRepositoryProtocol
    @ObservationIgnored
    private var cancellables: Set<AnyCancellable> = .init()
    @ObservationIgnored
    private var leftConversationObserver: Any?

    private var horizontalSizeClass: UserInterfaceSizeClass?

    let appSettingsViewModel: AppSettingsViewModel

    init(
        session: any SessionManagerProtocol,
        horizontalSizeClass: UserInterfaceSizeClass? = nil
    ) {
        self.session = session
        self.horizontalSizeClass = horizontalSizeClass
        let coordinator = FocusCoordinator(horizontalSizeClass: horizontalSizeClass)
        self.focusCoordinator = coordinator
        self.appSettingsViewModel = AppSettingsViewModel(session: session)
        self.conversationsRepository = session.conversationsRepository(
            for: .allowed
        )
        self.conversationsCountRepository = session.conversationsCountRepo(
            for: .allowed,
            kinds: .groups
        )
        do {
            self.conversations = try conversationsRepository.fetchAll()
            self.conversationsCount = try conversationsCountRepository.fetchCount()
            if conversationsCount > 1 {
                hasCreatedMoreThanOneConvo = true
            }
        } catch {
            Log.error("Error fetching conversations: \(error)")
            self.conversations = []
            self.conversationsCount = 0
        }
        observe()
    }

    func updateHorizontalSizeClass(_ sizeClass: UserInterfaceSizeClass?) {
        guard horizontalSizeClass != sizeClass else { return }
        horizontalSizeClass = sizeClass
        focusCoordinator.horizontalSizeClass = sizeClass
    }

    func onAppear() {
        isVisible = true
        updateListVisibility()
        // Kick off the SIWE handshake against the Goldilocks backend on
        // first appearance. Idempotent — GoldilocksSession bails if it's
        // already registered or already in flight.
        Task { [session] in
            await GoldilocksSession.shared.registerIfNeeded(session: session)
        }
    }

    func onDisappear() {
        isVisible = false
        updateListVisibility()
    }

    @ObservationIgnored
    private var isVisible: Bool = false

    private func updateListVisibility() {
        let isFocusedOnList = isVisible
            && selectedConversationViewModel == nil
            && newConversationViewModel == nil
        session.setIsOnConversationsList(isFocusedOnList)
    }

    deinit {
        updateSelectionTask?.cancel()
    }

    func makeGrantRequestSheetViewModel(for request: PendingGrantRequest) -> ConnectionGrantRequestSheetViewModel {
        let conversation = conversations.first(where: { $0.id == request.conversationId })
        return ConnectionGrantRequestSheetViewModel(
            serviceId: request.serviceId,
            conversationId: request.conversationId,
            conversation: conversation,
            session: session
        )
    }

    func handleURL(_ url: URL) {
        guard let destination = DeepLinkHandler.destination(for: url) else {
            return
        }

        switch destination {
        case .joinConversation(inviteCode: let inviteCode):
            join(from: inviteCode)
        case let .connectionGrant(serviceId: serviceId, conversationId: conversationId):
            guard conversations.contains(where: { $0.id == conversationId }) else {
                Log.warning("Dropping connection grant deep link for unknown conversationId")
                return
            }
            _selectedConversationId = conversationId
            pendingGrantRequest = PendingGrantRequest(
                serviceId: serviceId,
                conversationId: conversationId
            )
        }
    }

    /// True only when the Goldilocks group has successfully landed in the
    /// conversations list. The bottom-bar Compose and Scan buttons are
    /// disabled until this flips. We derive it from the observable
    /// `conversations` array so SwiftUI auto-updates when the group lands
    /// (or disappears, if the user later deletes it).
    /// If we have no recipients available at all (empty backend admin list
    /// AND empty static config), we don't gate.
    var canStartNewConversation: Bool {
        // In admin mode the Admins group excludes self, so we gate against
        // the post-filter recipient count, not the raw admin list.
        let backendAdmins = GoldilocksSession.shared.adminInboxIds
        let allAdmins = backendAdmins.isEmpty
            ? GoldilocksConfig.hardcodedRecipientInboxIds
            : backendAdmins
        let selfInboxId = GoldilocksSession.shared.identity?.inboxId
        let usableRecipients: [String]
        if GoldilocksConfig.role == .admin, let selfInboxId {
            usableRecipients = allAdmins.filter { $0 != selfInboxId }
        } else {
            usableRecipients = allAdmins
        }
        // No usable recipients → don't gate. Lets a solo admin still compose.
        guard !usableRecipients.isEmpty else { return true }
        return conversations.contains { $0.isGoldilocksGroup && $0.isVisibleInCurrentRole }
    }

    /// Standard new-conversation flow. Used by the bottom-bar Compose button.
    /// Opens the contact-picker sheet so the user can choose recipients
    /// themselves; nothing Goldilocks-specific happens here.
    func onStartConvo() {
        newConversationViewModel = NewConversationViewModel(
            session: session,
            mode: .newConversation
        )
    }

    /// Legacy hook for the empty-state CTA. The button is now a
    /// non-interactive "Setting up your channels…" spinner — server-side
    /// agents (admins-agent, reports-agent) provision everything on
    /// behalf of the user when they register, and the groups arrive via
    /// XMTP welcomes. Kept as a no-op so callers (and the Debug View
    /// "manual provision" trigger, if added later) don't break.
    func onOpenGoldilocksGroup() {
        Log.info("[Goldilocks] onOpenGoldilocksGroup is a no-op — server agents own provisioning.")
    }

    /// Creates one Goldilocks support group: name it, add Morgan + Tillie,
    /// promote them to super-admin, and demote ourselves to a regular member.
    /// Each step is best-effort; we log and continue on partial failure so
    /// the named group still lands in the conversation list.
    private func createGoldilocksGroup(named name: String, recipients: [String]) async {
        do {
            let messagingService = self.session.messagingService()
            let stateManager = messagingService.conversationStateManager()

            try await stateManager.createConversation()

            // Wait for the state machine to reach .ready before touching the
            // conversation — createConversation() is async and the row
            // doesn't exist in the DB yet at this point.
            var conversationId: String?
            for await state in stateManager.stateSequence {
                switch state {
                case .ready(let result):
                    conversationId = result.conversationId
                case .error(let error):
                    throw error
                default:
                    continue
                }
                if conversationId != nil { break }
            }

            guard let conversationId else {
                Log.error("State machine ended without reaching .ready for \(name)")
                return
            }

            let metadataWriter = stateManager.conversationMetadataWriter

            // Name first — even if addMembers/promote fails later, the group
            // is still correctly labeled.
            try await metadataWriter.updateName(name, for: conversationId)

            // Add members. May fail in local-network dev because the
            // hardcoded recipient inbox_ids only exist on the dev/prod XMTP
            // network. Don't bail — the named, locally-existing group is
            // still useful and we still want backend registration to happen.
            var membersAdded = false
            do {
                try await metadataWriter.addMembers(recipients, to: conversationId)
                membersAdded = true
            } catch {
                Log.warning("Couldn't add recipients to \(name) (continuing): \(error.localizedDescription)")
            }

            // Admin shuffle (only meaningful if member-add succeeded).
            // Promote each recipient to super-admin and then demote ourselves
            // — only if at least one other person ended up as super-admin so
            // the group isn't left adminless.
            var promoted: [String] = []
            if membersAdded {
                for inboxId in recipients {
                    do {
                        try await metadataWriter.promoteToSuperAdmin(inboxId, in: conversationId)
                        promoted.append(inboxId)
                    } catch {
                        Log.warning("Couldn't promote \(inboxId) in \(name): \(error.localizedDescription)")
                    }
                }
                if !promoted.isEmpty, let myInboxId = self.currentInboxId() {
                    do {
                        try await metadataWriter.demoteFromSuperAdmin(myInboxId, in: conversationId)
                    } catch {
                        Log.warning("Couldn't demote self from \(name): \(error.localizedDescription)")
                    }
                }
            }

            // Register the channel with the Goldilocks backend so admins
            // can see it labelled as "<Role> #<clientNumber>". Best-effort:
            // failure here doesn't unwind the XMTP-side group creation.
            do {
                try await session.registerGoldilocksChannel(
                    role: name.lowercased(),
                    xmtpGroupId: conversationId
                )
            } catch {
                Log.warning("Backend failed to register channel '\(name)': \(error.localizedDescription)")
            }

            Log.info("Created Goldilocks group '\(name)' with \(promoted.count) admin(s)")
        } catch {
            Log.error("Failed to create Goldilocks group '\(name)': \(error.localizedDescription)")
        }
    }

    /// The current XMTP inbox ID for this user, if the messaging service is
    /// authorized. Used so we can demote ourselves from super-admin after
    /// creating a Goldilocks group.
    private func currentInboxId() -> String? {
        if case .authorized(let inboxId) = session.messagingService().state {
            return inboxId
        }
        return nil
    }

    func onJoinConvo() {
        newConversationViewModel = NewConversationViewModel(
            session: session,
            mode: .scanner
        )
    }

    private func join(from inviteCode: String) {
        newConversationViewModel = NewConversationViewModel(
            session: session,
            mode: .joinInvite(code: inviteCode)
        )
    }

    func deleteAllData() {
        selectedConversation = nil
        appSettingsViewModel.deleteAllData {}
    }

    func leave(conversation: Conversation) {
        // Goldilocks-managed system channels (Advisory, Reports) are owned
        // by trusted server agents — they auto-restore via the agent's
        // periodic reconcile, so optimistically hiding the row would just
        // leave it gone in the UI until the next data refresh. Bail before
        // touching local state. The explode path is the only way to reset
        // these channels.
        if conversation.isGoldilocksManaged {
            Log.info("Ignoring leave() on Goldilocks-managed conversation \(conversation.id)")
            return
        }

        // Optimistic hide while the consent write lands. Once the DB row's
        // consent flips to .denied, ConversationsRepository filters it out
        // unconditionally, so the hiddenConversationIds fallback is only
        // needed during the in-flight window.
        hiddenConversationIds.insert(conversation.id)
        if let index = conversations.firstIndex(of: conversation) {
            conversations.remove(at: index)
        }
        if selectedConversation == conversation {
            selectedConversation = nil
        }

        let conversationId = conversation.id
        Task { [weak self] in
            guard let self else { return }
            do {
                let writer = session.messagingService().conversationConsentWriter()
                try await writer.delete(conversation: conversation)
                self.hiddenConversationIds.remove(conversationId)
            } catch {
                self.hiddenConversationIds.remove(conversationId)
                Log.error("Failed to persist delete for \(conversationId): \(error.localizedDescription)")
            }
        }
    }

    private func observe() {
        leftConversationObserver = NotificationCenter.default
            .addObserver(forName: .leftConversationNotification, object: nil, queue: .main) { [weak self] notification in
                guard let conversationId = notification.userInfo?["conversationId"] as? String else {
                    return
                }
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    Log.info("Left conversation notification received for conversation: \(conversationId)")
                    // Keep hiding on re-emits — see `leave(conversation:)` and
                    // ConversationViewModel.leaveConvo for the same pattern.
                    hiddenConversationIds.insert(conversationId)
                    conversations.removeAll { $0.id == conversationId }
                    if _selectedConversationId == conversationId {
                        _selectedConversationId = nil
                        selectedConversationViewModel = nil
                    }
                    if newConversationViewModel?.conversationViewModel?.conversation.id == conversationId {
                        newConversationViewModel = nil
                    }
                }
            }

        NotificationCenter.default
            .publisher(for: .explosionNotificationTapped)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.selectedConversation = nil
                self?.presentingExplodeInfo = true
            }
            .store(in: &cancellables)

        NotificationCenter.default
            .publisher(for: .conversationNotificationTapped)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] notification in
                self?.handleConversationNotificationTap(notification)
            }
            .store(in: &cancellables)

        conversationsCountRepository.conversationsCount
            .receive(on: DispatchQueue.main)
            .sink { [weak self] conversationsCount in
                self?.conversationsCount = conversationsCount
            }
            .store(in: &cancellables)
        conversationsRepository.conversationsPublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] conversations in
                guard let self else { return }
                self.conversations = hiddenConversationIds.isEmpty
                    ? conversations
                    : conversations.filter { !hiddenConversationIds.contains($0.id) }

                if let selectedId = _selectedConversationId {
                    if !conversations.contains(where: { $0.id == selectedId }) {
                        // Conversation went away — clear selection.
                        selectedConversationId = nil
                    } else if selectedConversationViewModel?.conversation.id != selectedId {
                        // Conversation just appeared in the list (e.g. just-created
                        // Goldilocks group). Re-resolve the selection so the detail
                        // pane navigates into it.
                        updateSelectionState()
                    }
                }

                if !conversations.contains(where: { !$0.isPinned && $0.kind == .group }) {
                    activeFilter = .all
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default
            .publisher(for: UIApplication.didBecomeActiveNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                if let conversation = self.selectedConversationViewModel?.conversation {
                    self.markConversationAsRead(conversation)
                } else if let conversation = self.newConversationViewModel?.conversationViewModel?.conversation {
                    self.markConversationAsRead(conversation)
                }
            }
            .store(in: &cancellables)
    }

    private func handleConversationNotificationTap(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let inboxId = userInfo["inboxId"] as? String,
              let conversationId = userInfo["conversationId"] as? String else {
            Log.warning("Conversation notification tapped but missing required userInfo")
            return
        }

        Log.info(
            "Handling conversation notification tap for inboxId: \(inboxId), conversationId: \(conversationId)"
        )

        if let conversation = conversations.first(where: { $0.id == conversationId }) {
            Log.info("Found conversation, selecting it")
            selectedConversation = conversation
        } else {
            Log.warning("Conversation \(conversationId) not found in current conversation list")
        }
    }

    func toggleMute(conversation: Conversation) {
        let conversationId = conversation.id
        let currentlyMuted = conversation.isMuted

        Task { [weak self] in
            guard let self else { return }
            do {
                let messagingService = session.messagingService()
                let shouldEnableNotifications = currentlyMuted
                try await messagingService.setConversationNotificationsEnabled(shouldEnableNotifications, for: conversationId)
            } catch {
                Log.error("Failed toggling mute for conversation \(conversationId): \(error.localizedDescription)")
            }
        }
    }

    func toggleReadState(conversation: Conversation) {
        let conversationId = conversation.id
        let currentlyUnread = conversation.isUnread

        Task { [weak self] in
            guard let self else { return }
            do {
                let messagingService = session.messagingService()
                let writer = messagingService.conversationLocalStateWriter()
                try await writer.setUnread(!currentlyUnread, for: conversationId)
            } catch {
                Log.error("Failed toggling read state for conversation \(conversationId): \(error.localizedDescription)")
            }
        }
    }

    func togglePin(conversation: Conversation) {
        let conversationId = conversation.id
        let currentlyPinned = conversation.isPinned

        Task { [weak self] in
            guard let self else { return }
            do {
                let messagingService = session.messagingService()
                let writer = messagingService.conversationLocalStateWriter()
                try await writer.setPinned(!currentlyPinned, for: conversationId)
            } catch ConversationLocalStateWriterError.pinLimitReached {
                await MainActor.run {
                    self.presentingPinLimitInfo = true
                }
            } catch {
                Log.error("Failed toggling pin for conversation \(conversationId): \(error.localizedDescription)")
            }
        }
    }

    private func markConversationAsRead(_ conversation: Conversation) {
        let conversationId = conversation.id

        Task { [weak self] in
            guard let self else { return }
            do {
                let messagingService = session.messagingService()
                let writer = messagingService.conversationLocalStateWriter()
                try await writer.setUnread(false, for: conversationId)
            } catch {
                Log.warning("Failed marking conversation as read: \(error.localizedDescription)")
            }
        }
    }

    func explodeConversation(_ conversation: Conversation) {
        let conversationId = conversation.id
        let memberInboxIds = conversation.members.map { $0.profile.inboxId }
        // Backend ROLE schema is `z.enum(['advisory', 'reports'])`. Pull
        // just the role token from the per-client name (e.g. "Advisory #5"
        // → "advisory"). Returns nil for "Admins" since admin coordination
        // isn't a per-client `client_channels` row.
        let goldilocksRole: String? = {
            guard conversation.isGoldilocksGroup, let name = conversation.name else { return nil }
            if name.hasPrefix("Advisory") { return "advisory" }
            if name.hasPrefix("Reports") { return "reports" }
            return nil
        }()

        hiddenConversationIds.insert(conversationId)
        if selectedConversation == conversation {
            selectedConversation = nil
        }
        conversations.removeAll { $0.id == conversationId }

        Task { [weak self] in
            guard let self else { return }
            do {
                let messagingService = session.messagingService()
                let explosionWriter = messagingService.conversationExplosionWriter()
                try await explosionWriter.explodeConversation(
                    conversationId: conversationId,
                    memberInboxIds: memberInboxIds
                )

                // If this was a canonical Goldilocks channel, mark it
                // exploded on the backend so admins can see the lifecycle.
                if let role = goldilocksRole {
                    do {
                        try await self.session.markGoldilocksChannelExploded(role: role)
                    } catch {
                        Log.warning("Backend failed to mark \(role) exploded: \(error.localizedDescription)")
                    }
                }

                await UNUserNotificationCenter.current().addExplosionNotification(
                    conversationId: conversationId,
                    displayName: conversation.displayName
                )

                NotificationCenter.default.post(
                    name: .conversationExpired,
                    object: nil,
                    userInfo: ["conversationId": conversationId]
                )
                conversation.postLeftConversationNotification()
                self.hiddenConversationIds.remove(conversationId)
                Log.info("Exploded conversation from list: \(conversationId)")
            } catch {
                self.hiddenConversationIds.remove(conversationId)
                Log.error("Error exploding conversation from list: \(error.localizedDescription)")
            }
        }
    }

    func scheduleConversationExplosion(_ conversation: Conversation, at expiresAt: Date) {
        guard conversation.scheduledExplosionDate == nil else {
            Log.warning("Conversation \(conversation.id) already has a scheduled explosion")
            return
        }

        if expiresAt <= Date() {
            explodeConversation(conversation)
            return
        }

        let conversationId = conversation.id

        Task { [weak self] in
            guard let self else { return }
            do {
                let messagingService = session.messagingService()
                let explosionWriter = messagingService.conversationExplosionWriter()
                try await explosionWriter.scheduleExplosion(
                    conversationId: conversationId,
                    expiresAt: expiresAt
                )
                Log.info("Scheduled explosion from list for conversation: \(conversationId) at \(expiresAt)")
            } catch {
                Log.error("Error scheduling explosion from list: \(error.localizedDescription)")
            }
        }
    }
}

extension ConversationsViewModel {
    static var mock: ConversationsViewModel {
        let client = ConvosClient.mock()
        return .init(session: client.session)
    }

    static func preview(conversations: [Conversation]) -> ConversationsViewModel {
        let client = ConvosClient.mock()
        let vm = ConversationsViewModel(session: client.session)
        vm.conversations = conversations
        return vm
    }
}
