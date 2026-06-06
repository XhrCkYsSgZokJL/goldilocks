import ConvosCore
import Foundation

/// Encrypts and decrypts the people list with an Advisory group's key.
///
/// The plaintext is a JSON `[SeatMember]`; the ciphertext, salt and nonce
/// travel to the backend as base64. This is the one definition of the
/// people-list wire format — shared by the client's own
/// `GoldilocksSeatPlan` and the admin people-list screen so the two can
/// never drift apart.
enum PeopleListCrypto {
    /// The plaintext shape encrypted into the backend blob.
    private struct Payload: Codable {
        var members: [SeatMember]
    }

    /// An encrypted people list, base64-encoded for the JSON API.
    struct EncryptedBlob {
        let ciphertext: String
        let salt: String
        let nonce: String
    }

    enum CryptoError: LocalizedError {
        case malformedBase64

        var errorDescription: String? {
            switch self {
            case .malformedBase64:
                return "The stored people list is corrupted."
            }
        }
    }

    /// Encrypt a people list with the group key (AES-256-GCM).
    static func encrypt(_ members: [SeatMember], groupKey: Data) throws -> EncryptedBlob {
        let json: Data = try JSONEncoder().encode(Payload(members: members))
        let payload: ImageEncryption.EncryptedPayload = try ImageEncryption.encrypt(imageData: json, groupKey: groupKey)
        return EncryptedBlob(
            ciphertext: payload.ciphertext.base64EncodedString(),
            salt: payload.salt.base64EncodedString(),
            nonce: payload.nonce.base64EncodedString()
        )
    }

    /// Decrypt a base64 people-list blob with the group key.
    static func decrypt(ciphertext: String, salt: String, nonce: String, groupKey: Data) throws -> [SeatMember] {
        guard let ciphertextData = Data(base64Encoded: ciphertext),
              let saltData = Data(base64Encoded: salt),
              let nonceData = Data(base64Encoded: nonce) else {
            throw CryptoError.malformedBase64
        }
        let json: Data = try ImageEncryption.decrypt(
            ciphertext: ciphertextData, groupKey: groupKey, salt: saltData, nonce: nonceData
        )
        return try JSONDecoder().decode(Payload.self, from: json).members
    }
}
