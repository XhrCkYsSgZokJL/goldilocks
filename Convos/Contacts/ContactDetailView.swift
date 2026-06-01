import ConvosCore
import SwiftUI

struct ContactDetailView: View {
    let contact: Contact
    let mode: ContactDetailMode
    let showsCloseButton: Bool
    private let contactsWriter: any ContactsWriterProtocol
    private let contactsRepository: any ContactsRepositoryProtocol
    private let session: (any SessionManagerProtocol)?
    private let onRemove: (() -> Void)?

    @Environment(\.dismiss) private var dismiss: DismissAction
    @State private var isBlocked: Bool
    @State private var isApplyingBlockChange: Bool = false
    @State private var presentingBlockConfirmation: Bool = false

    init(
        contact: Contact,
        mode: ContactDetailMode = .standalone,
        contactsWriter: any ContactsWriterProtocol,
        contactsRepository: any ContactsRepositoryProtocol,
        session: (any SessionManagerProtocol)? = nil,
        showsCloseButton: Bool = true,
        onRemove: (() -> Void)? = nil
    ) {
        self.contact = contact
        self.mode = mode
        self.contactsWriter = contactsWriter
        self.contactsRepository = contactsRepository
        self.session = session
        self.showsCloseButton = showsCloseButton
        self.onRemove = onRemove
        _isBlocked = State(initialValue: contact.isBlocked)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    avatarSection
                    infoSection
                    actionsSection
                }
                .padding()
            }
            .background(Color.colorBackgroundRaisedSecondary.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsCloseButton {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
            }
            .confirmationDialog(
                "Block \(contact.resolvedDisplayName)?",
                isPresented: $presentingBlockConfirmation,
                titleVisibility: .visible
            ) {
                let action: () -> Void = { toggleBlock() }
                Button("Block", role: .destructive, action: action)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("They won't be able to message you.")
            }
        }
    }

    @ViewBuilder
    private var avatarSection: some View {
        VStack(spacing: 12) {
            AvatarView(
                fallbackName: contact.resolvedDisplayName,
                cacheableObject: contact,
                placeholderImage: nil,
                placeholderImageName: nil,
                agentVerification: contact.agentVerification ?? .unverified
            )
            Text(contact.resolvedDisplayName)
                .font(.title2)
                .fontWeight(.semibold)
            if contact.isVerifiedAgent {
                Label("Verified Agent", systemImage: "checkmark.seal.fill")
                    .font(.caption)
                    .foregroundStyle(.blue)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 24)
    }

    @ViewBuilder
    private var infoSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let convoId = contact.addedViaConversationId {
                HStack {
                    Text("Added via conversation")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer()
                    let truncated: String = String(convoId.prefix(8))
                    Text(truncated)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            HStack {
                Text("Added")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(contact.addedAt, style: .date)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(Color.colorBackgroundRaised, in: .rect(cornerRadius: 12))
    }

    @ViewBuilder
    private var actionsSection: some View {
        if !contact.isAdminContact {
            VStack(spacing: 12) {
                let blockLabel: String = isBlocked ? "Unblock" : "Block"
                Button(role: isBlocked ? nil : .destructive) {
                    if isBlocked {
                        toggleBlock()
                    } else {
                        presentingBlockConfirmation = true
                    }
                } label: {
                    HStack {
                        Image(systemName: isBlocked ? "hand.raised.slash" : "hand.raised")
                        Text(blockLabel)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(isApplyingBlockChange)
            }
        }
    }

    private func toggleBlock() {
        isApplyingBlockChange = true
        Task {
            do {
                if isBlocked {
                    try await contactsWriter.unblock(inboxId: contact.inboxId)
                } else {
                    try await contactsWriter.block(inboxId: contact.inboxId)
                }
                isBlocked.toggle()
            } catch {
                Log.error("Failed to toggle block state: \(error.localizedDescription)")
            }
            isApplyingBlockChange = false
        }
    }
}

#Preview {
    ContactDetailView(
        contact: .mock(),
        contactsWriter: MockContactsWriter(),
        contactsRepository: MockContactsRepository()
    )
}
