import Foundation

/// XMTP group IDs of the Advisory + Reports channels the *calling* client
/// owns, sourced from `/v2/me/channels`. Used to filter the conversations
/// list so we only show this client's Goldilocks-managed channels — not
/// every Advisory/Reports group they happen to be a member of.
///
/// The trust set in `GoldilocksAgentTrust` says "creator inbox is one of
/// the agents." That's necessary but not sufficient: if this device's
/// inbox was ever an admin (and so a member of every Advisory), or if
/// stale MLS conversations persist across keychain slot rotations, we'd
/// still see other clients' channels. Filtering to the backend's owned
/// list is what keeps the UI honest.
///
/// Loaded-state is tracked explicitly rather than inferred from the set
/// being non-empty. The two agents provision Advisory and Reports a few
/// milliseconds apart, so an early `/v2/me/channels` fetch can return just
/// one role. Activating the staleness filter on that partial snapshot
/// hides the not-yet-listed channel the moment its welcome lands — and the
/// global mutation that later completes the set doesn't re-run the list's
/// filter, so the row stays hidden until relaunch. Treating the set as
/// loaded only once every expected role is present avoids that race.
public enum GoldilocksOwnedChannels {
    private static let lock: NSLock = NSLock()
    nonisolated(unsafe) private static var _ownedIds: Set<String> = []
    nonisolated(unsafe) private static var _loaded: Bool = false

    /// Replace the owned-channel set. Idempotent. Call after every
    /// successful `/v2/me/channels` fetch. `complete` should be true only
    /// when the backend reports every expected role provisioned; a partial
    /// set is stored (so the ids are available) but does not arm the
    /// staleness filter. An empty set never counts as loaded.
    public static func set(_ ids: [String], complete: Bool = true) {
        lock.lock()
        defer { lock.unlock() }
        _ownedIds = Set(ids)
        _loaded = complete && !ids.isEmpty
    }

    /// True iff the given `xmtpGroupId` is one of this client's owned
    /// channels. Returns `false` until the set has been populated; the
    /// caller should treat that as "we don't know yet, don't filter."
    public static func contains(xmtpGroupId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return _ownedIds.contains(xmtpGroupId)
    }

    /// True once a complete owned-channel set has landed at least once.
    /// Used to avoid filtering during the launch window before
    /// `/v2/me/channels` returns every expected role — otherwise we'd hide
    /// a Goldilocks-managed conversation whose welcome arrives while the
    /// set is still partial.
    public static var isLoaded: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _loaded
    }
}
