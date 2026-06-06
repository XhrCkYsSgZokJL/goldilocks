import ConvosCore
import ConvosCoreiOS
import Foundation
import Observation

/// Which slot in a person's life an email belongs to. Mirrors the
/// iOS Contacts label list so the picker reads naturally.
enum EmailLabel: String, Codable, CaseIterable, Identifiable {
    case home, work, other

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .home: return "Home"
        case .work: return "Work"
        case .other: return "Other"
        }
    }
}

/// One email address on a person's profile. Each address carries its
/// own verification state because every email must clear the same
/// email-code handshake before it can be relied on for the third-party
/// subscription or audit trail.
struct LabeledEmail: Codable, Identifiable, Equatable {
    var id: UUID
    var address: String
    var label: EmailLabel
    /// `true` once the email-code handshake has cleared. New addresses
    /// added through the edit sheet stay `false` until verified.
    var verified: Bool

    init(
        id: UUID = UUID(),
        address: String,
        label: EmailLabel = .other,
        verified: Bool = false
    ) {
        self.id = id
        self.address = address
        self.label = label
        self.verified = verified
    }
}

/// A person's mailing address. All fields are optional — clients fill
/// in what they have. Kept structured (rather than a free-form string)
/// so future use cases — tax forms, mailed paperwork, region-aware
/// pricing — don't need a re-parse.
struct PersonAddress: Codable, Equatable {
    var street: String
    var city: String
    var state: String
    var postalCode: String
    var country: String

    init(
        street: String = "",
        city: String = "",
        state: String = "",
        postalCode: String = "",
        country: String = ""
    ) {
        self.street = street
        self.city = city
        self.state = state
        self.postalCode = postalCode
        self.country = country
    }

    /// True when every field is blank — used to decide whether to render
    /// the address section at all on read-only views.
    var isEmpty: Bool {
        street.isEmpty && city.isEmpty && state.isEmpty && postalCode.isEmpty && country.isEmpty
    }

