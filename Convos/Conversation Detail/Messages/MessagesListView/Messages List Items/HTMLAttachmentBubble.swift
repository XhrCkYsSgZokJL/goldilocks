import ConvosCore
import ConvosLogging
import SwiftUI
import UIKit

struct HTMLAttachmentBubble: View {
    let attachment: HydratedAttachment
    let profile: Profile
    var agentVerification: AgentVerification = .unverified
    var onTapAvatar: (() -> Void)?
    var cornerRadiusOverride: CGFloat?
    var transitionNamespace: Namespace.ID?

    @Environment(\.colorScheme) private var colorScheme: ColorScheme
    @State private var renderedImage: UIImage?
    @State private var hasLoadFailed: Bool = false

    var body: some View {
        bubble
            .accessibilityIdentifier("html-attachment-bubble")
            .accessibilityLabel("HTML page from \(profile.displayName)")
            .onAppear(perform: seedFromMemoryCache)
            .task(id: AttachmentColorSchemeKey(key: attachment.key, scheme: colorScheme)) {
                await loadThumbnail()
            }
    }

    @ViewBuilder
    private var bubble: some View {
        let base = preview
            .frame(width: Constant.size, height: Constant.size)
            .background(Color.colorFillMinimal)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        if let transitionNamespace {
            base.matchedTransitionSource(id: attachment.key, in: transitionNamespace)
        } else {
            base
        }
    }

    @ViewBuilder
    private var preview: some View {
        if let renderedImage {
            Image(uiImage: renderedImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: Constant.size, height: Constant.size, alignment: .top)
                .clipped()
        } else {
            ZStack {
                Color.clear
                if hasLoadFailed {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
        }
    }

    private var cornerRadius: CGFloat {
        cornerRadiusOverride ?? Constant.cornerRadius
    }

    private func seedFromMemoryCache() {
        guard renderedImage == nil else { return }
        if let cached = HTMLThumbnailRenderer.shared.cachedThumbnail(
            for: attachment.key,
            appearance: colorScheme.uiUserInterfaceStyle
        ) {
            renderedImage = cached
            hasLoadFailed = false
        }
    }

    private func loadThumbnail() async {
        let appearance = colorScheme.uiUserInterfaceStyle
        if let cached = HTMLThumbnailRenderer.shared.cachedThumbnail(
            for: attachment.key,
            appearance: appearance
        ) {
            renderedImage = cached
            hasLoadFailed = false
            await prewarmLiveContentIfPossible()
            return
        }
        do {
            let fileURL = try await FileAttachmentLoader.loadFile(for: attachment)
            let image = await HTMLThumbnailRenderer.shared.thumbnail(
                for: attachment.key,
                fileURL: fileURL,
                appearance: appearance
            )
            if let image {
                renderedImage = image
                hasLoadFailed = false
            } else if renderedImage == nil {
                hasLoadFailed = true
            }
            HTMLContentPrewarmer.shared.prewarm(attachmentKey: attachment.key, fileURL: fileURL)
        } catch {
            Log.error("Failed to load HTML attachment thumbnail: \(error)")
            if renderedImage == nil {
                hasLoadFailed = true
            }
        }
    }

    private func prewarmLiveContentIfPossible() async {
        do {
            let fileURL = try await FileAttachmentLoader.loadFile(for: attachment)
            HTMLContentPrewarmer.shared.prewarm(attachmentKey: attachment.key, fileURL: fileURL)
        } catch {
            Log.error("Failed to resolve fileURL for HTML prewarm: \(error.localizedDescription)")
        }
    }

    private enum Constant {
        static let size: CGFloat = 160.0
        static let cornerRadius: CGFloat = 20.0
    }
}

struct AttachmentColorSchemeKey: Hashable {
    let key: String
    let scheme: ColorScheme
}

extension ColorScheme {
    var uiUserInterfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .dark: return .dark
        case .light: return .light
        @unknown default: return .light
        }
    }
}
