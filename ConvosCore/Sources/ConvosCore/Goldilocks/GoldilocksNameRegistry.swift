import Foundation

/// Maps Goldilocks admin and agent inbox IDs to display names so the iOS
/// app can replace the generic "Somebody" fallback when a member hasn't
/// broadcast a profile update into the group. Populated at launch alongside
/// `GoldilocksAgentTrust` from the same `/v2/admins` and `/v2/agents`
/// endpoints.
public enum GoldilocksNameRegistry {
    private static let lock: NSLock = NSLock()
    nonisolated(unsafe) private static var _names: [String: String] = [:]

    /// Register a batch of (inboxId → displayName) pairs. Merges into the
    /// existing map so admin names and agent names can be registered
    /// independently at different points during launch.
    public static func register(_ entries: [(inboxId: String, name: String)]) {
        lock.lock()
        defer { lock.unlock() }
        for entry in entries {
            _names[entry.inboxId.lowercased()] = entry.name
        }
    }

    /// Register agent inbox IDs under a shared label (e.g. "Goldilocks Bot").
    public static func registerAgents(_ inboxIds: [String], name: String) {
        lock.lock()
        defer { lock.unlock() }
        for id in inboxIds {
            _names[id.lowercased()] = name
        }
    }

    /// Look up a display name for the given inbox ID. Returns nil when the
    /// inbox isn't a known admin or agent — callers should fall through to
    /// their existing "Somebody" path.
    public static func displayName(forInboxId inboxId: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return _names[inboxId.lowercased()]
    }

    /// Clear all registered names. Used during sign-out.
    public static func reset() {
        lock.lock()
        defer { lock.unlock() }
        _names.removeAll()
    }
}
