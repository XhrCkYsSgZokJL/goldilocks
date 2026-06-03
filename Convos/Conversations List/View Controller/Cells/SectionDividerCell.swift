import SwiftUI
import UIKit

/// A collapsible group of rows in the conversations list. Each one is
/// introduced by a tappable `SectionDividerCell`; tapping it toggles
/// whether the group's conversations are shown.
enum ConversationListGroup: String, Hashable, CaseIterable {
    /// Cross-admin "Admins" + "Audit Log" groups (admin role only).
    case admin
    /// The caller's own "Advisory" + "Back Office" channels.
    case client
    /// Other clients' Advisory channels (admin role only).
    case advisory
    /// Every regular conversation below the pinned sections.
    case chats

    /// Title shown in the divider, e.g. "Client".
    var title: String {
        switch self {
        case .admin: return "Admin"
        case .client: return "Client"
        case .advisory: return "Advise"
        case .chats: return "Chats"
        }
    }
}

/// Persists which conversation-list sections the user has collapsed so the
/// choice survives app relaunches.
enum SectionCollapseStore {
    private static let key: String = "goldilocks.conversations.collapsedSections"

    static func load() -> Set<ConversationListGroup> {
        let raw = UserDefaults.standard.stringArray(forKey: key) ?? []
        return Set(raw.compactMap(ConversationListGroup.init(rawValue:)))
    }

    static func save(_ groups: Set<ConversationListGroup>) {
        UserDefaults.standard.set(groups.map(\.rawValue), forKey: key)
    }
}

/// Tappable section divider in the conversations list. The cell renders a
/// labelled, counted divider with an expand/collapse chevron; the
/// collection view's selection handles the tap.
final class SectionDividerCell: UICollectionViewCell {
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(group: ConversationListGroup, count: Int, isCollapsed: Bool, hasUnread: Bool) {
        contentConfiguration = UIHostingConfiguration {
            SectionDividerView(group: group, count: count, isCollapsed: isCollapsed, hasUnread: hasUnread)
        }
        .margins(.all, 0)
        .background(.clear)
        accessibilityIdentifier = "conversation-list-section-\(group.rawValue)"
    }
}

struct SectionDividerView: View {
    let group: ConversationListGroup
    let count: Int
    let isCollapsed: Bool
    let hasUnread: Bool

    private var isPhone: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
    }

    var body: some View {
        let title: String = "\(group.title) (\(count))"
        let chevron: String = isCollapsed ? "chevron.right" : "chevron.down"
        let textColor: Color = hasUnread ? Color.brandText : Color.brandTextLight
        HStack(spacing: DesignConstants.Spacing.step2x) {
            Rectangle()
                .fill(Color.brandTextLight.opacity(0.3))
                .frame(height: 0.5)
            HStack(spacing: DesignConstants.Spacing.stepHalf) {
                Text(title)
                    .font(.caption2)
                    .fontWeight(.medium)
                    .textCase(.uppercase)
                    .tracking(0.5)
                Image(systemName: chevron)
                    .font(.caption2.weight(.semibold))
            }
            .foregroundStyle(textColor)
            Rectangle()
                .fill(Color.brandTextLight.opacity(0.3))
                .frame(height: 0.5)
        }
        .padding(.horizontal, isPhone ? DesignConstants.Spacing.step4x : DesignConstants.Spacing.step6x)
        .padding(.vertical, DesignConstants.Spacing.step2x)
    }
}
