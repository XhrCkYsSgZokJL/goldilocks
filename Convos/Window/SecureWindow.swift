import ConvosCore
import UIKit

/// Blocks screenshots and screen recordings system-wide by hosting the
/// app inside a hidden `UITextField` with `isSecureTextEntry = true`.
///
/// **How it works.** When a text field's secure entry is active, UIKit
/// substitutes a blacked-out frame for the contents of any layer hosted
/// under the field's private secure-canvas layer. We move the app's
/// window layer underneath that canvas: the OS treats every pixel as
/// secure, so screenshots, screen recordings, AirPlay mirroring, and
/// CallKit screen sharing all render the app as black.
///
/// **What's blocked.**
/// - System screenshot (Side + Volume Up): produces a blank image.
/// - Screen Recording (Control Center): the app's content area is black
///   in the recording while other apps still record normally.
/// - AirPlay mirroring / SharePlay / CarPlay mirroring: same as above.
///
/// **What isn't blocked.**
/// - Someone pointing a second device's camera at the screen.
/// - A jailbroken device with system-level capture overrides.
/// - Accessibility services capturing pixels for VoiceOver labeling do
///   continue to work — that's by design.
///
/// **Stability caveats.** The technique relies on internal `UILayer`
/// behaviour that's been stable across many iOS versions (Robinhood,
/// Wealthfront, and several banking apps ship it), but it isn't
/// formally guaranteed by Apple. Test on every iOS version bump. If a
/// future iOS changes the layer hierarchy and breaks this, the visible
/// behaviour is "screenshots aren't blocked" — the app keeps working.
///
/// **Debug builds.** Engineers need screenshots for bug reports. We
/// compile this off behind `DEBUG_DISABLE_SECURE_WINDOW` (set in
/// `Dev.xcconfig`). Production / TestFlight builds always have it on.
public enum SecureWindow {
    /// Installs the secure-canvas trick on the first key UIWindow the
    /// app creates. Safe to call multiple times — only the first call
    /// has any effect. Call from `AppDelegate.didFinishLaunching`.
    @MainActor
    public static func installWhenWindowAppears() {
        #if DEBUG_DISABLE_SECURE_WINDOW
        return
        #else
        Coordinator.shared.start()
        #endif
    }

    // MARK: - Private wiring

    @MainActor
    private final class Coordinator {
        static let shared: Coordinator = Coordinator()
        private var observer: NSObjectProtocol?
        private var installedOnWindow: ObjectIdentifier?

        func start() {
            guard observer == nil, installedOnWindow == nil else { return }
            observer = NotificationCenter.default.addObserver(
                forName: UIWindow.didBecomeVisibleNotification,
                object: nil,
                queue: .main,
            ) { [weak self] notification in
                guard let window = notification.object as? UIWindow else { return }
                MainActor.assumeIsolated {
                    self?.installIfNeeded(on: window)
                }
            }
        }

        private func installIfNeeded(on window: UIWindow) {
            let id = ObjectIdentifier(window)
            guard installedOnWindow != id else { return }
            installedOnWindow = id

            let field = UITextField()
            field.isSecureTextEntry = true
            field.isUserInteractionEnabled = false
            field.translatesAutoresizingMaskIntoConstraints = false
            window.addSubview(field)
            NSLayoutConstraint.activate([
                field.centerXAnchor.constraint(equalTo: window.centerXAnchor),
                field.centerYAnchor.constraint(equalTo: window.centerYAnchor),
            ])

            // Re-parent the window's layer under the text field's secure
            // canvas. The secure canvas is the first sublayer iOS adds
            // to a UITextField when `isSecureTextEntry` is on.
            guard let secureCanvas = field.layer.sublayers?.first,
                  let parentLayer = window.layer.superlayer else {
                SecurityLog.event(
                    .secureWindowInstallFailed,
                    severity: .critical,
                    context: ["reason": "secure_canvas_layer_not_found"],
                )
                field.removeFromSuperview()
                installedOnWindow = nil
                return
            }
            parentLayer.addSublayer(field.layer)
            secureCanvas.addSublayer(window.layer)

            if let observer {
                NotificationCenter.default.removeObserver(observer)
                self.observer = nil
            }
        }
    }
}
