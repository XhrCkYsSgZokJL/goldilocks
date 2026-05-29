import ConvosCore
import SwiftUI

/// In-app Privacy Policy and Terms of Service, pushed from App Settings.
///
/// This is starter copy so the app has real text to show. It is not legal
/// advice. Have counsel review and adjust it (entity name, jurisdiction,
/// contact details) before launch.
struct LegalView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignConstants.Spacing.step6x) {
                policySection(title: "Privacy Policy", blocks: Self.privacyPolicy)
                policySection(title: "Terms of Service", blocks: Self.termsOfService)
                Text("Last updated May 2026.")
                    .font(.footnote)
                    .foregroundStyle(.colorTextTertiary)
            }
            .padding(DesignConstants.Spacing.step4x)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollContentBackground(.hidden)
        .background(.colorBackgroundRaisedSecondary)
        .navigationTitle("Privacy & Terms")
        .toolbarTitleDisplayMode(.inline)
    }

    private func policySection(title: String, blocks: [LegalBlock]) -> some View {
        VStack(alignment: .leading, spacing: DesignConstants.Spacing.step4x) {
            Text(title)
                .font(.title)
                .fontWeight(.bold)
                .foregroundStyle(.colorTextPrimary)
            ForEach(blocks.indices, id: \.self) { index in
                blockView(blocks[index])
            }
        }
    }

    private func blockView(_ block: LegalBlock) -> some View {
        VStack(alignment: .leading, spacing: DesignConstants.Spacing.stepX) {
            if let heading = block.heading {
                Text(heading)
                    .font(.headline)
                    .foregroundStyle(.colorTextPrimary)
            }
            Text(block.text)
                .font(.subheadline)
                .foregroundStyle(.colorTextSecondary)
        }
    }
}

/// One paragraph of legal copy, with an optional sub-heading above it.
private struct LegalBlock {
    var heading: String?
    var text: String
}

extension LegalView {
    private static let privacyPolicy: [LegalBlock] = [
        LegalBlock(
            heading: nil,
            text: "Goldilocks Digital helps you secure your digital life. This policy "
                + "explains what information the app handles, and just as importantly, "
                + "what it doesn't."
        ),
        LegalBlock(
            heading: "Your messages",
            text: "Conversations in the app are carried over the XMTP messaging protocol "
                + "and are end-to-end encrypted. We cannot read them, and they are not "
                + "stored on our servers in a form anyone but you and your recipients can read."
        ),
        LegalBlock(
            heading: "People on your plan",
            text: "The names, emails, and phone numbers you enter for people on your "
                + "subscription are stored only on your device. We never upload that "
                + "information to our servers. When you tap “Send to Advisory”, the list "
                + "is delivered to your advisory group as an end-to-end encrypted message."
        ),
        LegalBlock(
            heading: "Account and device data",
            text: "To operate the service we process a small amount of technical data: "
                + "your messaging inbox identifier, a device token used for push "
                + "notifications, and which subscription plan you are on. This is not tied "
                + "to your name or contact details."
        ),
        LegalBlock(
            heading: "Push notifications",
            text: "If you allow notifications, Apple's Push Notification service delivers "
                + "alerts about new messages to your device."
        ),
        LegalBlock(
            heading: "Payments",
            text: "When in-app billing becomes available, payments are processed by "
                + "third-party providers: card payments through Stripe, and crypto "
                + "payments through a separate provider. They handle your payment details "
                + "under their own privacy policies; we do not store full card numbers or "
                + "wallet credentials."
        ),
        LegalBlock(
            heading: "Diagnostics",
            text: "We may collect anonymized crash and performance data to keep the app "
                + "reliable."
        ),
        LegalBlock(
            heading: "No ads, no data sales",
            text: "We do not sell your personal information and we do not show advertising."
        ),
        LegalBlock(
            heading: "Your controls",
            text: "You can remove people from your plan at any time, and you can erase all "
                + "app data from Settings."
        ),
        LegalBlock(
            heading: "Contact",
            text: "Questions about privacy? Email us at support@goldilocksdigital.xyz."
        ),
    ]

    private static let termsOfService: [LegalBlock] = [
        LegalBlock(
            heading: nil,
            text: "By downloading or using Goldilocks Digital, you agree to these terms. "
                + "If you do not agree, please do not use the app."
        ),
        LegalBlock(
            heading: "The service",
            text: "Goldilocks Digital is a secure messaging app that connects you with "
                + "digital-asset security advisors."
        ),
        LegalBlock(
            heading: "Eligibility",
            text: "You must be at least 18 years old and able to enter into a binding "
                + "agreement to use the app."
        ),
        LegalBlock(
            heading: "Your account and keys",
            text: "Your identity is secured by cryptographic keys held on your device. "
                + "Because your messages are end-to-end encrypted, we cannot recover your "
                + "account or message history if you lose access to your device. Keep your "
                + "device secure."
        ),
        LegalBlock(
            heading: "Acceptable use",
            text: "Do not use the app to break the law, harass or harm others, or attempt "
                + "to disrupt or compromise the security of the service."
        ),
        LegalBlock(
            heading: "Subscriptions and billing",
            text: "Paid plans (Light and Active) are billed at the per-seat rates shown in "
                + "the app. When in-app billing is live, charges are handled by our payment "
                + "providers, and any refund or proration terms will be presented at "
                + "checkout. You can change or remove your plan from within the app."
        ),
        LegalBlock(
            heading: "Advisory content",
            text: "Information and recommendations from advisors are provided to help you "
                + "make your own decisions. They are not legal, financial, or investment "
                + "advice, and you remain solely responsible for decisions about your assets."
        ),
        LegalBlock(
            heading: "Availability",
            text: "We work to keep the service running smoothly but do not guarantee that "
                + "it will always be available, uninterrupted, or error-free."
        ),
        LegalBlock(
            heading: "Disclaimer and liability",
            text: "The app is provided “as is”, without warranties of any kind. To the "
                + "fullest extent permitted by law, Goldilocks Digital is not liable for "
                + "indirect, incidental, or consequential losses arising from your use of "
                + "the app."
        ),
        LegalBlock(
            heading: "Changes to these terms",
            text: "We may update these terms from time to time. If you keep using the app "
                + "after an update, you accept the revised terms."
        ),
        LegalBlock(
            heading: "Contact",
            text: "Questions about these terms? Email us at support@goldilocksdigital.xyz."
        ),
    ]
}

#Preview {
    NavigationStack {
        LegalView()
    }
}
