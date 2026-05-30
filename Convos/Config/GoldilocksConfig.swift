import ConvosCore
import Foundation

/// Configuration values that are specific to the Goldilocks Digital build.
///
/// Edit these directly when you have real values to plug in. Leaving the
/// recipient inbox IDs as empty strings makes the "Open group chat" button
/// fall back to the standard new-conversation flow (so the build still works
/// while you're setting things up).
enum GoldilocksConfig {
    /// Effective role for this run. Every install starts as `.client` —
    /// there is no build-time role flag. `GoldilocksSession` flips this
    /// to `.admin` (via the `identity` didSet) once the backend confirms
    /// the inbox is on the admin allowlist: either it already was, or
    /// the user entered the upgrade code in the debug area's "Upgrade"
    /// row (POST /v2/admin/upgrade).
    ///
    /// Plain stored value rather than @Observable — UI that needs to
    /// react to a mid-session upgrade should observe
    /// `GoldilocksSession.shared` directly (its `role` / `isAdmin` are
    /// observable). Anything reading this static catches up on the next
    /// list recompute or app relaunch.
    nonisolated(unsafe) static var role: GoldilocksRole = .client

    /// This install's own Goldilocks client number, mirrored from
    /// `GoldilocksSession.identity` so non-isolated call sites (the
    /// `Conversation` extensions below) can pick out the user's *own*
    /// "Advisory #N" / "Reports #N" and tell them apart from the other
    /// clients' Advisories an admin is also a member of.
    nonisolated(unsafe) static var ownClientNumber: Int64?

    /// Keychain slot suffix + device-id suffix. Fixed: one XMTP identity
    /// per app install. To test multiple users, use separate simulators
    /// (each has its own keychain) or erase + reinstall for a fresh
    /// identity. Must be stable and known at launch — before any network
    /// call — so it can't depend on role or server state.
    static let slotIdentifier: String = "goldilocks"

    /// Legacy hardcoded inbox IDs. Used as a fallback when the backend's
    /// /v2/admins list is unreachable or empty. Once the spawn-two-sims
    /// flow is running, the admin sim's inbox is dynamically pulled from
    /// the backend and these values are ignored.
    static let morganInboxId: String = ""
    static let tillieInboxId: String = ""

    /// The canonical Goldilocks support group names for the current role.
    /// Used as prefixes for the sort-priority ordering inside the pinned
    /// block (Advisory before Reports for clients; Admins, Audit Log,
    /// Advisory, then Reports for admins).
    /// - Client: Advisory + Reports — the channels they use day-to-day.
    /// - Admin: Admins + Audit Log (the cross-admin coordination groups,
    ///   rendered under the "Admin" section header) followed by the
    ///   admin's own Advisory + Reports (rendered under "Client").
    static var groupNames: [String] {
        let b = BrandConfig.shared.groups
        switch role {
        case .client: return b.client
        case .admin:  return b.admin + b.client
        }
    }

    /// Legacy single-group accessor. Returns the first canonical group name
    /// for the current role.
    static var groupName: String { groupNames.first ?? "" }

    /// Returns the inbox IDs of all hardcoded recipients, ignoring any blanks.
    static var hardcodedRecipientInboxIds: [String] {
        [morganInboxId, tillieInboxId]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// All canonical Goldilocks group name *prefixes*. The agent appends
    /// `#<clientNumber>` to Advisory and Reports groups (e.g. "Advisory #5",
    /// "Reports #5") so each row is self-identifying in the conversations
    /// list and the admin grid. The Admins + Audit Log coordination
    /// groups keep flat names. Used by `isGoldilocksGroup` and the icon
    /// picker below — both treat the prefix as the brand-defining marker.
    static var allGroupNamePrefixes: [String] { BrandConfig.shared.groups.all }

    /// True if `name` matches one of the Goldilocks brand prefixes
    /// (handles both bare "Admins" / "Audit Log" and per-client
    /// "Advisory #N" / "Reports #N").
    static func isGoldilocksGroupName(_ name: String) -> Bool {
        for prefix in BrandConfig.shared.groups.all where name == prefix || name.hasPrefix("\(prefix) ") {
            return true
        }
        return false
    }

    /// SF Symbol name to use as the avatar for a given Goldilocks group.
    /// Falls back to a generic chat icon if the name isn't mapped.
    static func iconSymbolName(for groupName: String) -> String {
        let icons = BrandConfig.shared.groupIcons
        for (key, icon) in icons where key != "default" {
            if groupName == key || groupName.hasPrefix("\(key) ") { return icon }
        }
        return icons["default"] ?? "bubble.left.and.bubble.right.fill"
    }
}

/// A labelled section in the block of Goldilocks groups pinned to the top
/// of the conversations list. Admins see both; clients see only `.client`.
enum GoldilocksPinnedSection: Equatable {
    /// Cross-admin coordination groups — "Admins" + "Audit Log".
    case admin
    /// The user's own channels — "Advisory #N" + "Reports #N".
    case client
}

extension Conversation {
    /// True when this conversation is one of the canonical Goldilocks support
    /// groups (matches by name only — we explicitly *don't* match by member
    /// composition, so user-renamed clones won't accidentally inherit the
    /// brand treatment).
    var isGoldilocksGroup: Bool {
        guard let name else { return false }
        return GoldilocksConfig.isGoldilocksGroupName(name)
    }

    /// Which labelled section this group belongs to in the block pinned to
    /// the top of the conversations list, or nil if it isn't one of the
    /// current role's pinned Goldilocks groups. Role-aware:
    ///   - Admin: an Admin section — the cross-admin "Admins" + "Audit Log"
    ///     groups — and a Client section — the admin's *own* "Advisory #N"
    ///     + "Reports #N", matched by client number so the other clients'
    ///     Advisories they belong to are left in normal recency order.
    ///   - Client: only the Client section — their own Advisory + Reports.
    var goldilocksPinnedSection: GoldilocksPinnedSection? {
        guard let name else { return nil }
        let b = BrandConfig.shared.groups
        switch GoldilocksConfig.role {
        case .admin:
            if b.admin.contains(name) { return .admin }
            guard let number = GoldilocksConfig.ownClientNumber else { return nil }
            for g in b.client where name == "\(g) #\(number)" { return .client }
            return nil
        case .client:
            for g in b.client where name.hasPrefix(g) { return .client }
            return nil
        }
    }

    /// True when this group sorts to the top of the conversations list,
    /// inside one of the pinned sections, regardless of its stored
    /// `isPinned` flag.
    var isPinnedGoldilocksGroup: Bool {
        goldilocksPinnedSection != nil
    }

    /// True if this conversation should be visible in the conversation list
    /// for the *current* role.
    /// - Admin: sees Admins + their own Advisory/Reports + non-Goldilocks
    ///   chats. Other clients' Advisories — which the admin is technically
    ///   a member of — get dropped by the staleness filter
    ///   (`isStaleGoldilocksChannel`), since their xmtpGroupIds aren't in
    ///   `GoldilocksOwnedChannels`. Those still surface in the admin
    ///   channels grid view for oversight.
    /// - Client: sees their own Advisory/Reports + non-Goldilocks chats;
    ///   the cross-admin Admins + Audit Log groups are hidden — a former
    ///   admin can still be a member of them after downgrading.
    var isVisibleInCurrentRole: Bool {
        guard let name else { return true }
        switch GoldilocksConfig.role {
        case .admin:
            return true
        case .client:
            return !BrandConfig.shared.groups.admin.contains(name)
        }
    }
}
