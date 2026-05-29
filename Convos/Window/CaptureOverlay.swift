import SwiftUI

/// A SwiftUI overlay that becomes visible while the screen is being
/// recorded (`UIScreen.main.isCaptured` is true). `SecureWindow`
/// already neutralises the captured frame at the OS level — the
/// resulting recording shows our content as black. This overlay is
/// the matching cue *for the user*: a soft blur + caption that makes
/// it explicit the app knows capture is on and is shielding content.
///
/// Apply at the root of the SwiftUI scene with `.captureProtected()`.
public struct CaptureOverlayModifier: ViewModifier {
    private let monitor: CaptureMonitor

    public init(monitor: CaptureMonitor) {
        self.monitor = monitor
    }

    public func body(content: Content) -> some View {
        ZStack {
            content
            if monitor.isCapturing {
                Color.black.opacity(0.0)
                    .background(.ultraThinMaterial)
                    .ignoresSafeArea()
                    .overlay(alignment: .center) {
                        VStack(spacing: 12) {
                            Image(systemName: "rectangle.on.rectangle.slash")
                                .font(.system(size: 40, weight: .light))
                            Text("Screen recording detected")
                                .font(.headline)
                            Text("Goldilocks content is hidden while recording.")
                                .font(.subheadline)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 32)
                        }
                        .foregroundStyle(.primary)
                    }
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: monitor.isCapturing)
    }
}

public extension View {
    /// Layer a blur + caption over the receiver whenever the system
    /// reports a screen recording is active. Pair with
    /// `SecureWindow.installWhenWindowAppears()` for the at-rest
    /// (compositor-level) block.
    func captureProtected(monitor: CaptureMonitor) -> some View {
        modifier(CaptureOverlayModifier(monitor: monitor))
    }
}
