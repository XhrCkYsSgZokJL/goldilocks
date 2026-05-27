import ConvosCore
import Foundation
import SwiftUI

/// Admin screen: review and manage a client's people list. Reached by
/// tapping an "Advisory #N" row in `AdminChannelsView`.
///
/// The list is decrypted with that client's Advisory group key, which the
/// admin holds by being a member of the group — the backend never sees it
/// in plaintext.
///
/// Each person is verified by an email-code handshake when the client
/// adds them, so admins no longer approve or reject; the admin's only
/// per-person control is a kill switch:
///   - Enabled people are subscribed to the third-party service and
///     count toward the client's billing.
///   - Disabled people stay on the list (for audit + easy re-enable) but
///     don't drive cost or hold an active subscription.
struct AdminClientPeopleListView: View {
    let channel: ConvosAPI.GoldilocksAdminChannel
    let session: any SessionManagerProtocol

    @Environment(\.dismiss) private var dismiss: DismissAction
    @State private var members: [SeatMember] = []
    @State private var listVersion: Int = 0
    @State private var isLoading: Bool = true
    @State private var statusMessage: String?
    @State private var savingMemberIds: Set<UUID> = []
    @State private var expandedMemberId: UUID?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Advisory #\(channel.clientNumber)")
                .toolbarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(role: .cancel) { dismiss() }
                    }
                }
                .task { await load() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            peopleList
        }
    }

    private var peopleList: some View {
        let enabled: [SeatMember] = members.filter { $0.enabled }
        let disabled: [SeatMember] = members.filter { !$0.enabled }
        return List {
            if let statusMessage {
                Section {
                    Text(statusMessage)
                        .font(.footnote)
                        .foregroundStyle(.colorTextSecondary)
                }
            }
            if members.isEmpty {
                Section {
                    Text("This client has no people on their plan yet.")
                        .foregroundStyle(.colorTextSecondary)
                }
            }
            membersSection(title: "Enabled", people: enabled, footer: enabledFooter)
            membersSection(title: "Disabled", people: disabled, footer: disabledFooter)
        }
    }

    private var enabledFooter: String {
        "Enabled people are subscribed to the third-party service and count toward this client's billing."
    }

    private var disabledFooter: String {
        "Disabled people stay on the list for audit. Flip them back on to resubscribe."
    }

    @ViewBuilder
    private func membersSection(title: String, people: [SeatMember], footer: String) -> some View {
        if !people.isEmpty {
            Section {
                ForEach(people) { member in
                    memberRow(member)
                }
            } header: {
                Text("\(title) (\(people.count))")
            } footer: {
                Text(footer)
            }
        }
    }

    private func memberRow(_ member: SeatMember) -> some View {
        let name: String = member.displayName
        let isSaving: Bool = savingMemberIds.contains(member.id)
        let isExpanded: Bool = expandedMemberId == member.id
        let rowOpacity: Double = member.enabled ? 1.0 : 0.6
        let tapAction = {
            expandedMemberId = isExpanded ? nil : member.id
        }
        return VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
            Button(action: tapAction) {
                HStack(spacing: DesignConstants.Spacing.step3x) {
                    Text(name)
                        .font(.body)
                        .foregroundStyle(.colorTextPrimary)
                    Spacer()
                    memberAction(for: member, isSaving: isSaving)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isExpanded {
                expandedDetail(for: member)
            }
        }
        .padding(.vertical, DesignConstants.Spacing.stepX)
        .opacity(rowOpacity)
    }

    @ViewBuilder
    private func expandedDetail(for member: SeatMember) -> some View {
        VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepHalf) {
            ForEach(member.emails) { email in
                let suffix: String = email.verified ? "" : " (unverified)"
                Text("\(email.label.displayName): \(email.address)\(suffix)")
                    .font(.caption)
                    .foregroundStyle(.colorTextSecondary)
            }
            if !member.phone.isEmpty {
                Text("Phone: \(member.phone)")
                    .font(.caption)
                    .foregroundStyle(.colorTextSecondary)
            }
            if !member.address.isEmpty {
                Text(member.address.singleLine)
                    .font(.caption)
                    .foregroundStyle(.colorTextSecondary)
            }
        }
        .padding(.top, DesignConstants.Spacing.stepHalf)
    }

    @ViewBuilder
    private func memberAction(for member: SeatMember, isSaving: Bool) -> some View {
        if isSaving {
            ProgressView()
        } else {
            Toggle("", isOn: enabledBinding(for: member))
                .labelsHidden()
        }
    }

    private func enabledBinding(for member: SeatMember) -> Binding<Bool> {
        Binding(
            get: { member.enabled },
            set: { newValue in
                Task { await setEnabled(member, to: newValue) }
            }
        )
    }

    /// Fetch the client's encrypted blob and decrypt it with their
    /// Advisory group key.
    private func load() async {
        isLoading = true
        statusMessage = nil
        guard let groupId = channel.xmtpGroupId else {
            statusMessage = "This client's Advisory chat isn't ready yet."
            isLoading = false
            return
        }
        do {
            let blob = try await session.fetchAdminPeopleList(clientInboxId: channel.clientInboxId)
            listVersion = blob.version
            guard blob.version > 0,
                  let ciphertext = blob.ciphertext,
                  let salt = blob.salt,
                  let nonce = blob.nonce else {
                members = []
                isLoading = false
                return
            }
            let key: Data = try await session.groupEncryptionKey(forConversationId: groupId)
            members = try PeopleListCrypto.decrypt(ciphertext: ciphertext, salt: salt, nonce: nonce, groupKey: key)
        } catch {
            statusMessage = "Couldn't load this client's people list: \(error.localizedDescription)"
        }
        isLoading = false
    }

    /// Flip a person's enabled flag, re-encrypt the list, and save it.
    /// On success, posts an audit line into the client's Advisory chat.
    private func setEnabled(_ member: SeatMember, to newValue: Bool) async {
        guard let groupId = channel.xmtpGroupId else { return }
        guard let index = members.firstIndex(where: { $0.id == member.id }) else { return }
        var updated: [SeatMember] = members
        updated[index].enabled = newValue
        let auditLine: String = GoldilocksPeopleAudit.enabledLine(for: updated[index], enabled: newValue)
        await saveMemberChange(updated: updated, memberId: member.id, groupId: groupId, auditLine: auditLine)
    }

    private func saveMemberChange(
        updated: [SeatMember],
        memberId: UUID,
        groupId: String,
        auditLine: String?
    ) async {
        savingMemberIds.insert(memberId)
        statusMessage = nil
        do {
            let key: Data = try await session.groupEncryptionKey(forConversationId: groupId)
            let blob: PeopleListCrypto.EncryptedBlob = try PeopleListCrypto.encrypt(updated, groupKey: key)
            let newVersion: Int = try await session.saveAdminPeopleList(
                clientInboxId: channel.clientInboxId,
                ciphertext: blob.ciphertext,
                salt: blob.salt,
                nonce: blob.nonce,
                baseVersion: listVersion
            )
            members = updated
            listVersion = newVersion
            if let auditLine {
                await postAuditLine(auditLine, toConversationId: groupId)
            }
        } catch {
            statusMessage = "Couldn't save the change: \(error.localizedDescription)"
        }
        savingMemberIds.remove(memberId)
    }

    /// Send an audit line to the client's Advisory chat. Failures are
    /// logged but not surfaced — the admin's action already succeeded.
    private func postAuditLine(_ line: String, toConversationId conversationId: String) async {
        let writer: any ConversationStateManagerProtocol = session
            .messagingService()
            .conversationStateManager(for: conversationId)
        do {
            try await writer.send(text: line)
        } catch {
            Log.warning("[Goldilocks] Admin audit send failed: \(error.localizedDescription)")
        }
    }
}
