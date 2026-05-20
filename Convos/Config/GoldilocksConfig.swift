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
    /// block (Advisory comes before Reports for clients; Admins before
    /// Audit Log for admins).
    /// - Client: Advisory + Reports — each created on first "Open channels"
    ///   tap with all admins as super-admin members.
    /// - Admin: Admins + Audit Log — both cross-admin groups; the agent
    ///   creates them once at least one admin exists.
    static var groupNames: [String] {
        switch role {
        case .client: return ["Advisory", "Reports"]
        case .admin:  return ["Admins", "Audit Log"]
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
    static let allGroupNamePrefixes: [String] = ["Advisory", "Reports", "Admins", "Audit Log"]

    /// True if `name` matches one of the Goldilocks brand prefixes
    /// (handles both bare "Admins" / "Audit Log" and per-client
    /// "Advisory #N" / "Reports #N").
    static func isGoldilocksGroupName(_ name: String) -> Bool {
        if name == "Admins" || name == "Audit Log" { return true }
        for prefix in ["Advisory", "Reports"] where name == prefix || name.hasPrefix("\(prefix) ") {
            return true
        }
        return false
    }

    /// SF Symbol name to use as the avatar for a given Goldilocks group.
    /// Falls back to a generic chat icon if the name isn't mapped.
    static func iconSymbolName(for groupName: String) -> String {
        if groupName == "Admins" { return "shield.lefthalf.filled" }
        if groupName == "Audit Log" { return "scroll.fill" }
        if groupName == "History" || groupName.hasPrefix("History ") { return "clock.fill" }
        if groupName.hasPrefix("Advisory") { return "lightbulb.fill" }
        if groupName.hasPrefix("Reports") { return "doc.text.fill" }
        return "bubble.left.and.bubble.right.fill"
    }
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

    /// Subset of Goldilocks groups that should sort to the top of the
    /// conversations list (above non-Goldilocks chats) regardless of the
    /// stored `isPinned` flag. Role-aware:
    ///   - Admin: cross-admin "Admins" + "Audit Log" groups. Admins is
    ///     for coordination; Audit Log is the firehose of client reports.
    ///     Other Advisories (which the admin is technically a member of)
    ///     flow with normal recency-based ordering.
    ///   - Client: their own Advisory + Reports — the channels they
    ///     actually use day-to-day.
    var isPinnedGoldilocksGroup: Bool {
        guard let name else { return false }
        switch GoldilocksConfig.role {
        case .admin:
            return name == "Admins" || name == "Audit Log"
        case .client:
            return name.hasPrefix("Advisory") || name.hasPrefix("Reports")
        }
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
    ///   Admins coordination group hidden.
    var isVisibleInCurrentRole: Bool {
        guard let name else { return true }
        switch GoldilocksConfig.role {
        case .admin:
            // Allow everything through here; staleness filter trims to
            // the admin's owned set (Admins + own Advisory + own Reports).
            return true
        case .client:
            return name != "Admins"
        }
    }
}
