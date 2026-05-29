import Foundation

/// Inbox IDs of server-side Goldilocks agents (admins-agent, reports-agent)
/// that the user implicitly trusts because they registered with the
/// Goldilocks backend. Conversations created by these inboxes bypass the
/// usual `unknown -> needs-invite` consent gate and get auto-allowed by
/// `StreamProcessor.shouldProcessConversation`.
///
/// Populated by the iOS app at launch from `GET /v2/agents`. Empty by
/// default — when empty, the auto-allow path is a no-op and Convos's
/// stock invite flow runs unchanged.
public enum GoldilocksAgentTrust {
    private static let lock: NSLock = NSLock()
    nonisolated(unsafe) private static var _trustedInboxIds: Set<String> = []

    /// Replace the set of trusted agent inbox IDs. Idempotent.
    public static func setTrustedInboxIds(_ ids: [String]) {
        lock.lock()
        defer { lock.unlock() }
        _trustedInboxIds = Set(ids.map { $0.lowercased() })
    }

    /// True iff the given inbox ID has been registered as a trusted agent.
    public static func contains(inboxId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return _trustedInboxIds.contains(inboxId.lowercased())
    }

    /// Snapshot the current trust set. Returned as `Set<String>` for use
    /// with GRDB's `IN` queries — `set.contains(column)` produces the
    /// right SQL via the QueryInterface.
    public static func snapshot() -> Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return _trustedInboxIds
    }
}
