import ConvosCore
import ConvosLogging
import SwiftUI
import UIKit
import WebKit

@MainActor
final class HTMLContentPrewarmer {
    static let shared: HTMLContentPrewarmer = HTMLContentPrewarmer()

    struct PrewarmedContent {
        let webView: WKWebView
        let bodyBackgroundColor: Color?
    }

    private static let cacheLimit: Int = 5
    private static let loadTimeout: TimeInterval = 15.0
    private static let paintDelay: TimeInterval = 0.3
    private static let fallbackPrewarmSize: CGSize = CGSize(width: 430, height: 932)

    private var cache: [(key: String, content: PrewarmedContent)] = []
    private var pendingQueue: [(key: String, fileURL: URL)] = []
    private var queuedKeys: Set<String> = []
    private var isProcessing: Bool = false

    private var offscreenWindow: UIWindow? {
        if let existing = _offscreenWindow { return existing }
        let created = Self.makeOffscreenWindow()
        _offscreenWindow = created
        return created
    }
    private var _offscreenWindow: UIWindow?

    private static func makeOffscreenWindow() -> UIWindow? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState != .unattached }
        guard let scene else { return nil }
        let window = UIWindow(windowScene: scene)
        let size: CGSize = currentPrewarmSize(scene: scene)
        window.frame = CGRect(
            x: -100_000.0,
            y: -100_000.0,
            width: size.width,
            height: size.height
        )
        window.windowLevel = .normal - 1
        window.isUserInteractionEnabled = false
        window.isHidden = false
        return window
    }

    private static func currentPrewarmSize(scene: UIWindowScene? = nil) -> CGSize {
        let resolvedScene: UIWindowScene? = scene ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState != .unattached }
        guard let resolvedScene else { return fallbackPrewarmSize }
        let bounds: CGRect = resolvedScene.screen.bounds
        guard bounds.width > 0, bounds.height > 0 else { return fallbackPrewarmSize }
        return bounds.size
    }

    func prewarm(attachmentKey: String, fileURL: URL) {
        if cache.contains(where: { $0.key == attachmentKey }) {
            promote(attachmentKey: attachmentKey)
            return
        }
        if queuedKeys.contains(attachmentKey) { return }
        queuedKeys.insert(attachmentKey)
        pendingQueue.append((key: attachmentKey, fileURL: fileURL))
        processQueueIfIdle()
    }

    func borrowContent(for attachmentKey: String) -> PrewarmedContent? {
        guard let index = cache.firstIndex(where: { $0.key == attachmentKey }) else { return nil }
        let entry = cache.remove(at: index)
        entry.content.webView.removeFromSuperview()
        return entry.content
    }

    private func promote(attachmentKey: String) {
        guard let index = cache.firstIndex(where: { $0.key == attachmentKey }) else { return }
        let entry = cache.remove(at: index)
        cache.append(entry)
    }

    private func processQueueIfIdle() {
        guard !isProcessing else { return }
        guard !pendingQueue.isEmpty else { return }
        let next = pendingQueue.removeFirst()
        isProcessing = true
        Task { @MainActor [weak self] in
            await self?.performPrewarm(attachmentKey: next.key, fileURL: next.fileURL)
            self?.queuedKeys.remove(next.key)
            self?.isProcessing = false
            self?.processQueueIfIdle()
        }
    }

    private func performPrewarm(attachmentKey: String, fileURL: URL) async {
        guard let window = offscreenWindow else {
            Log.error("HTMLContentPrewarmer: no offscreen window available; skipping prewarm of \(attachmentKey)")
            return
        }
        let coordinator = PrewarmCoordinator()
        let config = WKWebViewConfiguration()
        config.userContentController.add(coordinator, name: HTMLBodyBackgroundBridge.messageHandlerName)
        config.userContentController.addUserScript(HTMLBodyBackgroundBridge.makeUserScript())
        let size: CGSize = Self.currentPrewarmSize()
        let webView = WKWebView(
            frame: CGRect(origin: .zero, size: size),
            configuration: config
        )
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.navigationDelegate = coordinator
        window.addSubview(webView)
        let readAccessURL = fileURL.deletingLastPathComponent()
        webView.loadFileURL(fileURL, allowingReadAccessTo: readAccessURL)
        let success: Bool = await coordinator.waitForLoad(timeout: Self.loadTimeout, paintDelay: Self.paintDelay)
        guard success else {
            webView.stopLoading()
            webView.removeFromSuperview()
            return
        }
        let entry: PrewarmedContent = PrewarmedContent(
            webView: webView,
            bodyBackgroundColor: coordinator.bodyBackgroundColor
        )
        insert(attachmentKey: attachmentKey, content: entry)
    }

    private func insert(attachmentKey: String, content: PrewarmedContent) {
        cache.removeAll { $0.key == attachmentKey }
        cache.append((key: attachmentKey, content: content))
        while cache.count > Self.cacheLimit {
            let dropped = cache.removeFirst()
            dropped.content.webView.stopLoading()
            dropped.content.webView.removeFromSuperview()
        }
    }
}

private final class PrewarmCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private(set) var bodyBackgroundColor: Color?
    private var didFinishContinuation: CheckedContinuation<Bool, Never>?
    private var finished: Bool = false

    func waitForLoad(timeout: TimeInterval, paintDelay: TimeInterval) async -> Bool {
        let success: Bool = await withCheckedContinuation { continuation in
            self.didFinishContinuation = continuation
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.complete(success: false)
            }
        }
        guard success else { return false }
        try? await Task.sleep(for: .seconds(paintDelay))
        return true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        complete(success: true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
        Log.error("HTMLContentPrewarmer load failed: \(error.localizedDescription)")
        complete(success: false)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        Log.error("HTMLContentPrewarmer provisional load failed: \(error.localizedDescription)")
        complete(success: false)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == HTMLBodyBackgroundBridge.messageHandlerName,
              let raw = message.body as? String else { return }
        bodyBackgroundColor = HTMLBodyBackgroundBridge.parseCSSColor(raw)
    }

    private func complete(success: Bool) {
        guard !finished else { return }
        finished = true
        didFinishContinuation?.resume(returning: success)
        didFinishContinuation = nil
    }
}