    /// Single-line summary suitable for compact rows. Skips blanks so a
    /// partially filled address still reads cleanly.
    var singleLine: String {
        [street, city, state, postalCode, country]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

/// One person on the plan. There is a single Goldilocks plan today
/// (`GoldilocksPlan.monthlyPricePerPerson` per person, per month) so each
/// person is just one seat. Entry is gated by an email-code handshake
/// against any one of the person's emails; once that first address is
/// verified, the person is added with `enabled = true`. Additional
/// emails added later go through the same handshake before they're
/// marked verified. Admins can still disable a person later as a kill
/// switch for the third-party subscription.
struct SeatMember: Codable, Identifiable, Equatable {
    var id: UUID
    var firstName: String
    var middleName: String
    var lastName: String
    /// All email addresses on the person's profile. At least one must
    /// be present + verified for the person to count as added; further
    /// emails track their own verified state independently.
    var emails: [LabeledEmail]
    var phone: String
    var address: PersonAddress
    /// Admin-controlled kill switch. Defaults to `true` for newly
    /// verified people. When an admin disables a person the backend
    /// unsubscribes them from the third-party service; flipping it back
    /// on resubscribes.
    var enabled: Bool
    /// SF Symbol name shown as the person's avatar/adornment in the people
    /// list. Picked (or shuffled) in the person editor.
    var icon: String

    static let defaultIcon: String = "person.circle.fill"

    init(
        id: UUID = UUID(),
        firstName: String = "",
        middleName: String = "",
        lastName: String = "",
        emails: [LabeledEmail] = [],
        phone: String = "",
        address: PersonAddress = PersonAddress(),
        enabled: Bool = true,
        icon: String = SeatMember.defaultIcon
    ) {
        self.id = id
        self.firstName = firstName
        self.middleName = middleName
        self.lastName = lastName
        self.emails = emails
        self.phone = phone
        self.address = address
        self.enabled = enabled
        self.icon = icon
    }

    /// Concatenated first / middle / last, skipping blanks so a
    /// partially filled name still renders cleanly.
    var fullName: String {
        [firstName, middleName, lastName]
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// First verified email, falling back to the first listed email if
    /// none are verified yet. `nil` when the person has no emails.
    var primaryEmail: LabeledEmail? {
        emails.first(where: { $0.verified }) ?? emails.first
    }

    /// String shown in lists and audit lines. Prefers the full name,
    /// falls back to the primary email, then a generic placeholder.
    var displayName: String {
        let name: String = fullName
        if !name.isEmpty { return name }
        if let address = primaryEmail?.address, !address.isEmpty { return address }
        return "Unnamed person"
    }

    private enum CodingKeys: String, CodingKey {
        case id, firstName, middleName, lastName, emails, phone, address, enabled, icon
    }

    /// Keys that don't map to a stored property, used only by the decoder
    /// to detect legacy on-disk shapes. Kept separate from `CodingKeys`
    /// so Swift's synthesized `encode(to:)` doesn't try to encode them.
    private enum LegacyKeys: String, CodingKey {
        case name, email, approvalStatus
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let legacyContainer = try decoder.container(keyedBy: LegacyKeys.self)

        self.id = try container.decode(UUID.self, forKey: .id)

        // Either the row was written under the new schema (has
        // `firstName`) or under one of the legacy shapes (has `name` and
        // `email` at the top level). The two are mutually exclusive.
        let hasNewNameShape: Bool = container.contains(.firstName)
        if hasNewNameShape {
            self.firstName = try container.decodeIfPresent(String.self, forKey: .firstName) ?? ""
            self.middleName = try container.decodeIfPresent(String.self, forKey: .middleName) ?? ""
            self.lastName = try container.decodeIfPresent(String.self, forKey: .lastName) ?? ""
        } else {
            let legacyName: String = (try? legacyContainer.decodeIfPresent(String.self, forKey: .name)) ?? ""
            let parts: LegacyNameParts = Self.splitLegacyName(legacyName)
            self.firstName = parts.first
            self.middleName = parts.middle
            self.lastName = parts.last
        }

        if container.contains(.emails) {
            self.emails = try container.decodeIfPresent([LabeledEmail].self, forKey: .emails) ?? []
        } else {
            // Legacy rows only carried a single email, but they were
            // only persisted after the verification handshake cleared,
            // so it's safe to mark the migrated email as verified.
            let legacyEmail: String = (try? legacyContainer.decodeIfPresent(String.self, forKey: .email)) ?? ""
            if legacyEmail.isEmpty {
                self.emails = []
            } else {
                self.emails = [LabeledEmail(address: legacyEmail, label: .other, verified: true)]
            }
        }

        self.phone = try container.decodeIfPresent(String.self, forKey: .phone) ?? ""
        self.address = try container.decodeIfPresent(PersonAddress.self, forKey: .address) ?? PersonAddress()

        // Older shapes carried an `approvalStatus` field and used
        // `enabled` only as the admin's kill switch on top of an
        // already-approved person. With the email-verification gate
        // replacing admin approval, a legacy row's `enabled = false`
        // usually meant "waiting on admin", not "deliberately turned
        // off", so auto-enable everything that came in under the old
        // schema. Rows written by the current code path have no
        // `approvalStatus` key and their explicit `enabled` value wins.
        let isLegacyApprovalRow: Bool = legacyContainer.contains(.approvalStatus)
        if isLegacyApprovalRow {
            self.enabled = true
        } else {
            self.enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        }

        self.icon = try container.decodeIfPresent(String.self, forKey: .icon) ?? SeatMember.defaultIcon
    }

    /// Best-effort split of a legacy single-string name into first /
    /// middle / last. Single token → just `firstName`; two tokens →
    /// first + last; three or more → middle tokens joined.
    private static func splitLegacyName(_ raw: String) -> LegacyNameParts {
        let trimmed: String = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return LegacyNameParts(first: "", middle: "", last: "") }
        let tokens: [String] = trimmed.split(separator: " ").map(String.init)
        switch tokens.count {
        case 1: return LegacyNameParts(first: tokens[0], middle: "", last: "")
        case 2: return LegacyNameParts(first: tokens[0], middle: "", last: tokens[1])
        default:
            let first: String = tokens[0]
            let last: String = tokens[tokens.count - 1]
            let middle: String = tokens[1..<(tokens.count - 1)].joined(separator: " ")
            return LegacyNameParts(first: first, middle: middle, last: last)
        }
    }

    /// Result of splitting a legacy single-field name. A struct rather
    /// than a 3-tuple to stay inside SwiftLint's `large_tuple` cap.
    private struct LegacyNameParts {
        let first: String
        let middle: String
        let last: String
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
