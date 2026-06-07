import ConvosCore
import SwiftUI

struct ConversationMemberView: View {
    @Bindable var viewModel: ConversationViewModel
    let member: ConversationMember

    @State private var presentingBlockConfirmation: Bool = false
    @Environment(\.dismiss) private var dismiss: DismissAction

    var body: some View {
        List {
            headerSection

            if member.isAgent {
                agentSections
            } else {
                nonAgentSections
            }
        }
        .scrollContentBackground(.hidden)
        .background(.colorBackgroundRaisedSecondary)
        .alert(
            "Block \(member.profile.displayName) and leave convo?",
            isPresented: $presentingBlockConfirmation
        ) {
            let cancelAction = { presentingBlockConfirmation = false }
            Button("Cancel", role: .cancel, action: cancelAction)
            let confirmAction = { viewModel.blockAndLeaveConvo() }
            Button("Confirm", role: .destructive, action: confirmAction)
        } message: {
            Text("They won't know they're blocked, and you'll leave this conversation so they can't reach you here.")
        }
    }

    private var headerSection: some View {
        Section {
            HStack {
                Spacer()
                VStack(spacing: DesignConstants.Spacing.step4x) {
                    MessageAvatarView(profile: member.profile, size: 160.0, agentVerification: member.agentVerification)

                    VStack(spacing: DesignConstants.Spacing.step2x) {
                        Text(member.profile.displayName)
                            .font(.largeTitle)
                            .fontWeight(.semibold)
                            .foregroundStyle(.colorTextPrimary)

                        if member.isCurrentUser {
                            Text("You")
                                .font(.headline)
                                .foregroundStyle(.colorTextSecondary)
                        } else if let subtitle = memberSubtitle {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(.colorTextSecondary)
                                .multilineTextAlignment(.center)
                        }
                    }
                }
                Spacer()
            }
            .listRowBackground(Color.clear)
        }
        .listSectionMargins(.top, 0.0)
        .listSectionSeparator(.hidden)
    }

    @ViewBuilder
    private var agentSections: some View {
        if viewModel.canRemoveMembers {
            Section {
                let action = {
                    viewModel.remove(member: member)
                    dismiss()
                }
                Button(action: action) {
                    Text("Remove")
                        .font(.body)
                        .foregroundStyle(.colorCaution)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Remove \(member.profile.displayName)")
                .accessibilityIdentifier("remove-member-button")
            } footer: {
                Text("Dismiss and destroy \(member.profile.displayName)")
                    .foregroundStyle(.colorTextSecondary)
            }
        }

        if canBlockMember {
            Section {
                let action = { presentingBlockConfirmation = true }
                Button(action: action) {
                    Text("Block and leave")
                        .font(.body)
                        .foregroundStyle(.colorCaution)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Block \(member.profile.displayName)")
                .accessibilityIdentifier("block-member-button")
            } footer: {
                Text("Leave this convo and block \(member.profile.displayName)")
                    .foregroundStyle(.colorTextSecondary)
            }
        }
    }

    @ViewBuilder
    private var nonAgentSections: some View {
        if !member.isCurrentUser {
            if viewModel.canRemoveMembers {
                Section {
                    let action = {
                        viewModel.remove(member: member)
                        dismiss()
                    }
                    Button(action: action) {
                        Text("Remove")
                            .font(.body)
                            .foregroundStyle(.colorCaution)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Remove \(member.profile.displayName)")
                    .accessibilityIdentifier("remove-member-button")
                } footer: {
                    Text("Remove \(member.profile.displayName) from the convo")
                        .foregroundStyle(.colorTextSecondary)
                }
            }

            if canBlockMember {
                Section {
                    let action = { presentingBlockConfirmation = true }
                    Button(action: action) {
                        Text("Block and leave")
                            .font(.body)
                            .foregroundStyle(.colorCaution)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Block \(member.profile.displayName)")
                    .accessibilityIdentifier("block-member-button")
                } footer: {
                    Text("Leave this convo and block \(member.profile.displayName)")
                        .foregroundStyle(.colorTextSecondary)
                }
            }
        }
    }

    private var canBlockMember: Bool {
        if member.isCurrentUser { return false }
        if viewModel.conversation.isPinnedGoldilocksGroup { return false }
        if GoldilocksAgentTrust.contains(inboxId: member.profile.inboxId) { return false }
        if GoldilocksSession.shared.adminInboxIds.contains(member.profile.inboxId) { return false }
        return true
    }

    private func cardRow(title: String) -> some View {
        HStack {
            Text(title)
                .font(.body)
                .foregroundStyle(.colorTextPrimary)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.colorTextTertiary)
        }
    }

    private var memberSubtitle: String? {
        var parts: [String] = []
        if member.isAgent {
            parts.append(Constant.agentLabel)
        }
        if let joinedAt = member.joinedAt {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .abbreviated
            let relative = formatter.localizedString(for: joinedAt, relativeTo: Date())
            if let invitedBy = member.invitedBy {
                parts.append("Added \(relative) by \(invitedBy.displayName)")
            } else {
                parts.append("Added \(relative)")
            }
        } else if let invitedBy = member.invitedBy {
            parts.append("Added by \(invitedBy.displayName)")
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " · ")
    }

    private enum Constant {
        static let agentLabel: String = "IA"
    }
}

#Preview {
    ConversationMemberView(viewModel: .mock, member: .mock())
}
