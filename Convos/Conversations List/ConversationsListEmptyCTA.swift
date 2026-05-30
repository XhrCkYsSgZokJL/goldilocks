import SwiftUI

struct ConversationsListEmptyCTA: View {
    let onStartConvo: () -> Void
    /// Kept for callers that still pass it; unused in the Goldilocks layout.
    let onJoinConvo: () -> Void

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
                HStack(spacing: DesignConstants.Spacing.step3x) {
                    ProgressView()
                        .controlSize(.regular)
                    Text("This usually takes a few seconds.")
                        .font(.footnote)
                        .foregroundStyle(.colorTextSecondary)
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
}

#Preview {
    ConversationsListEmptyCTA {
    } onJoinConvo: {
    }
}
