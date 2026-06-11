import ConvosCore
import Observation
import UIKit

/// Listens for screenshot and screen-recording events and reports them
/// to Sentry. `SecureWindow` already blocks the capture itself
/// system-side; this just gives us a signal that someone tried.
@Observable
@MainActor
public final class CaptureMonitor {
    public private(set) var isCapturing: Bool = false

    private var captureObserver: NSObjectProtocol?
    private var screenshotObserver: NSObjectProtocol?

    public init() {}

    /// True when any connected scene's screen is being captured.
    /// `UIScreen.main` is deprecated in iOS 26; capture state is read
    /// from the scenes instead (also handles multi-scene correctly).
    private var isAnyScreenCaptured: Bool {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .contains { $0.screen.isCaptured }
    }

    /// Begin observing capture / screenshot notifications. Idempotent —
    /// call once from `AppDelegate.didFinishLaunching`.
    public func start() {
        guard captureObserver == nil, screenshotObserver == nil else { return }

        isCapturing = isAnyScreenCaptured

        captureObserver = NotificationCenter.default.addObserver(
            forName: UIScreen.capturedDidChangeNotification,
            object: nil,
            queue: .main,
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleCaptureChange()
            }
        }

        screenshotObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.userDidTakeScreenshotNotification,
            object: nil,
            queue: .main,
        ) { _ in
            MainActor.assumeIsolated {
                SecurityLog.event(.screenshotAttempted, severity: .warn)
            }
        }
    }

    private func handleCaptureChange() {
        let nowCapturing = isAnyScreenCaptured
        guard nowCapturing != isCapturing else { return }
        isCapturing = nowCapturing
        if nowCapturing {
            SecurityLog.event(.screenRecordingStarted, severity: .warn)
        }
    }
}
