import Foundation

#if canImport(Sentry)
import Sentry
#endif

/// Structured security-event emitter — the iOS twin of the backend's
/// `src/observability/security-events.ts`. Every interesting security
/// event in the app funnels through here so:
///   1. The wording is consistent across sites (a single `security:`
///      prefix in the log stream + a Sentry breadcrumb with the same
///      shape).
///   2. Identifiers like `inboxId` / `deviceId` are truncated by
///      default. We carry enough prefix to correlate events in an
///      investigation, but not enough to reconstruct an identity from
///      logs alone.
///   3. Nothing secret ever lands in a record. Tokens, signatures, and
///      SIWE messages must not be passed through `context:` — by
///      construction the helpers below never accept them.
///
/// Severity legend matches the backend:
///   - info: routine, expected
///   - warn: anomalous, investigate at scale
///   - critical: security incident; surfaces as a Sentry warning event
public enum SecurityLog {
    public enum Event: String {
        // Authentication
        case authTokenRefreshed = "auth.token.refreshed"
        case authRefreshAttempted = "auth.refresh.attempted"
        case authRefreshRotationFailed = "auth.refresh.rotation_failed"
        case authRefreshFamilyRevoked = "auth.refresh.family_revoked_locally"
        case authLogout = "auth.logout"
        // Networking / pinning
        case pinningMismatch = "pinning.mismatch"
        case pinningSucceeded = "pinning.succeeded"
        // Capture
        case screenshotAttempted = "capture.screenshot_attempted"
        case screenRecordingStarted = "capture.recording_started"
        case secureWindowInstallFailed = "secure_window.install_failed"
    }

    public enum Severity {
        case info, warn, critical
    }

    /// Emit a security event. Pass identifiers through `inboxId:` /
    /// `deviceId:` rather than baking them into `context:` — the helper
    /// truncates them. `context` is for small, structured labels
    /// (strings, ints, bools); never pass token material here.
    public static func event(
        _ kind: Event,
        severity: Severity = .info,
        inboxId: String? = nil,
        deviceId: String? = nil,
        context: [String: String] = [:],
    ) {
        var safe: [String: String] = context
        if let inboxId { safe["inboxId"] = redacted(inboxId) }
        if let deviceId { safe["deviceId"] = redacted(deviceId) }

        let message = "security: \(kind.rawValue)"
        switch severity {
        case .info: Log.info(formatMessage(message, fields: safe))
        case .warn: Log.warning(formatMessage(message, fields: safe))
        case .critical: Log.error(formatMessage(message, fields: safe))
        }

        #if canImport(Sentry)
        let breadcrumb = Breadcrumb()
        breadcrumb.category = "security"
        breadcrumb.type = "info"
        breadcrumb.message = kind.rawValue
        breadcrumb.level = sentryLevel(for: severity)
        breadcrumb.data = safe
        SentrySDK.addBreadcrumb(breadcrumb)

        // Critical events also surface as a Sentry message so they show
        // up on the dashboard, not just inside a future crash's
        // breadcrumb trail.
        if severity == .critical {
            SentrySDK.capture(message: "security: \(kind.rawValue)") { scope in
                scope.setLevel(sentryLevel(for: severity))
                scope.setTag(value: "security", key: "event_class")
                for (key, value) in safe {
                    scope.setTag(value: value, key: key)
                }
            }
        }
        #endif
    }

    // MARK: - Helpers

    /// Truncate an identifier to its first 8 chars + ellipsis — enough
    /// for human correlation across events, but not enough to recover
    /// the full value from logs alone.
    public static func redacted(_ id: String, prefix: Int = 8) -> String {
        guard id.count > prefix else { return id }
        return "\(id.prefix(prefix))…"
    }

    private static func formatMessage(_ msg: String, fields: [String: String]) -> String {
        if fields.isEmpty { return msg }
        let pairs = fields.keys.sorted().map { "\($0)=\(fields[$0] ?? "")" }.joined(separator: " ")
        return "\(msg) \(pairs)"
    }

    #if canImport(Sentry)
    private static func sentryLevel(for severity: Severity) -> SentryLevel {
        switch severity {
        case .info: return .info
        case .warn: return .warning
        case .critical: return .warning
        }
    }
    #endif
}
