import ConvosCore
import ConvosCoreiOS
import Foundation
import Observation

/// One person on the subscription. Each person occupies a single seat at
/// their own plan tier (Light or Active). Entered by the client in the
/// Subscription screen and pushed to their Advisory chat.
struct SeatMember: Codable, Identifiable, Equatable {
    var id: UUID
    var name: String
    var email: String
    var phone: String
    var tier: GoldilocksSubscriptionTier

    init(
        id: UUID = UUID(),
        name: String = "",
        email: String = "",
        phone: String = "",
        tier: GoldilocksSubscriptionTier = .light
    ) {
        self.id = id
        self.name = name
        self.email = email
        self.phone = phone
        self.tier = tier
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, email, phone, tier
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(UUID.self, forKey: .id)
        self.name = try container.decode(String.self, forKey: .name)
        self.email = try container.decode(String.self, forKey: .email)
        self.phone = try container.decode(String.self, forKey: .phone)
        // `tier` was added after the first on-device builds — default any
        // person saved before then to Light so old data still loads.
        self.tier = try container.decodeIfPresent(GoldilocksSubscriptionTier.self, forKey: .tier) ?? .light
    }
}

/// On-device store for the client's subscription people, persisted to
/// UserDefaults. Each person is one seat; the monthly total is the sum of
/// every person's plan tier.
///
/// Stage 1 is purely local — Stripe billing and backend sync are wired in
/// later stages. For now this just holds the configuration so the
/// Subscription screen is fully interactive.
@MainActor
@Observable
final class GoldilocksSeatPlan {
    static let shared: GoldilocksSeatPlan = GoldilocksSeatPlan()

    var members: [SeatMember] {
        didSet { persist() }
    }

    /// The `email|tier` roster entries the active subscription covers,
    /// sorted. `nil` until the client first creates a subscription.
    private(set) var subscribedRoster: [String]? {
        didSet { persist() }
    }

    /// Fingerprint of the people list at the last successful send to the
    /// Advisory chat. `nil` until the first send.
    private(set) var sentFingerprint: String? {
        didSet { persist() }
    }

    /// Total people on the plan (one seat each).
    var totalSeats: Int {
        members.count
    }

    /// Number of people on the Light tier.
    var lightSeats: Int {
        members.filter { $0.tier == .light }.count
    }

    /// Number of people on the Active tier.
    var activeSeats: Int {
        members.filter { $0.tier == .active }.count
    }

    /// Monthly total in whole US dollars, summed across every person's tier.
    var monthlyTotal: Int {
        members.reduce(0) { (sum: Int, member: SeatMember) -> Int in
            sum + member.tier.monthlyPrice
        }
    }

    /// The overall plan tier reported to the backend — Active when any
    /// seat is on the Active plan, otherwise Light. This is the value the
    /// admin channels grid reads to flag a client as subscribed.
    var planTier: GoldilocksSubscriptionTier {
        if members.contains(where: { $0.tier == .active }) {
            return .active
        }
        return members.isEmpty ? .noPlan : .light
    }

    private init() {
        let snapshot = Self.loadSnapshot()
        self.members = snapshot?.members ?? []
        self.subscribedRoster = snapshot?.subscribedRoster
        self.sentFingerprint = snapshot?.sentFingerprint
    }

    // MARK: - Subscription sync

    /// Canonical `email|tier` token for one person. Email is trimmed and
    /// lower-cased so capitalisation or stray spaces don't read as a change.
    private func rosterEntry(for member: SeatMember) -> String {
        let email = member.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return "\(email)|\(member.tier.rawValue)"
    }

    /// The current people list as sorted `email|tier` tokens.
    var currentRosterEntries: [String] {
        members.map { rosterEntry(for: $0) }.sorted()
    }

    /// Fingerprint of the current people list.
    var currentFingerprint: String {
        currentRosterEntries.joined(separator: "\n")
    }

    /// True once the client has created a subscription.
    var hasSubscription: Bool {
        subscribedRoster != nil
    }

    /// True when the subscription covers exactly the current people list.
    var subscriptionMatches: Bool {
        subscribedRoster?.joined(separator: "\n") == currentFingerprint
    }

    /// True when there's a subscription but the people list has drifted from it.
    var subscriptionNeedsUpdate: Bool {
        hasSubscription && !subscriptionMatches
    }

