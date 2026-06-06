import ConvosCore
import CryptoKit
import Foundation
import Security

/// Secure-Enclave-backed implementation of `IdentityKeyWrapper`.
///
/// Generates a `SecureEnclave.P256.KeyAgreement` private key the first
/// time it's instantiated; the key's `dataRepresentation` (an SE-encrypted
/// opaque blob) is persisted in the keychain. Subsequent runs reconstruct
/// the same SE handle from that blob — the underlying private key never
/// leaves the SE.
///
/// Wrap format (versioned for forward-compat):
///
///   v1 || u32(ephPubLen, BE) || ephPub || AES.GCM.SealedBox.combined
///
/// where the symmetric key comes from ECDH between an ephemeral P-256
/// keypair (private discarded after encrypt) and the SE-backed key,
/// HKDF'd with a domain-separation salt.
///
/// Unwrap on a different physical device fails: the SE key handle can't
/// be reconstructed without the original SE. That's intentional — F8.1
/// trades cross-device sync for the strongest at-rest posture we can
/// get for the XMTP identity. See docs/encryption-and-backup-plan.md.
public final class SecureEnclaveIdentityKeyWrapper: IdentityKeyWrapper {
    public enum WrapperError: Error, LocalizedError {
        case secureEnclaveUnavailable
        case invalidFormat
        case keychainOperation(OSStatus, String)

        public var errorDescription: String? {
            switch self {
            case .secureEnclaveUnavailable:
                return "Secure Enclave is not available on this device"
            case .invalidFormat:
                return "wrapped payload was not in the v1 SE-wrapper format"
            case let .keychainOperation(status, op):
                return "keychain \(op) failed with OSStatus \(status)"
            }
        }
    }

    private static let envelopeVersion: UInt8 = 0x01
    private static let hkdfSalt: Data = Data("goldilocks/se-wrap/v1".utf8)

    private let keychainService: String
    private let keychainAccount: String
    private let keychainAccessGroup: String

    /// - Parameters:
    ///   - service: Keychain `service` slot for the wrapped SE-key handle.
    ///   - account: Keychain `account` for the handle. Recommended: bind
    ///              to the identity slot suffix so dev's dual-identity
    ///              model gets two distinct SE keys.
    ///   - accessGroup: Same app-group as the identity store.
    public init(
        service: String,
        account: String,
        accessGroup: String,
    ) throws {
        guard SecureEnclave.isAvailable else {
            throw WrapperError.secureEnclaveUnavailable
        }
        self.keychainService = service
        self.keychainAccount = account
        self.keychainAccessGroup = accessGroup
        // Force lazy creation now so the first wrap doesn't surprise
        // the caller with a synchronous Touch/Face ID prompt later.
        _ = try loadOrCreateKey()
    }

    public func wrap(_ plaintext: Data) throws -> Data {
        let seKey = try loadOrCreateKey()
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let ephemeralPublic = ephemeral.publicKey.rawRepresentation

        let sharedSecret = try ephemeral.sharedSecretFromKeyAgreement(with: seKey.publicKey)
        let symmetricKey = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Self.hkdfSalt,
            sharedInfo: ephemeralPublic,
            outputByteCount: 32,
        )
        let sealed = try AES.GCM.seal(plaintext, using: symmetricKey)
        guard let combined = sealed.combined else {
            throw WrapperError.invalidFormat
        }

        var out = Data()
        out.append(Self.envelopeVersion)
        var lenBE = UInt32(ephemeralPublic.count).bigEndian
        withUnsafeBytes(of: &lenBE) { out.append(contentsOf: $0) }
        out.append(ephemeralPublic)
        out.append(combined)
        return out
    }

    public func unwrap(_ ciphertext: Data) throws -> Data {
        guard ciphertext.count >= 5, ciphertext[ciphertext.startIndex] == Self.envelopeVersion else {
            throw WrapperError.invalidFormat
        }

        // Parse u32 length using a copy to dodge unaligned-load
        // undefined behavior on some architectures.
        let lenStart = ciphertext.index(ciphertext.startIndex, offsetBy: 1)
        let lenEnd = ciphertext.index(lenStart, offsetBy: 4)
        var lenBE: UInt32 = 0
        _ = withUnsafeMutableBytes(of: &lenBE) { buf in
            ciphertext.copyBytes(to: buf, from: lenStart..<lenEnd)
        }
        let ephPubLen = Int(UInt32(bigEndian: lenBE))

        let ephPubStart = lenEnd
        let ephPubEnd = ciphertext.index(ephPubStart, offsetBy: ephPubLen)
        guard ephPubEnd <= ciphertext.endIndex else {
            throw WrapperError.invalidFormat
        }
        let ephPubData = ciphertext[ephPubStart..<ephPubEnd]
        let sealedData = ciphertext[ephPubEnd..<ciphertext.endIndex]

        let ephPub = try P256.KeyAgreement.PublicKey(rawRepresentation: ephPubData)
        let seKey = try loadOrCreateKey()
        let sharedSecret = try seKey.sharedSecretFromKeyAgreement(with: ephPub)
        let symmetricKey = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Self.hkdfSalt,
            sharedInfo: ephPubData,
            outputByteCount: 32,
        )
        let sealed = try AES.GCM.SealedBox(combined: sealedData)
        return try AES.GCM.open(sealed, using: symmetricKey)
    }

    // MARK: - SE key persistence

    /// Loads the persisted SE-key handle from the keychain, or generates
    /// a new one (and persists its handle) on first use.
    private func loadOrCreateKey() throws -> SecureEnclave.P256.KeyAgreement.PrivateKey {
        if let handle = try readKeyHandle() {
            return try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: handle)
        }
        let fresh = try SecureEnclave.P256.KeyAgreement.PrivateKey()
        try writeKeyHandle(fresh.dataRepresentation)
        return fresh
    }

    private func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: keychainAccessGroup,
            // Device-only: the SE key handle is useless on any other
            // device, so syncing it would just waste iCloud space.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
        ]
    }

    private func readKeyHandle() throws -> Data? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = item as? Data else {
            throw WrapperError.keychainOperation(status, "load SE handle")
        }
        return data
    }

    private func writeKeyHandle(_ data: Data) throws {
        var insert = keychainQuery()
        insert[kSecValueData as String] = data
        let addStatus = SecItemAdd(insert as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return
        }
        if addStatus == errSecDuplicateItem {
            let attrs: [String: Any] = [kSecValueData as String: data]
            let updateStatus = SecItemUpdate(keychainQuery() as CFDictionary, attrs as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw WrapperError.keychainOperation(updateStatus, "update SE handle")
            }
            return
        }
        throw WrapperError.keychainOperation(addStatus, "save SE handle")
    }
}
