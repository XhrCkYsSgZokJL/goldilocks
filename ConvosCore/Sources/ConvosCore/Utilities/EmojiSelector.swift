import CryptoKit
import Foundation

public enum EmojiSelector {
    public static let emojis: [String] = [
        // Objects
        "🥫", "🎸", "🎨", "🎯", "🎪", "🎭", "🎬", "🎤", "🎧", "🎹",
        "🎺", "🎻", "🪘", "🪗", "🎲", "🎮", "🧩", "🪀", "🪁", "🧸",
        "🪆", "🔮", "🧿", "🪬", "🎰", "🛸", "🚀", "⚓️", "🧲", "💎",
        // Nature
        "🌵", "🌊", "🍄", "🌸", "🌈", "🌻", "🌴", "🌲", "🍀", "🌾",
        "🪻", "🪷", "🪹", "🪺", "🌙", "⭐️", "🌍", "🔥", "💧", "🌪️",
        // Animals
        "🦊", "🐙", "🦋", "🐢", "🦩", "🦄", "🐋", "🦈", "🦑", "🐠",
        "🦜", "🦚", "🦢", "🦉", "🦇", "🐝", "🐌", "🦎", "🐲", "🦕",
        // Food
        "🍕", "🌮", "🍩", "🍦", "🥑", "🍎", "🍋", "🍇", "🥝", "🍒",
        "🧁", "🍰", "🍪", "🥨", "🥐", "🧀", "🥗", "🍜", "🍣", "🥟",
    ]

    public static func emoji(for identifier: String) -> String {
        emoji(for: identifier, offset: 0)
    }

    /// Deterministic base emoji for `identifier`, shifted by `offset` slots.
    /// `offset: 0` is the canonical value used for signed slugs and stored
    /// MLS metadata; non-zero offsets are UI-only (see `SuggestedEmojiRotation`).
    public static func emoji(for identifier: String, offset: Int) -> String {
        let data = Data(identifier.utf8)
        let hash = SHA256.hash(data: data)
        let hashBytes = Array(hash)
        let base = Int(hashBytes[0]) % emojis.count
        let count = emojis.count
        let index = ((base + offset) % count + count) % count
        return emojis[index]
    }
}

/// In-memory rotation of the *suggested* (default) conversation emoji so that
/// reopening the same blank draft shows a different icon each time. UI-only:
/// the deterministic `EmojiSelector.emoji(for:)` (offset 0) still drives signed
/// invite slugs and stored group metadata, so nothing persisted changes. The
/// offsets are not persisted — they reset on relaunch, which is fine for a
/// throwaway draft.
public enum SuggestedEmojiRotation {
    private static let lock: NSLock = NSLock()
    nonisolated(unsafe) private static var offsets: [String: Int] = [:]

    public static func offset(for identifier: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return offsets[identifier] ?? 0
    }

    public static func advance(for identifier: String) {
        lock.lock()
        defer { lock.unlock() }
        offsets[identifier, default: 0] += 1
    }
}
