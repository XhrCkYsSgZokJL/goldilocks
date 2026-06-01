import ConvosCore
import ConvosLogging
import UIKit
import WebKit

@MainActor
final class HTMLThumbnailRenderer {
    static let shared: HTMLThumbnailRenderer = HTMLThumbnailRenderer()

    private static let tileSize: CGSize = CGSize(width: 160, height: 160)
    private static let snapshotOutputWidth: CGFloat = 480.0
    fileprivate static let paintDelay: TimeInterval = 0.5
    private static let loadTimeout: TimeInterval = 15.0
    private static let cacheKeyPrefix: String = "html-thumb-v6-"

    private static let viewportScript: String = """
    (function() {
        var existing = document.querySelectorAll('meta[name="viewport"]');
        for (var i = 0; i < existing.length; i++) {
            existing[i].remove();
        }
        var m = document.createElement('meta');
        m.name = 'viewport';
        m.content = 'width=160, initial-scale=1, viewport-fit=cover';
        (document.head || document.documentElement).appendChild(m);
    })();
    """

    private static let surfaceScript: String = """
    (function() {
        document.documentElement.setAttribute('data-convos-thumbnail', 'true');
        document.documentElement.setAttribute('data-convos-surface', 'small');
    })();
    """

    private var inflight: [String: Task<UIImage?, Never>] = [:]

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
        window.frame = CGRect(
            x: -100_000.0,
            y: -100_000.0,
            width: tileSize.width,
            height: tileSize.height
        )
        window.windowLevel = .normal - 1
        window.isUserInteractionEnabled = false
        window.isHidden = false
        return window
    }

    static func cacheKey(for attachmentKey: String, appearance: UIUserInterfaceStyle) -> String {
        cacheKeyPrefix + attachmentKey + "-" + appearanceSuffix(for: appearance)
    }

    private static func appearanceSuffix(for appearance: UIUserInterfaceStyle) -> String {
        switch appearance {
        case .dark: return "dark"
        case .light, .unspecified: return "light"
        @unknown default: return "light"
        }
    }

    func cachedThumbnail(for attachmentKey: String, appearance: UIUserInterfaceStyle) -> UIImage? {
        ImageCache.shared.image(for: Self.cacheKey(for: attachmentKey, appearance: appearance))
    }

    func thumbnail(for attachmentKey: String, fileURL: URL, appearance: UIUserInterfaceStyle) async -> UIImage? {
        let cacheKey = Self.cacheKey(for: attachmentKey, appearance: appearance)
        if let cached = await ImageCache.shared.imageAsync(for: cacheKey) {
            return cached
        }

        let inflightKey = attachmentKey + "-" + Self.appearanceSuffix(for: appearance)
        if let existing = inflight[inflightKey] {
            return await existing.value
        }

        let task = Task<UIImage?, Never> { [weak self] in
            guard let self else { return nil }
            let image = await self.renderSnapshot(fileURL: fileURL, appearance: appearance)
            if let image {
                ImageCache.shared.cacheImage(image, for: cacheKey, storageTier: .cache)
            }
            return image
        }
        inflight[inflightKey] = task
        let result = await task.value
        inflight.removeValue(forKey: inflightKey)
        return result
    }

    private func renderSnapshot(fileURL: URL, appearance: UIUserInterfaceStyle) async -> UIImage? {
        guard let window = offscreenWindow else {
            Log.error("HTMLThumbnailRenderer: no offscreen window available; skipping render")
            return nil
        }

        let config = WKWebViewConfiguration()
        let surfaceUserScript = WKUserScript(
            source: Self.surfaceScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(surfaceUserScript)
        let viewportUserScript = WKUserScript(
            source: Self.viewportScript,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(viewportUserScript)

        let webView = WKWebView(
            frame: CGRect(origin: .zero, size: Self.tileSize),
            configuration: config
        )
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.isOpaque = true
        webView.isUserInteractionEnabled = false
        webView.overrideUserInterfaceStyle = appearance

        window.addSubview(webView)

        return await withCheckedContinuation { (continuation: CheckedContinuation<UIImage?, Never>) in
            let coordinator = LoadCoordinator(
                captureRect: CGRect(origin: .zero, size: Self.tileSize),
                snapshotWidth: Self.snapshotOutputWidth
            ) { [weak webView] result in
                webView?.removeFromSuperview()
                continuation.resume(returning: result)
            }
            objc_setAssociatedObject(webView, &Self.coordinatorAssocKey, coordinator, .OBJC_ASSOCIATION_RETAIN)
            webView.navigationDelegate = coordinator

            let readAccessURL = fileURL.deletingLastPathComponent()
            webView.loadFileURL(fileURL, allowingReadAccessTo: readAccessURL)

            DispatchQueue.main.asyncAfter(deadline: .now() + Self.loadTimeout) { [weak coordinator, weak webView] in
                coordinator?.resumeIfNeeded(webView: webView, image: nil, reason: "load timed out")
            }
        }
    }

    private nonisolated(unsafe) static var coordinatorAssocKey: UInt8 = 0
}

private final class LoadCoordinator: NSObject, WKNavigationDelegate {
    private let completion: (UIImage?) -> Void
    private let captureRect: CGRect
    private let snapshotWidth: CGFloat
    private var hasResumed: Bool = false

    init(captureRect: CGRect, snapshotWidth: CGFloat, completion: @escaping (UIImage?) -> Void) {
        self.captureRect = captureRect
        self.snapshotWidth = snapshotWidth
        self.completion = completion
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        let captureRect = captureRect
        let snapshotWidth = snapshotWidth
        DispatchQueue.main.asyncAfter(deadline: .now() + HTMLThumbnailRenderer.paintDelay) { [weak self, weak webView] in
            guard let self, !self.hasResumed, let webView else {
                self?.resume(image: nil)
                return
            }
            let snapshotConfig = WKSnapshotConfiguration()
            snapshotConfig.rect = captureRect
            snapshotConfig.snapshotWidth = NSNumber(value: Double(snapshotWidth))
            snapshotConfig.afterScreenUpdates = true
            webView.takeSnapshot(with: snapshotConfig) { image, error in
                if let error {
                    Log.error("HTMLThumbnailRenderer takeSnapshot failed: \(error)")
                }
                self.resume(image: image)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
        Log.error("HTMLThumbnailRenderer load failed: \(error)")
        resume(image: nil)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        Log.error("HTMLThumbnailRenderer provisional load failed: \(error)")
        resume(image: nil)
    }

    private func resume(image: UIImage?) {
        guard !hasResumed else { return }
        hasResumed = true
        completion(image)
    }

    func resumeIfNeeded(webView: WKWebView?, image: UIImage?, reason: String) {
        guard !hasResumed else { return }
        Log.error("HTMLThumbnailRenderer resuming early: \(reason)")
        webView?.stopLoading()
        resume(image: image)
    }
}
