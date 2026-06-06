import ConvosCore
import ConvosLogging
import SwiftUI
import WebKit

struct HTMLAttachmentPreviewSheet: View {
    let attachment: HydratedAttachment
    let fileURL: URL

    @Environment(\.dismiss) private var dismiss: DismissAction
    @Environment(\.colorScheme) private var colorScheme: ColorScheme
    @State private var htmlBodyBackgroundColor: Color?

    var body: some View {
        NavigationStack {
            AttachmentHTMLContent(
                fileURL: fileURL,
                attachmentKey: attachment.key,
                onBodyBackgroundColor: { color in
                    htmlBodyBackgroundColor = color
                }
            )
            .background(htmlBodyBackgroundColor ?? Color.clear)
            .ignoresSafeArea()
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    let action = { dismiss() }
                    Button(action: action) {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                    .accessibilityIdentifier("html-preview-close")
                }
            }
        }
    }
}

struct AttachmentHTMLContent: UIViewRepresentable {
    let fileURL: URL
    let attachmentKey: String
    var onBodyBackgroundColor: ((Color?) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(onBodyBackgroundColor: onBodyBackgroundColor)
    }

    func makeUIView(context: Context) -> WKWebView {
        if let prewarmed = HTMLContentPrewarmer.shared.borrowContent(for: attachmentKey) {
            let webView = prewarmed.webView
            webView.navigationDelegate = context.coordinator
            context.coordinator.reportedColor = prewarmed.bodyBackgroundColor
            onBodyBackgroundColor?(prewarmed.bodyBackgroundColor)
            return webView
        }

        let config = WKWebViewConfiguration()
        config.userContentController.add(
            context.coordinator,
            name: HTMLBodyBackgroundBridge.messageHandlerName
        )
        config.userContentController.addUserScript(HTMLBodyBackgroundBridge.makeUserScript())

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.navigationDelegate = context.coordinator

        let readAccessURL = fileURL.deletingLastPathComponent()
        webView.loadFileURL(fileURL, allowingReadAccessTo: readAccessURL)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var onBodyBackgroundColor: ((Color?) -> Void)?
        var reportedColor: Color?

        init(onBodyBackgroundColor: ((Color?) -> Void)?) {
            self.onBodyBackgroundColor = onBodyBackgroundColor
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let scheme = url.scheme?.lowercased() ?? ""
            if ["http", "https", "mailto"].contains(scheme) {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == HTMLBodyBackgroundBridge.messageHandlerName,
                  let raw = message.body as? String else { return }
            let color = HTMLBodyBackgroundBridge.parseCSSColor(raw)
            if color != reportedColor {
                reportedColor = color
                onBodyBackgroundColor?(color)
            }
        }
    }
}
