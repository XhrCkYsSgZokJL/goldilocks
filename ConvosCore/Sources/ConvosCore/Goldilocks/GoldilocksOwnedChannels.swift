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
public enum GoldilocksOwnedChannels {
    private static let lock: NSLock = NSLock()
    nonisolated(unsafe) private static var _ownedIds: Set<String> = []

    /// Replace the owned-channel set. Idempotent. Call after every
    /// successful `/v2/me/channels` fetch.
    public static func set(_ ids: [String]) {
        lock.lock()
        defer { lock.unlock() }
        _ownedIds = Set(ids)
    }

    /// True iff the given `xmtpGroupId` is one of this client's owned
    /// channels. Returns `false` until the set has been populated; the
    /// caller should treat that as "we don't know yet, don't filter."
    public static func contains(xmtpGroupId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return _ownedIds.contains(xmtpGroupId)
    }

    /// True iff the set has been populated at least once. Used to avoid
    /// filtering until the first fetch completes — otherwise we'd hide
    /// Goldilocks-managed conversations during the launch window before
    /// `/v2/me/channels` returns.
    public static var isLoaded: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !_ownedIds.isEmpty
    }
}
