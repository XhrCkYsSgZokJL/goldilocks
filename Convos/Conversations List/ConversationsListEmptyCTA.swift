import SwiftUI

struct ConversationsListEmptyCTA: View {
    let onStartConvo: () -> Void
    /// Kept for callers that still pass it; unused in the Goldilocks layout.
    let onJoinConvo: () -> Void

    private var session: GoldilocksSession { GoldilocksSession.shared }

    var body: some View {
        VStack(spacing: 0.0) {
            VStack(alignment: .leading, spacing: DesignConstants.Spacing.step4x) {
                Text("Setting up your channels…")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                    .foregroundStyle(.colorTextPrimary)
                Text("\(BrandConfig.shared.brand.name) is provisioning your private channels. They\u{2019}ll appear here in a moment.")
                    .font(.callout)
                    .foregroundStyle(.colorTextSecondary)
                if let setupError = session.lastError {
                    setupTroubleSection(error: setupError)
                } else {
                    progressSection
                }
            }
            .frame(maxWidth: UIDevice.current.userInterfaceIdiom == .phone ? .infinity : 370, alignment: .topLeading)
            .padding(40)
            .background(.colorFillMinimal)
            .cornerRadius(32.0)
        }
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .padding(DesignConstants.Spacing.step6x)
        .background(.colorBackgroundSurfaceless)
    }

    private var progressSection: some View {
        HStack(spacing: DesignConstants.Spacing.step3x) {
            ProgressView()
                .controlSize(.regular)
            Text("This usually takes a few seconds.")
                .font(.footnote)
                .foregroundStyle(.colorTextSecondary)
        }
    }

    /// Shown when registration/provisioning is failing. The session keeps
    /// retrying with backoff on its own; this names the problem instead of
    /// spinning forever, and the button skips the current backoff sleep.
    private func setupTroubleSection(error: String) -> some View {
        VStack(alignment: .leading, spacing: DesignConstants.Spacing.step2x) {
            HStack(spacing: DesignConstants.Spacing.step2x) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.colorTextSecondary)
                Text("Having trouble reaching \(BrandConfig.shared.brand.name) — retrying automatically.")
                    .font(.footnote)
                    .foregroundStyle(.colorTextSecondary)
            }
            Text(error)
                .font(.caption2)
                .foregroundStyle(.colorTextSecondary)
                .lineLimit(3)
            let retryAction = { session.retryNow() }
            Button(action: retryAction) {
                Text("Retry now")
                    .font(.footnote)
                    .fontWeight(.semibold)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("channels-setup-retry-button")
        }
    }
}

#Preview {
    ConversationsListEmptyCTA {
    } onJoinConvo: {
    }
}
