import Foundation
import GRDB

public extension Notification.Name {
    /// Posted on the main queue by `ContactsWriter.block` / `unblock` when
    /// a contact's blocked state actually changes (idempotent no-ops do
    /// not fire). `SessionManager` observes this to run an immediate
    /// `QuarantineSweeper.sweep()` — unblocking should restore held-by-
    /// block conversations to the main feed without waiting for the next
    /// hourly or foreground-entry sweep. UserInfo:
    /// `inboxId: String`, `blocked: Bool`.
    static let contactBlockingDidChange: Notification.Name = Notification.Name(
        "ContactBlockingDidChange"
    )
}

/// Snapshot of profile fields used when upserting a contact. All fields are
/// optional — callers pass whatever they currently have for the inbox. A
/// `nil` field means "no signal — preserve whatever is already stored on the
/// contact." This supports partial updates: a profile event that carries
/// only an avatar URL won't clobber a stored display name, and a profile
/// event from a non-agent member won't unset a previously-observed
/// `agentVerification`.
public struct ContactProfileSnapshot: Sendable, Hashable {
    public let displayName: String?
    public let avatarURL: String?
    public let profileUpdatedAt: Date?
    public let agentVerification: AgentVerification?

    public init(
        displayName: String? = nil,
        avatarURL: String? = nil,
        profileUpdatedAt: Date? = nil,
        agentVerification: AgentVerification? = nil
    ) {
        self.displayName = displayName
        self.avatarURL = avatarURL
        self.profileUpdatedAt = profileUpdatedAt
        self.agentVerification = agentVerification
    }
}

public protocol ContactsWriterProtocol: Sendable {
    /// Idempotent upsert. If the contact already exists, the immutable
    /// identity columns (`addedAt`, `addedViaConversationId`) are preserved
    /// and only the profile snapshot is updated subject to most-recent-wins.
    func upsertContact(
        inboxId: String,
        addedViaConversationId: String?,
        profile: ContactProfileSnapshot
    ) async throws

    /// Most-recent-wins profile update. Applied only if the incoming
    /// `profileUpdatedAt` is newer than the stored value (or the stored value
    /// is nil). Falls back to local now when the source has no timestamp so
    /// callers can still seed initial profile data.
    func updateProfileIfNewer(
        inboxId: String,
        profile: ContactProfileSnapshot
    ) async throws

    /// Marks the contact as blocked. No-op if the inboxId has no contact row
    /// (blocking does not auto-create contacts) or is already blocked. Repeat
    /// calls leave the original `blockedAt` timestamp in place.
    func block(inboxId: String) async throws

    /// Clears the blocked flag on the contact. No-op if the inboxId has no
    /// contact row or is already unblocked.
    func unblock(inboxId: String) async throws
}

final class ContactsWriter: ContactsWriterProtocol, @unchecked Sendable {
    private let databaseWriter: any DatabaseWriter

    init(databaseWriter: any DatabaseWriter) {
        self.databaseWriter = databaseWriter
    }

    func upsertContact(
        inboxId: String,
        addedViaConversationId: String?,
        profile: ContactProfileSnapshot
    ) async throws {
        try await databaseWriter.write { db in
            try Self.upsert(
                db: db,
                inboxId: inboxId,
                addedViaConversationId: addedViaConversationId,
                profile: profile
            )
        }
    }

    func updateProfileIfNewer(
        inboxId: String,
        profile: ContactProfileSnapshot
    ) async throws {
        try await databaseWriter.write { db in
            guard let existing = try DBContact.fetchOne(db, key: inboxId) else {
                // No contact row to update; profile updates for non-contacts
                // are intentionally dropped (the contacts feature is action-
                // gated and we never auto-add from a profile event alone).
                return
            }
            guard let merged = Self.replacingProfile(of: existing, with: profile) else {
                return
            }
            try merged.save(db)
        }
    }

    func block(inboxId: String) async throws {
        let didChange: Bool = try await databaseWriter.write { db in
            guard let existing = try DBContact.fetchOne(db, key: inboxId) else {
                // Blocking is action-gated on an existing contact row. We
                // never auto-create a contact just to flag it as blocked.
                Log.debug("block(inboxId:) skipped, no contact row for \(inboxId)")
                return false
            }
            guard existing.blockedAt == nil else {
                // Idempotent: leave the original blockedAt timestamp.
                return false
            }
            try existing.with(blockedAt: Date()).save(db)
            return true
        }
        if didChange {
            ContactsWriter.postBlockingDidChange(inboxId: inboxId, blocked: true)
        }
    }

    func unblock(inboxId: String) async throws {
        let didChange: Bool = try await databaseWriter.write { db in
            guard let existing = try DBContact.fetchOne(db, key: inboxId) else {
                Log.debug("unblock(inboxId:) skipped, no contact row for \(inboxId)")
                return false
            }
            guard existing.blockedAt != nil else {
                return false
            }
            try existing.with(blockedAt: nil).save(db)
            return true
        }
        if didChange {
            ContactsWriter.postBlockingDidChange(inboxId: inboxId, blocked: false)
        }
    }

    /// Posted on the main queue after `block` / `unblock` writes a real
    /// state change (idempotent no-ops do not fire). `SessionManager`
    /// observes this to trigger an immediate `QuarantineSweeper.sweep()`
    /// so unblocking restores held-by-block conversations to the main
    /// feed without waiting for the next hourly/foreground sweep.
    private static func postBlockingDidChange(inboxId: String, blocked: Bool) {
        let userInfo: [String: Any] = ["inboxId": inboxId, "blocked": blocked]
        if Thread.isMainThread {
            NotificationCenter.default.post(
                name: .contactBlockingDidChange,
                object: nil,
                userInfo: userInfo
            )
        } else {
            DispatchQueue.main.async {
                NotificationCenter.default.post(
                    name: .contactBlockingDidChange,
                    object: nil,
                    userInfo: userInfo
                )
            }
        }
    }

