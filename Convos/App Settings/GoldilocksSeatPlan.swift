import ConvosCore
import ConvosCoreiOS
import Foundation
import Observation

/// One person on the plan. There is a single Goldilocks plan today
/// (`GoldilocksPlan.monthlyPricePerPerson` per person, per month) so each
/// person is just one seat. Entry is gated by an email-code handshake
/// against the person's email address; once verified, the person is
/// added directly as `enabled`. Admins can still disable a person later
/// as a kill switch for the third-party subscription.
struct SeatMember: Codable, Identifiable, Equatable {
    var id: UUID
    var name: String
    var email: String
    /// Admin-controlled kill switch. Defaults to `true` for newly
    /// verified people. When an admin disables a person the backend
    /// unsubscribes them from the third-party service; flipping it back
    /// on resubscribes.
    var enabled: Bool

    init(
        id: UUID = UUID(),
        name: String = "",
        email: String = "",
        enabled: Bool = true
    ) {
        self.id = id
        self.name = name
        self.email = email
        self.enabled = enabled
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, email, enabled
    }

    /// Keys that don't map to a stored property, used only by the decoder
    /// to detect legacy on-disk shapes. Kept separate from `CodingKeys`
    /// so Swift's synthesized `encode(to:)` doesn't try to encode them.
    private enum LegacyKeys: String, CodingKey {
        case approvalStatus
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(UUID.self, forKey: .id)
        self.name = try container.decode(String.self, forKey: .name)
        self.email = try container.decode(String.self, forKey: .email)
        // Legacy shapes carried an `approvalStatus` field and used
        // `enabled` only as the admin's kill switch on top of an
        // already-approved person. With the email-verification gate
        // replacing admin approval, a legacy row's `enabled = false`
        // usually meant "waiting on admin", not "deliberately turned
        // off", so auto-enable everything that came in under the old
        // schema. Rows written by the current code path have no
        // `approvalStatus` key and their explicit `enabled` value wins.
        let legacyContainer = try decoder.container(keyedBy: LegacyKeys.self)
        let isLegacyRow: Bool = legacyContainer.contains(.approvalStatus)
        if isLegacyRow {
            self.enabled = true
        } else {
            self.enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        }
    }
}

/// The client's plan people. The list is synced to the backend as an
/// encrypted blob (see `loadFromBackend` / `saveToBackend`) and cached
/// on-device in UserDefaults. Each person is one seat at
/// `GoldilocksPlan.monthlyPricePerPerson` per month, and the billable
/// seat count drives the billing burn rate.
@MainActor
@Observable
final class GoldilocksSeatPlan {
    static let shared: GoldilocksSeatPlan = GoldilocksSeatPlan()

    var members: [SeatMember] {
        didSet { persist() }
    }

    /// Whether the client currently has active prepaid coverage (a
    /// positive live balance). Cached from the billing status — a client
    /// only counts as Silver or Gold while this is true. Persisted so the
    /// tier shown at launch reflects the last known coverage state.
    var coverageActive: Bool {
        didSet { persist() }
    }

    /// The backend-stored version of the encrypted people list, used for
    /// optimistic concurrency on save. Persisted so an offline launch can
    /// still save against the right base version.
    @ObservationIgnored private var listVersion: Int {
        didSet { persist() }
    }

    /// The people list as it last stood on the backend (after a load or a
    /// successful save). Lets `saveToBackend` skip a write when `members`
    /// only changed because a load applied the backend's own copy.
    @ObservationIgnored private var lastSyncedMembers: [SeatMember] = []

    /// Total people on the plan, including any an admin has disabled.
    /// Used for the people-count UI; not the billing rate.
    var totalSeats: Int {
        members.count
    }

    /// Only enabled people count toward billing — disabled people sit on
    /// the plan without driving cost or being subscribed to the
    /// third-party service.
    private var billableMembers: [SeatMember] {
        members.filter { $0.enabled }
    }

    /// Billable people on the plan. Drives the backend burn rate.
    var billableSeatCount: Int {
        billableMembers.count
    }

    /// Monthly total in whole US dollars: billable people times the single
    /// per-person plan price. Disabled people are excluded.
    var monthlyTotal: Int {
        billableSeatCount * GoldilocksPlan.monthlyPricePerPerson
    }

    private init() {
        let snapshot = Self.loadSnapshot()
        self.members = snapshot?.members ?? []
        self.coverageActive = snapshot?.coverageActive ?? false
        self.listVersion = snapshot?.listVersion ?? 0
    }

    // MARK: - Advisory lookup

    /// Error when the caller's own Advisory chat can't be resolved.
    enum AdvisoryLookupError: LocalizedError {
        case advisoryChatNotFound

