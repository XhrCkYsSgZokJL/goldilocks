import CryptoKit
import Foundation
import LocalAuthentication
import Security
@preconcurrency import XMTPiOS

// MARK: - Models

protocol XMTPClientKeys {
    var signingKey: any XMTPiOS.SigningKey { get }
    var databaseKey: Data { get }
}

public struct KeychainIdentityKeys: Codable, XMTPClientKeys, Sendable {
    public let privateKey: PrivateKey
    public let databaseKey: Data

    public var signingKey: any SigningKey {
        privateKey
    }

    private enum CodingKeys: String, CodingKey {
        case privateKeyData
        case databaseKey
    }

    static func generate() throws -> KeychainIdentityKeys {
        let privateKey = try generatePrivateKey()
        let databaseKey = try generateDatabaseKey()
        return .init(privateKey: privateKey, databaseKey: databaseKey)
    }

    init(privateKey: PrivateKey, databaseKey: Data) {
        self.privateKey = privateKey
        self.databaseKey = databaseKey
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        databaseKey = try container.decode(Data.self, forKey: .databaseKey)
        let privateKeyData = try container.decode(Data.self, forKey: .privateKeyData)
        privateKey = try PrivateKey(privateKeyData)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(databaseKey, forKey: .databaseKey)
        try container.encode(privateKey.secp256K1.bytes, forKey: .privateKeyData)
    }

    private static func generatePrivateKey() throws -> PrivateKey {
        do {
            return try PrivateKey.generate()
        } catch {
            throw KeychainIdentityStoreError.privateKeyGenerationFailed
        }
    }

    private static func generateDatabaseKey() throws -> Data {
        var key = Data(count: 32) // 256-bit key
        let status: OSStatus = try key.withUnsafeMutableBytes { bytes in
            guard let baseAddress = bytes.baseAddress else {
                throw KeychainIdentityStoreError.keychainOperationFailed(errSecUnknownFormat, "generateDatabaseKey")
            }
            return SecRandomCopyBytes(kSecRandomDefault, 32, baseAddress)
        }

        guard status == errSecSuccess else {
            throw KeychainIdentityStoreError.keychainOperationFailed(status, "generateDatabaseKey")
        }

        return key
    }
}

public struct KeychainIdentity: Codable, Sendable {
    public let inboxId: String
    public let clientId: String
    public let keys: KeychainIdentityKeys
}

// MARK: - Errors

public enum KeychainIdentityStoreError: Error, LocalizedError {
    case keychainOperationFailed(OSStatus, String)
    case dataDecodingFailed(String)
    case privateKeyGenerationFailed
    case identityNotFound(String)

    public var errorDescription: String? {
        switch self {
        case let .keychainOperationFailed(status, operation):
            return "Keychain \(operation) failed with status: \(status)"
        case let .dataDecodingFailed(context):
            return "Failed to decode data for \(context)"
        case .privateKeyGenerationFailed:
            return "Failed to generate private key"
        case let .identityNotFound(context):
            return "Identity not found: \(context)"
        }
    }
}

// MARK: - Keychain Operations

private struct KeychainQuery {
    let account: String
    let service: String
    let accessGroup: String
    let accessible: CFString
    let synchronizable: Bool

    init(
        account: String,
        service: String,
        accessGroup: String,
        accessible: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        synchronizable: Bool = false,
    ) {
        self.account = account
        self.service = service
        self.accessGroup = accessGroup
        self.accessible = accessible
        self.synchronizable = synchronizable
    }

    func toDictionary() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrService as String: service,
            kSecAttrAccessGroup as String: accessGroup,
            kSecAttrAccessible as String: accessible,
            kSecAttrSynchronizable as String: synchronizable
        ]
    }

    func toReadDictionary() -> [String: Any] {
        var query = toDictionary()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        return query
    }
}

// MARK: - Keychain Identity Store

public protocol KeychainIdentityStoreProtocol: Actor {
    func generateKeys() throws -> KeychainIdentityKeys

    /// Writes (or overwrites) the identity.
    func save(inboxId: String, clientId: String, keys: KeychainIdentityKeys) throws -> KeychainIdentity

    /// Returns the identity if one exists, `nil` otherwise.
    func load() throws -> KeychainIdentity?

    /// Synchronous read of the identity slot. Safe because the keychain
    /// daemon owns all concurrency; `SecItemCopyMatching` + JSON decode
    /// touch no actor-isolated state on this type. Callers that need
    /// the identity from a synchronous context (e.g. SessionManager's
    /// service-construction path, which runs under a lock) use this
    /// directly instead of paying an actor hop.
    nonisolated func loadSync() throws -> KeychainIdentity?

    /// Removes the identity. Idempotent.
    func delete() throws
}