    fileprivate static func upsert(
        db: Database,
        inboxId: String,
        addedViaConversationId: String?,
        profile: ContactProfileSnapshot
    ) throws {
        if let existing = try DBContact.fetchOne(db, key: inboxId) {
            // Identity columns (addedAt, addedViaConversationId) are
            // intentionally preserved on re-upsert. The profile snapshot is
            // applied only if it carries a `profileUpdatedAt` newer than
            // the stored one (see `replacingProfile`); untimestamped
            // re-upserts leave the existing row untouched.
            guard let merged = replacingProfile(of: existing, with: profile) else {
                return
            }
            try merged.save(db)
            return
        }

        let now = Date()
        let row = DBContact(
            inboxId: inboxId,
            addedAt: now,
            addedViaConversationId: addedViaConversationId,
            displayName: profile.displayName,
            avatarURL: profile.avatarURL,
            profileUpdatedAt: profile.profileUpdatedAt ?? now,
            agentVerification: profile.agentVerification
        )
        try row.save(db)
        Log.debug("Inserted new contact for inboxId=\(inboxId) via=\(addedViaConversationId ?? "nil")")
    }

    /// Returns `existing` with its profile fields replaced by `profile` if
    /// the snapshot should be applied; returns `nil` if the caller should
    /// leave the stored row untouched.
    ///
    /// The snapshot is treated as one authoritative unit: when applied,
    /// every profile field on the stored row is replaced by the snapshot's
    /// value (including `nil`s, which clear the stored field). There is no
    /// per-field merging. This matches the wire-format contract for
    /// `ProfileUpdate`, where a message with no name and no encrypted
    /// image clears the sender's profile.
    ///
    /// Application rules:
    /// - Untimestamped snapshots (`profile.profileUpdatedAt == nil`) never
    ///   update an existing row. The caller is in a fill-defaults context
    ///   (e.g. `ContactSyncCoordinator` reading per-conversation member
    ///   profiles) and the stored row is authoritative.
    /// - Timestamped snapshots older than the stored `profileUpdatedAt`
    ///   are dropped (most-recent-wins).
    /// - Timestamped snapshots greater-than-or-equal to the stored
    ///   timestamp wholesale-replace the four profile fields.
    private static func replacingProfile(
        of existing: DBContact,
        with profile: ContactProfileSnapshot
    ) -> DBContact? {
        guard let incomingTimestamp = profile.profileUpdatedAt else {
            return nil
        }
        if let stored = existing.profileUpdatedAt, incomingTimestamp < stored {
            return nil
        }
        return existing.with(
            displayName: profile.displayName,
            avatarURL: profile.avatarURL,
            profileUpdatedAt: incomingTimestamp,
            agentVerification: profile.agentVerification
        )
    }
}

/// In-transaction helpers for contact upserts and for mirroring `DBMemberProfile`
/// saves onto `DBContact` (`mirrorMemberProfileToContactInTransaction`,
/// `saveMemberProfileAndMirrorToContactInTransaction`).
extension ContactsWriter {
    static func upsertContactInTransaction(
        db: Database,
        inboxId: String,
        addedViaConversationId: String?,
        profile: ContactProfileSnapshot
    ) throws {
        try upsert(
            db: db,
            inboxId: inboxId,
            addedViaConversationId: addedViaConversationId,
            profile: profile
        )
    }

    /// Copies member-profile display fields onto the matching contact row
    /// inside an existing transaction. No-ops when there is no contact for
    /// `inboxId` (profile events never auto-add contacts; only the
    /// action-gated coordinator does), or when `receivedAt` is older than
    /// the stored `profileUpdatedAt`.
    ///
    /// When the snapshot applies, all four profile fields are replaced
    /// wholesale: a `nil` `agentVerification` argument clears any
    /// previously stored verification, matching the `ProfileUpdate`
    /// wire-format contract.
    static func mirrorMemberProfileToContactInTransaction(
        db: Database,
        inboxId: String,
        name: String?,
        avatarURL: String?,
        receivedAt: Date,
        agentVerification: AgentVerification? = nil
    ) throws {
        guard let existing = try DBContact.fetchOne(db, key: inboxId) else {
            return
        }
        let snapshot = ContactProfileSnapshot(
            displayName: name,
            avatarURL: avatarURL,
            profileUpdatedAt: receivedAt,
            agentVerification: agentVerification
        )
        guard let merged = replacingProfile(of: existing, with: snapshot) else {
            return
        }
        try merged.save(db)
    }

    /// Persists `profile` and mirrors name/avatar onto the matching `DBContact` in the
    /// same transaction. Prefer this over `profile.save(db)` plus a separate mirror call
    /// so callers cannot skip the contact-list sync.
    static func saveMemberProfileAndMirrorToContactInTransaction(
        db: Database,
        profile: DBMemberProfile,
        receivedAt: Date
    ) throws {
        try profile.save(db)
        try mirrorMemberProfileToContactInTransaction(
            db: db,
            inboxId: profile.inboxId,
            name: profile.name,
            avatarURL: profile.avatar,
            receivedAt: receivedAt,
            agentVerification: profile.memberKind?.agentVerification
        )
    }
}
