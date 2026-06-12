import ConvosCore
import Foundation

/// Pure audit-line builders for changes to a client's people list. The
/// strings are sent into the Advisory chat — which is end-to-end encrypted
/// (same MLS group key family that protects the people list itself) — so
/// names are safe to include. The chat already shows the sender's
/// identity ("Morgan" vs "Goldilocks Admin"), so the lines describe
/// *what* happened, not *who* did it.
enum GoldilocksPeopleAudit {
    /// Lines summarising additions, removals, and detail edits when the
    /// client changes their own people list. Coverage (enabled) flips are
    /// excluded from the "updated" detection — those have their own
    /// activation messaging.
    static func clientDiffLines(old: [SeatMember], new: [SeatMember]) -> [String] {
        let oldById: [UUID: SeatMember] = Dictionary(uniqueKeysWithValues: old.map { ($0.id, $0) })
        let newById: [UUID: SeatMember] = Dictionary(uniqueKeysWithValues: new.map { ($0.id, $0) })
        var lines: [String] = []
        for member in new {
            guard let previous = oldById[member.id] else {
                lines.append(addedLine(for: member))
                continue
            }
            if detailsDiffer(previous, member) {
                lines.append(updatedLine(for: member))
            }
        }
        for member in old where newById[member.id] == nil {
            lines.append(removedLine(for: member))
        }
        return lines
    }

    /// True when anything other than the coverage flag changed.
    private static func detailsDiffer(_ old: SeatMember, _ new: SeatMember) -> Bool {
        var normalized: SeatMember = old
        normalized.enabled = new.enabled
        return normalized != new
    }

    /// Line for an admin enabling or disabling a person — the hook the
    /// backend uses to subscribe / unsubscribe them from the third-party
    /// service.
    static func enabledLine(for member: SeatMember, enabled: Bool) -> String {
        let name: String = displayName(for: member)
        return enabled
            ? "Enabled \(name), subscribed to service"
            : "Disabled \(name), unsubscribed from service"
    }

    private static func addedLine(for member: SeatMember) -> String {
        let name: String = displayName(for: member)
        return "Client added \(name) to their membership."
    }

    private static func removedLine(for member: SeatMember) -> String {
        let name: String = displayName(for: member)
        return "Client removed \(name) from their membership."
    }

    private static func updatedLine(for member: SeatMember) -> String {
        let name: String = displayName(for: member)
        return "Client updated \(name) on their membership."
    }

    private static func displayName(for member: SeatMember) -> String {
        member.firstName.isEmpty ? member.displayName : member.firstName
    }
}
