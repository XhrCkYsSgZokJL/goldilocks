import ConvosCore
import SwiftUI

/// Home screen replacement for admin users.
///
/// When `GoldilocksSession.shared.isAdmin == true`, the conversations list
/// is hidden and this view is shown instead. It pulls every client's
/// Advisory + Reports channels from `/v2/admin/channels` and renders a
/// flat list of "Advisory #55" / "Reports #56" rows.
///
/// Tapping a row is a placeholder for now — eventually we'll open the
/// underlying XMTP conversation if the admin's installation is a member.
@MainActor
@Observable
final class AdminChannelsViewModel {
    private(set) var channels: [ConvosAPI.GoldilocksAdminChannel] = []
    private(set) var isLoading: Bool = false
    private(set) var lastError: String?

    let session: any SessionManagerProtocol

    init(session: any SessionManagerProtocol) {
        self.session = session
    }

    /// Number of distinct clients that currently have a subscription plan.
    /// A client owns several channels, so rows are de-duplicated by inbox.
    var planCount: Int {
        Set(
            channels
                .filter { $0.hasSubscription }
                .map { $0.clientInboxId }
        ).count
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            channels = try await session.fetchAdminChannels()
                .sorted { lhs, rhs in
                    if lhs.clientNumber != rhs.clientNumber {
                        return lhs.clientNumber < rhs.clientNumber
                    }
                    return lhs.role < rhs.role
                }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            Log.error("[Admin] Failed to load channels: \(error.localizedDescription)")
        }
    }
}