    /// True when the current people list was already sent to Advisory.
    var alreadySentCurrentRoster: Bool {
        sentFingerprint == currentFingerprint
    }

    /// Whether "Send to Advisory" is currently allowed: there are people, the
    /// subscription matches them, and this exact list hasn't been sent yet.
    var canSendToAdvisory: Bool {
        !members.isEmpty && subscriptionMatches && !alreadySentCurrentRoster
    }

    /// True when this person isn't yet covered by the active subscription —
    /// added or re-tiered since the last Create / Update Subscription.
    func isPending(_ member: SeatMember) -> Bool {
        guard let subscribedRoster else { return false }
        return !subscribedRoster.contains(rosterEntry(for: member))
    }

    /// Record that the subscription now covers the current people list.
    func markSubscriptionSynced() {
        subscribedRoster = currentRosterEntries
    }

    /// Simulate a successful subscription purchase: push the plan tier to
    /// the Goldilocks backend, then record the roster locally. The backend
    /// tier is what the admin channels grid reads, so this is what makes a
    /// simulated subscription show up there. The local roster is only
    /// marked synced once the backend call succeeds.
    func syncSubscription(session: any SessionManagerProtocol) async throws {
        try await GoldilocksSession.shared.setSubscriptionTier(planTier, session: session)
        markSubscriptionSynced()
    }

    // MARK: - Roster delivery

    /// Errors surfaced when posting the roster to the Advisory chat.
    enum RosterSendError: LocalizedError {
        case advisoryChatNotFound

        var errorDescription: String? {
            switch self {
            case .advisoryChatNotFound:
                return "Couldn't find your Advisory chat yet. Open your chats once so it can sync, then try again."
            }
        }
    }

    /// The people list rendered as a plain-text chat message.
    var rosterMessageText: String {
        let countWord: String = members.count == 1 ? "person" : "people"
        var lines: [String] = []
        lines.append("Subscription people list")
        lines.append("\(members.count) \(countWord) — $\(monthlyTotal)/mo")
        lines.append("")
        for (index, member) in members.enumerated() {
            let name: String = member.name.isEmpty ? "Unnamed" : member.name
            lines.append("\(index + 1). \(name) (\(member.tier.displayName))")
            if !member.email.isEmpty {
                lines.append("   \(member.email)")
            }
            if !member.phone.isEmpty {
                lines.append("   \(member.phone)")
            }
        }
        return lines.joined(separator: "\n")
    }

    /// True when `conversation` is the caller's own Advisory chat — the
    /// chat the roster posts to. `goldilocksPinnedSection` resolves the
    /// caller's own channels, so an admin (who belongs to many clients'
    /// Advisories) still posts into their own.
    private func isRosterDestination(_ conversation: Conversation) -> Bool {
        guard conversation.goldilocksPinnedSection == .client else { return false }
        return (conversation.name ?? "").hasPrefix("Advisory")
    }

    /// Compose the current people list and post it to the caller's own
    /// Advisory XMTP group. Independent of billing — the roster is just a
    /// chat message, so this works before Stripe is wired up.
    func sendRosterToChannel(session: any SessionManagerProtocol) async throws {
        let conversations: [Conversation] = try session
            .conversationsRepository(for: [.allowed, .unknown])
            .fetchAll()
        guard let destination = conversations.first(where: { (conversation: Conversation) -> Bool in
            isRosterDestination(conversation)
        }) else {
            throw RosterSendError.advisoryChatNotFound
        }
        let writer = session.messagingService().messageWriter(
            for: destination.id,
            backgroundUploadManager: BackgroundUploadManager.shared
        )
        try await writer.send(text: rosterMessageText)
        sentFingerprint = currentFingerprint
    }

    // MARK: - Persistence

    private struct Snapshot: Codable {
        var members: [SeatMember]
        var subscribedRoster: [String]?
        var sentFingerprint: String?
    }

    private func persist() {
        let snapshot = Snapshot(
            members: members,
            subscribedRoster: subscribedRoster,
            sentFingerprint: sentFingerprint
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: Constant.storageKey)
    }

    private static func loadSnapshot() -> Snapshot? {
        guard let data = UserDefaults.standard.data(forKey: Constant.storageKey) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    private enum Constant {
        static let storageKey: String = "goldilocks.seatPlan"
    }
}
