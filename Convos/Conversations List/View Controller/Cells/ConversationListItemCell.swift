import ConvosCore
import SwiftUI
import UIKit

final class ConversationListItemCell: UICollectionViewListCell {
    private var hostingWrapper: ConversationListItemWrapper?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(with conversation: Conversation, isSelected: Bool, showsPinnedDivider: Bool = false) {
        if let wrapper = hostingWrapper {
            wrapper.update(
                conversation: conversation,
                isSelected: isSelected,
                showsPinnedDivider: showsPinnedDivider
            )
        } else {
            let wrapper = ConversationListItemWrapper(
                conversation: conversation,
                isSelected: isSelected,
                showsPinnedDivider: showsPinnedDivider
            )
            hostingWrapper = wrapper
            contentConfiguration = UIHostingConfiguration {
                ConversationListItemWrapperView(wrapper: wrapper)
            }
            .margins(.all, 0)
            .background(.clear)
        }

        accessibilityIdentifier = conversation.isPendingInvite
            ? "conversation-list-item-draft-\(conversation.id)"
            : "conversation-list-item-\(conversation.id)"
    }

    override func updateConfiguration(using state: UICellConfigurationState) {
        super.updateConfiguration(using: state)
        hostingWrapper?.isSwiped = state.isSwiped
        hostingWrapper?.isHighlighted = state.isHighlighted

        var bg = UIBackgroundConfiguration.clear()
        bg.backgroundColor = .clear
        backgroundConfiguration = bg
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        contentConfiguration = nil
        hostingWrapper = nil
    }
}

@Observable
@MainActor
final class ConversationListItemWrapper {
    var conversation: Conversation
    var isSelected: Bool
    var isSwiped: Bool = false
    var isHighlighted: Bool = false
    /// True only for the *last* Goldilocks group in the list — used so the
    /// "Pinned" divider renders once after the whole Goldilocks block,
    /// not after every Goldilocks row.
    var showsPinnedDivider: Bool

    init(conversation: Conversation, isSelected: Bool, showsPinnedDivider: Bool = false) {
        self.conversation = conversation
        self.isSelected = isSelected
        self.showsPinnedDivider = showsPinnedDivider
    }

    func update(conversation: Conversation, isSelected: Bool, showsPinnedDivider: Bool) {
        self.conversation = conversation
        self.isSelected = isSelected
        self.showsPinnedDivider = showsPinnedDivider
    }
}

struct ConversationListItemWrapperView: View {
    var wrapper: ConversationListItemWrapper

    private var isPhone: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
    }

    private var shouldHighlight: Bool {
        if isPhone {
            return wrapper.isSwiped || wrapper.isHighlighted
        }
        return wrapper.isSwiped || wrapper.isSelected
    }

    @ViewBuilder
    private var conversationRow: some View {
        ConversationsListItem(conversation: wrapper.conversation)
            .background {
                if shouldHighlight {
                    if isPhone, wrapper.isHighlighted, !wrapper.isSwiped {
                        Rectangle()
                            .fill(Color.colorFillMinimal)
                    } else {
                        RoundedRectangle(cornerRadius: DesignConstants.CornerRadius.mediumLarge)
                            .fill(Color.colorFillMinimal)
                            .padding(.horizontal, isPhone ? 0 : DesignConstants.Spacing.step3x)
                    }
                }
            }
            .animation(.easeInOut(duration: 0.2), value: wrapper.isSwiped)
    }

    /// Thin divider with a centered "Pinned" label, shown above the Goldilocks
    /// group cell to mark it as the canonical chat. Sits inside the same cell
    /// so cell sizing stays correct.
    private var pinnedDivider: some View {
        HStack(spacing: DesignConstants.Spacing.step2x) {
            Rectangle()
                .fill(Color.colorBorderSubtle)
                .frame(height: 0.5)
            Text("Pinned")
                .font(.caption2)
                .fontWeight(.medium)
                .foregroundStyle(.colorTextTertiary)
                .textCase(.uppercase)
                .tracking(0.5)
            Rectangle()
                .fill(Color.colorBorderSubtle)
                .frame(height: 0.5)
        }
        .padding(.horizontal, isPhone ? DesignConstants.Spacing.step4x : DesignConstants.Spacing.step6x)
        .padding(.top, DesignConstants.Spacing.stepX)
        .padding(.bottom, DesignConstants.Spacing.step2x)
    }

    var body: some View {
        if wrapper.showsPinnedDivider {
            VStack(alignment: .leading, spacing: 0) {
                conversationRow
                pinnedDivider
            }
        } else {
            conversationRow
        }
    }
}
