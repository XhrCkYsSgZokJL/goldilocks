import ConvosCore
import Foundation

/// Configuration values that are specific to the Goldilocks Digital build.
///
/// Edit these directly when you have real values to plug in. Leaving the
/// recipient inbox IDs as empty strings makes the "Open group chat" button
/// fall back to the standard new-conversation flow (so the build still works
/// while you're setting things up).
enum GoldilocksConfig {
    /// Build-time role for this install. Edit this constant and ⌘R to
    /// switch between admin and client identities. Each role has its own
    /// keychain slot, so flipping back and forth doesn't lose the other
    /// role's onboarding state.
    ///
    /// You can also override this at runtime via the `GOLDILOCKS_ROLE`
    /// scheme env var (`admin` or `client`). The env var wins when set,
    /// the constant is the fallback.
    ///
    /// Recommended workflow:
    ///   1. Set to `.admin`, ⌘R. The admin inbox registers and is
    ///      promoted server-side (lands in `admin_inboxes`).
    ///   2. Flip to `.client`, ⌘R. The client gets a fresh identity and
    ///      pulls the admin inbox list from `/v2/admins` so the
    ///      Advisory + Reports groups it creates include the admin.
    static let defaultRole: GoldilocksRole = .admin

    /// Build-time display name for this install. Combined with `defaultRole`
    /// to produce a unique keychain slot + device-id suffix, so multiple
    /// admins (e.g. Morgan, Tillie) and multiple clients (e.g. Bob, Alice)
    /// can coexist on the same simulator. Each (role, name) pair gets its
    /// own persisted identity. Edit + ⌘R to spin up another instance.
    ///
    /// Override at runtime via `GOLDILOCKS_NAME` scheme env var.
    static let defaultName: String = "Morgan"

    /// Effective role for this run. Reads `GOLDILOCKS_ROLE` env var if
    /// present, otherwise falls back to `defaultRole`.
    static var role: GoldilocksRole {
        let raw = ProcessInfo.processInfo.environment["GOLDILOCKS_ROLE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if let raw, let parsed = GoldilocksRole(rawValue: raw) {
            return parsed
        }
        return defaultRole
    }

    /// Effective display name for this run. Reads `GOLDILOCKS_NAME` env
    /// var if set, otherwise falls back to `defaultName`.
    static var name: String {
        let raw = ProcessInfo.processInfo.environment["GOLDILOCKS_NAME"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let raw, !raw.isEmpty {
            return raw
        }
        return defaultName
    }

    /// Filename-safe version of `name` used inside slot suffixes.
    /// Lowercased, alphanumerics + hyphens; spaces become hyphens; everything
    /// else is dropped. Empty after sanitisation falls back to "anon".
    static var sanitizedName: String {
        let allowed = name
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .filter { $0.isLetter || $0.isNumber || $0 == "-" }
        return allowed.isEmpty ? "anon" : allowed
    }

    /// Combined identifier used as the keychain slot suffix + device-id
    /// suffix, e.g. "admin.morgan", "client.bob". Each (role, name) pair
    /// produces a unique identity row on the backend.
    static var slotIdentifier: String {
        "\(role.rawValue).\(sanitizedName)"
    }

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
