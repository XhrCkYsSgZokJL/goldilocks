import ConvosCore
import SwiftUI

struct ComposeFlowView: View {
    @Bindable var conversationsViewModel: ConversationsViewModel
    let session: any SessionManagerProtocol
    @Bindable var quicknameViewModel: QuicknameSettingsViewModel

    private var selfInboxIds: Set<String> {
        if let selfId = GoldilocksSession.shared.identity?.inboxId {
            return [selfId]
        }
        return []
    }

    var body: some View {
        NavigationStack {
            ContactsPickerView(
                mode: .compose,
                contactsRepository: session.messagingService().contactsRepository(),
                alreadyInChatInboxIds: selfInboxIds,
                embedsNavigationStack: false,
                onConfirm: handleProceed
            )
        }
    }

    private func handleProceed(with inboxIds: Set<String>) {
        conversationsViewModel.presentingComposeFlow = false

        let vm = NewConversationViewModel(
            session: session,
            mode: .newConversation
        )
        conversationsViewModel.newConversationViewModel = vm

        if !inboxIds.isEmpty {
            Task {
                try? await Task.sleep(for: .milliseconds(300))
                if let conversationVM = vm.conversationViewModel {
                    try? await conversationVM.addMembersFromContacts(Array(inboxIds))
                }
            }
        }
    }
}
