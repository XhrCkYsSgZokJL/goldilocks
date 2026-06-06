import Foundation

/// Wraps the at-rest form of an identity's private key bytes with a
/// device-bound key.
///
/// On iOS this is implemented in `ConvosCoreiOS` with a
/// `SecureEnclave.P256.KeyAgreement` private key: the wrapping key is
/// generated inside the Secure Enclave and never leaves it. Restoring
/// the same private key on a different device is impossible — the SE
/// public key the wrap was derived against is unique to one physical
/// device. F8.1 in `docs/encryption-and-backup-plan.md`.
///
/// On macOS / simulators / tests the default `PassThroughIdentityKeyWrapper`
/// is a no-op so the rest of ConvosCore stays cross-platform.
public protocol IdentityKeyWrapper: Sendable {
    /// Encrypt arbitrary bytes with the wrapper's device-bound key.
    /// The returned data carries everything needed for `unwrap` — no
    /// extra state per call.
    func wrap(_ plaintext: Data) throws -> Data

    /// Decrypt bytes previously produced by `wrap`. Throws on tamper,
    /// missing wrapping key, or any format mismatch.
    func unwrap(_ ciphertext: Data) throws -> Data
}

/// No-op implementation used in tests, in macOS-only builds of
/// `ConvosCore`, and in simulators where Secure Enclave round-trips
/// can't be exercised reliably. Wrapping returns the input unchanged.
public struct PassThroughIdentityKeyWrapper: IdentityKeyWrapper {
    public init() {}

    public func wrap(_ plaintext: Data) throws -> Data {
        plaintext
    }

    public func unwrap(_ ciphertext: Data) throws -> Data {
        ciphertext
    }
}
