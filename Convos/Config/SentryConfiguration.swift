import ConvosCore
import Foundation

/// Sentry has been temporarily removed from the package graph — Sentry-cocoa's
/// binary XCFramework currently ships a swiftinterface stamped with Swift
/// 5.9.2, which Xcode 26 (Swift 6.3.1 effective-5.10) refuses to consume.
///
/// `configure()` is intentionally a no-op while Sentry is out. Every security
/// event call site in `ConvosCore` / `Convos` is wrapped in
/// `#if canImport(Sentry)`, so local logging continues to work. When Sentry
/// re-ships an XCFramework built with Swift 5.10 or newer, restore this file
/// from git history and re-add the dependency in `ConvosCore/Package.swift`.
enum SentryConfiguration {
    static func configure() {
        Log.info("Sentry disabled: dependency removed pending Swift 5.10+ XCFramework upstream")
    }
}
