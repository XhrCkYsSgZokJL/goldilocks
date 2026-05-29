import Foundation

/// Thin convenience over `Data.write(to:options:)` that pins a file
/// protection class explicitly, on top of the entitlement-level default.
///
/// The main app's `com.apple.developer.default-data-protection` is set
/// to `NSFileProtectionComplete` (see F8.2 in the encryption plan), so
/// most write sites don't need to specify anything. Use this helper at
/// write sites where the *write itself* needs to happen with the
/// device locked (downloads from a background URLSession, media saved
/// during a Live Activity, etc.) and you want to opt down to
/// `.completeUnlessOpen` deliberately.
public enum ProtectedFile {
    /// Write `data` to `url` atomically, with an explicit
    /// `Data.WritingOptions` file-protection flag layered on top of the
    /// caller's other options. Defaults to `.completeFileProtection`,
    /// matching the app-level entitlement.
    public static func write(
        _ data: Data,
        to url: URL,
        options: Data.WritingOptions = [.atomic, .completeFileProtection],
    ) throws {
        try data.write(to: url, options: options)
    }

    /// Set / replace the protection class on an existing file path. Use
    /// when files arrive via APIs that don't expose `WritingOptions`
    /// (download tasks, third-party SDKs writing into our sandbox).
    public static func setProtection(
        _ level: FileProtectionType,
        on url: URL,
    ) throws {
        try FileManager.default.setAttributes(
            [.protectionKey: level],
            ofItemAtPath: url.path,
        )
    }
}
