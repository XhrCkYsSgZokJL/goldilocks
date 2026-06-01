import SwiftUI
import WebKit

enum HTMLBodyBackgroundBridge {
    static let messageHandlerName: String = "convosBg"

    static let userScriptSource: String = """
    (function() {
        function postBg() {
            var bg = getComputedStyle(document.body).backgroundColor;
            if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
                bg = getComputedStyle(document.documentElement).backgroundColor;
            }
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.convosBg) {
                window.webkit.messageHandlers.convosBg.postMessage(bg || '');
            }
        }
        postBg();
        window.addEventListener('load', postBg);
    })();
    """

    @MainActor
    static func makeUserScript() -> WKUserScript {
        WKUserScript(
            source: userScriptSource,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
    }

    static func parseCSSColor(_ raw: String) -> Color? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces).lowercased()
        let isRGBA = trimmed.hasPrefix("rgba(")
        let prefix = isRGBA ? "rgba(" : "rgb("
        guard trimmed.hasPrefix(prefix), trimmed.hasSuffix(")") else { return nil }
        let inner = trimmed.dropFirst(prefix.count).dropLast()
        let parts = inner
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count >= 3,
              let red = Double(parts[0]),
              let green = Double(parts[1]),
              let blue = Double(parts[2]) else { return nil }
        let alpha: Double = parts.count >= 4 ? (Double(parts[3]) ?? 1.0) : 1.0
        if alpha < 0.05 { return nil }
        return Color(.sRGB, red: red / 255.0, green: green / 255.0, blue: blue / 255.0, opacity: alpha)
    }
}