/// Secure storage for the user's XMTP identity keys in the device keychain.
///
/// The app holds one identity per install. After F8.1, the identity is
/// **device-bound**: the secp256k1 private key bytes are wrapped by a
/// Secure-Enclave-backed key (via the injected `IdentityKeyWrapper`)
/// before they ever touch the keychain, and the keychain item itself is
/// `ThisDeviceOnly` + non-synchronizable. Restoring on a new device
/// requires re-onboarding via SIWE — a deliberate trade-off so the raw
/// key bytes never exist in an extractable form on disk.
///
/// The item is still stored in the app-group keychain so the
/// Notification Service Extension can read the wrapped blob; unwrapping
/// it requires the SE, which lives on the main device.
public final actor KeychainIdentityStore: KeychainIdentityStoreProtocol {
    // MARK: - Properties

    private let keychainService: String
    private let keychainAccessGroup: String
    private let keyWrapper: any IdentityKeyWrapper

    static let defaultService: String = "org.convos.ios.KeychainIdentityStore.v3"

    /// Optional suffix appended to the keychain account name. Set by the
    /// main app at launch (before any SessionManager is constructed) to
    /// pick which "slot" identities are read from / written to. The dual-
    /// identity Goldilocks dev model uses this to keep an admin key and a
    /// client key persisted side-by-side, and toggle which is active.
    /// Set once per process lifetime; changing requires a relaunch.
    nonisolated(unsafe) public static var slotSuffix: String?

    /// Account name for the active slot. With no suffix, "convos-identity".
    /// With suffix "admin", "convos-identity.admin", and so on.
    static var identityAccount: String {
        if let suffix = slotSuffix, !suffix.isEmpty {
            return "convos-identity.\(suffix)"
        }
        return "convos-identity"
    }

    // MARK: - Initialization

    /// - Parameter accessGroup: Keychain access group shared with the
    ///   Notification Service Extension.
    /// - Parameter keyWrapper: SE-backed wrapping layer. Default
    ///   `PassThroughIdentityKeyWrapper` keeps tests and macOS builds
    ///   running without an SE — production injects the real one from
    ///   `ConvosCoreiOS`.
    public init(
        accessGroup: String,
        keyWrapper: any IdentityKeyWrapper = PassThroughIdentityKeyWrapper(),
    ) {
        self.keychainAccessGroup = accessGroup
        self.keychainService = Self.defaultService
        self.keyWrapper = keyWrapper
    }

    // MARK: - Public Interface

    public func generateKeys() throws -> KeychainIdentityKeys {
        try KeychainIdentityKeys.generate()
    }

    public func save(inboxId: String, clientId: String, keys: KeychainIdentityKeys) throws -> KeychainIdentity {
        let identity = KeychainIdentity(inboxId: inboxId, clientId: clientId, keys: keys)
        let plain = try JSONEncoder().encode(identity)
        // F8.1 — wrap with the SE-backed key before the bytes ever
        // touch the keychain. PassThroughIdentityKeyWrapper makes this
        // a no-op on macOS / tests.
        let wrapped = try keyWrapper.wrap(plain)
        let query = KeychainQuery(
            account: Self.identityAccount,
            service: keychainService,
            accessGroup: keychainAccessGroup,
        )
        try saveData(wrapped, with: query)
        return identity
    }

    public func load() throws -> KeychainIdentity? {
        try loadSyncInternal(unwrap: keyWrapper.unwrap)
    }

    public nonisolated func loadSync() throws -> KeychainIdentity? {
        // `keyWrapper` is `let` on a `Sendable` type — Swift treats it
        // as implicitly nonisolated, so it's safe to read from here.
        try loadSyncInternal(unwrap: keyWrapper.unwrap)
    }

    private nonisolated func loadSyncInternal(unwrap: (Data) throws -> Data) throws -> KeychainIdentity? {
        let query = KeychainQuery(
            account: Self.identityAccount,
            service: keychainService,
            accessGroup: keychainAccessGroup,
        )
        do {
            let wrapped = try Self.loadKeychainData(with: query.toReadDictionary())
            let plain = try unwrap(wrapped)
            return try JSONDecoder().decode(KeychainIdentity.self, from: plain)
        } catch KeychainIdentityStoreError.identityNotFound {
            return nil
        }
    }

    public func delete() throws {
        let query = KeychainQuery(
            account: Self.identityAccount,
            service: keychainService,
            accessGroup: keychainAccessGroup
        )
        try deleteData(with: query)
    }

    // MARK: - Generic Keychain Operations

    private func saveData(_ data: Data, with query: KeychainQuery) throws {
        var queryDict = query.toDictionary()
        queryDict[kSecValueData as String] = data

        let status = SecItemAdd(queryDict as CFDictionary, nil)

        if status == errSecDuplicateItem {
            let updateQuery = query.toDictionary()
            let attributesToUpdate: [String: Any] = [kSecValueData as String: data]

            let updateStatus = SecItemUpdate(updateQuery as CFDictionary, attributesToUpdate as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw KeychainIdentityStoreError.keychainOperationFailed(updateStatus, "update")
            }
        } else if status != errSecSuccess {
            throw KeychainIdentityStoreError.keychainOperationFailed(status, "add")
        }
    }

    private func loadData(with query: KeychainQuery) throws -> Data {
        try Self.loadKeychainData(with: query.toReadDictionary())
    }

    /// Static so `nonisolated` entry points can call it without an actor hop.
    private static func loadKeychainData(with query: [String: Any]) throws -> Data {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        guard status != errSecItemNotFound else {
            throw KeychainIdentityStoreError.identityNotFound("Data not found in keychain")
        }

        guard status == errSecSuccess, let data = item as? Data else {
            throw KeychainIdentityStoreError.keychainOperationFailed(status, "load")
        }

        return data
    }

    private func deleteData(with query: KeychainQuery) throws {
        let status = SecItemDelete(query.toDictionary() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainIdentityStoreError.keychainOperationFailed(status, "delete")
        }
    }
}