        var errorDescription: String? {
            switch self {
            case .advisoryChatNotFound:
                return "Couldn't find your Advisory chat yet. Open your chats once so it can sync, then try again."
            }
        }
    }

    /// True when `conversation` is the caller's own Advisory chat.
    /// `goldilocksPinnedSection` resolves the caller's own channels, so an
    /// admin (who belongs to many clients' Advisories) still matches only
    /// their own.
    private func isOwnAdvisory(_ conversation: Conversation) -> Bool {
        guard conversation.goldilocksPinnedSection == .client else { return false }
        return (conversation.name ?? "").hasPrefix("Advisory")
    }

    // MARK: - Encrypted backend sync

    /// Resolve the caller's own Advisory conversation, or throw if it
    /// hasn't synced to this device yet.
    private func advisoryConversation(session: any SessionManagerProtocol) throws -> Conversation {
        let conversations: [Conversation] = try session
            .conversationsRepository(for: [.allowed, .unknown])
            .fetchAll()
        guard let advisory = conversations.first(where: { isOwnAdvisory($0) }) else {
            throw AdvisoryLookupError.advisoryChatNotFound
        }
        return advisory
    }

    /// Pull the encrypted people list from the backend and decrypt it with
    /// the Advisory group's key. Best-effort: on any failure the on-device
    /// cache is kept. If the backend has no list yet but the local cache
    /// does, the cache is pushed up instead.
    func loadFromBackend(session: any SessionManagerProtocol) async {
        do {
            let blob = try await session.fetchGoldilocksPeopleList()
            guard blob.version > 0,
                  let ciphertext = blob.ciphertext,
                  let salt = blob.salt,
                  let nonce = blob.nonce else {
                // No list on the backend yet — seed it from the cache.
                listVersion = blob.version
                if members.isEmpty {
                    lastSyncedMembers = members
                } else {
                    await saveToBackend(session: session)
                }
                return
            }
            let advisory: Conversation = try advisoryConversation(session: session)
            let key: Data = try await session.groupEncryptionKey(forConversationId: advisory.id)
            let loaded: [SeatMember] = try PeopleListCrypto.decrypt(
                ciphertext: ciphertext, salt: salt, nonce: nonce, groupKey: key
            )
            members = loaded
            lastSyncedMembers = loaded
            listVersion = blob.version
        } catch {
            Log.warning("[Goldilocks] People list load failed: \(error.localizedDescription)")
        }
    }

    /// Encrypt the current people list with the Advisory group's key and
    /// store it on the backend. Best-effort: failures are logged and the
    /// on-device cache is kept; the next load reconciles. Skips the write
    /// when nothing has changed since the last sync. On a successful save,
    /// adds and removes are also posted to the Advisory chat as audit
    /// lines so the client and their admins share a chronological record.
    func saveToBackend(session: any SessionManagerProtocol) async {
        guard members != lastSyncedMembers else { return }
        let previous: [SeatMember] = lastSyncedMembers
        let snapshot: [SeatMember] = members
        do {
            let advisory: Conversation = try advisoryConversation(session: session)
            let key: Data = try await session.groupEncryptionKey(forConversationId: advisory.id)
            let blob: PeopleListCrypto.EncryptedBlob = try PeopleListCrypto.encrypt(snapshot, groupKey: key)
            let newVersion: Int = try await session.saveGoldilocksPeopleList(
                ciphertext: blob.ciphertext,
                salt: blob.salt,
                nonce: blob.nonce,
                baseVersion: listVersion
            )
            lastSyncedMembers = snapshot
            listVersion = newVersion
            await postAuditLines(
                GoldilocksPeopleAudit.clientDiffLines(old: previous, new: snapshot),
                toConversationId: advisory.id,
                session: session
            )
        } catch {
            Log.warning("[Goldilocks] People list save failed: \(error.localizedDescription)")
        }
    }

    /// Send each audit line into the given conversation, swallowing errors
    /// so a transient send failure doesn't make the people-list save look
    /// like it failed.
    private func postAuditLines(
        _ lines: [String],
        toConversationId conversationId: String,
        session: any SessionManagerProtocol
    ) async {
        guard !lines.isEmpty else { return }
        let writer: any ConversationStateManagerProtocol = session
            .messagingService()
            .conversationStateManager(for: conversationId)
        for line in lines {
            do {
                try await writer.send(text: line)
            } catch {
                Log.warning("[Goldilocks] Couldn't post audit line: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Persistence

    private struct Snapshot: Codable {
        var members: [SeatMember]
        var listVersion: Int?
        var coverageActive: Bool?
    }

    private func persist() {
        let snapshot = Snapshot(members: members, listVersion: listVersion, coverageActive: coverageActive)
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