struct AdminChannelsView: View {
    @State var viewModel: AdminChannelsViewModel
    @State private var selectedAdvisory: SelectedClientAdvisory?

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.channels.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.channels.isEmpty {
                emptyState
            } else {
                channelsList
            }
        }
        .background(.colorBackgroundSurfaceless)
        .task { await viewModel.refresh() }
        .refreshable { await viewModel.refresh() }
        .sheet(item: $selectedAdvisory) { selected in
            AdminClientPeopleListView(channel: selected.channel, session: viewModel.session)
        }
    }

    private var emptyState: some View {
        VStack(spacing: DesignConstants.Spacing.step3x) {
            Image(systemName: "tray")
                .font(.largeTitle)
                .foregroundStyle(.colorTextTertiary)
            Text("No client channels yet")
                .font(.body)
                .foregroundStyle(.colorTextSecondary)
            Text("Channels will appear here once a customer opens their Advisory or Reports channel.")
                .font(.caption)
                .foregroundStyle(.colorTextTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, DesignConstants.Spacing.step6x)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(DesignConstants.Spacing.step6x)
    }

    private var channelsList: some View {
        VStack(spacing: 0) {
            planCountHeader
            List {
                ForEach(viewModel.channels, id: \.uniqueKey) { channel in
                    channelEntry(for: channel)
                        .listRowBackground(rowBackground(for: channel))
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(.colorBackgroundSurfaceless)
        }
    }

    private var planCountHeader: some View {
        let count: Int = viewModel.planCount
        let noun: String = count == 1 ? "plan" : "plans"
        return HStack(spacing: 0) {
            Text("\(count) \(noun)")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.colorTextSecondary)
            Spacer()
        }
        .padding(.horizontal, DesignConstants.Spacing.step4x)
        .padding(.vertical, DesignConstants.Spacing.step2x)
    }

    /// An Advisory row is tappable — it opens the client's people list so
    /// the admin can enable/disable members. Reports rows are inert.
    @ViewBuilder
    private func channelEntry(for channel: ConvosAPI.GoldilocksAdminChannel) -> some View {
        if channel.role == "advisory" {
            let openAction: () -> Void = {
                selectedAdvisory = SelectedClientAdvisory(id: channel.uniqueKey, channel: channel)
            }
            Button(action: openAction) {
                channelRow(for: channel)
            }
            .buttonStyle(.plain)
        } else {
            channelRow(for: channel)
        }
    }

    private func channelRow(for channel: ConvosAPI.GoldilocksAdminChannel) -> some View {
        let isExploded: Bool = channel.status == "exploded"
        let isAdvisory: Bool = channel.role == "advisory"
        let subtitleColor: Color = isExploded ? .colorTextTertiary : .colorTextSecondary
        let rowOpacity: Double = isExploded ? 0.5 : 1.0
        let tier: GoldilocksMembershipTier = GoldilocksMembershipTier(
            monthlyRateCents: channel.monthlyRateCents,
            hasActiveCoverage: channel.coverageActive,
            emeraldEnabled: channel.emeraldMembershipEnabled
        )
        let tierColor: Color = isAdvisory ? tier.accentColor : .colorTextTertiary
        return HStack(spacing: DesignConstants.Spacing.step3x) {
            roleIcon(for: channel)
            VStack(alignment: .leading, spacing: 2) {
                Text(channel.displayTitle)
                    .font(.body)
                    .foregroundStyle(.colorTextPrimary)
                Text(channel.subtitle)
                    .font(.caption)
                    .foregroundStyle(subtitleColor)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(tier.displayName)
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundStyle(tierColor)
                if isExploded {
                    Text("EXPLODED")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundStyle(.colorTextTertiary)
                }
            }
        }
        .opacity(rowOpacity)
        .padding(.vertical, DesignConstants.Spacing.stepX)
    }

    /// Advisory rows carry the client's Bronze/Silver/Gold membership
    /// colour; Reports rows stay neutral.
    private func rowBackground(for channel: ConvosAPI.GoldilocksAdminChannel) -> Color {
        guard channel.role == "advisory" else { return .clear }
        let tier: GoldilocksMembershipTier = GoldilocksMembershipTier(
            monthlyRateCents: channel.monthlyRateCents,
            hasActiveCoverage: channel.coverageActive,
            emeraldEnabled: channel.emeraldMembershipEnabled
        )
        return tier.tintColor
    }

    @ViewBuilder
    private func roleIcon(for channel: ConvosAPI.GoldilocksAdminChannel) -> some View {
        let groupName: String = channel.role == "advisory" ? "Advisory" : channel.role == "reports" ? "Back Office" : ""
        let tier: GoldilocksMembershipTier = GoldilocksMembershipTier(
            monthlyRateCents: channel.monthlyRateCents,
            hasActiveCoverage: channel.coverageActive,
            emeraldEnabled: channel.emeraldMembershipEnabled
        )
        if let imageName = GoldilocksConfig.iconImageName(for: groupName, tier: tier) {
            Image(imageName)
                .resizable()
                .scaledToFill()
                .frame(width: 36, height: 36)
                .clipShape(Circle())
        } else {
            let symbol: String = GoldilocksConfig.iconSymbolName(for: groupName)
            ZStack {
                Circle()
                    .fill(Color.colorFillPrimary.opacity(0.15))
                    .frame(width: 36, height: 36)
                Image(systemName: symbol)
                    .foregroundStyle(.colorFillPrimary)
            }
        }
    }
}

private extension ConvosAPI.GoldilocksAdminChannel {
    var displayTitle: String {
        let role = self.role.prefix(1).uppercased() + self.role.dropFirst()
        return "\(role) #\(clientNumber)"
    }

    var subtitle: String {
        let inboxPreview = String(clientInboxId.prefix(12)) + "…"
        return "\(inboxPreview) · \(status)"
    }

    var uniqueKey: String { "\(clientInboxId)-\(role)" }

    /// True when the client is on a paid plan — i.e. spending anything.
    var hasSubscription: Bool {
        monthlyRateCents > 0
    }
}

/// Identifiable wrapper so a tapped Advisory row can drive `.sheet(item:)`.
private struct SelectedClientAdvisory: Identifiable {
    let id: String
    let channel: ConvosAPI.GoldilocksAdminChannel
}
