@testable import ConvosCore
import Foundation
import Testing

/// Coverage for the cross-platform parts of the `IdentityKeyWrapper`
/// protocol. The SE-backed implementation lives in `ConvosCoreiOS` and
/// is exercised on-device — these tests cover the protocol contract
/// against the `PassThroughIdentityKeyWrapper` and a small bespoke
/// mock that simulates failure modes.
///
/// F8.1 design: docs/encryption-and-backup-plan.md in goldilocks-backend.
@Suite("IdentityKeyWrapper")
struct IdentityKeyWrapperTests {
    @Test("pass-through round-trips identical bytes")
    func passThroughRoundTrip() throws {
        let wrapper = PassThroughIdentityKeyWrapper()
        let payload = Data("XMTP identity bytes 🔐".utf8)
        let wrapped = try wrapper.wrap(payload)
        #expect(wrapped == payload)
        let unwrapped = try wrapper.unwrap(wrapped)
        #expect(unwrapped == payload)
    }

    @Test("pass-through tolerates empty data")
    func passThroughEmpty() throws {
        let wrapper = PassThroughIdentityKeyWrapper()
        let unwrapped = try wrapper.unwrap(try wrapper.wrap(Data()))
        #expect(unwrapped == Data())
    }

    @Test("mock wrapper that XORs bytes round-trips successfully")
    func mockXorWrapper() throws {
        let wrapper = XORWrapperForTesting(byte: 0x5A)
        let payload = Data([0x00, 0x01, 0xFF, 0x42, 0x10])
        let wrapped = try wrapper.wrap(payload)
        #expect(wrapped != payload)
        #expect(try wrapper.unwrap(wrapped) == payload)
    }

    @Test("mock wrapper rejects tampered ciphertext")
    func mockWrapperRejectsTamper() throws {
        let wrapper = ChecksumWrapperForTesting()
        let payload = Data("secret".utf8)
        let wrapped = try wrapper.wrap(payload)

        // Flip a byte in the body (after the checksum prefix).
        var tampered = wrapped
        let mutateIndex = tampered.count - 1
        tampered[mutateIndex] ^= 0x01
        #expect(throws: (any Error).self) {
            try wrapper.unwrap(tampered)
        }
    }
}

// MARK: - Test helpers

/// Cheap deterministic wrapper that XORs every byte with `byte` — just
/// enough to assert the wrap output isn't the input.
private struct XORWrapperForTesting: IdentityKeyWrapper {
    let byte: UInt8

    func wrap(_ plaintext: Data) throws -> Data {
        Data(plaintext.map { $0 ^ byte })
    }

    func unwrap(_ ciphertext: Data) throws -> Data {
        Data(ciphertext.map { $0 ^ byte })
    }
}

/// Authenticated wrapper that prepends a one-byte sum so tamper checks
/// have something to fail against.
private struct ChecksumWrapperForTesting: IdentityKeyWrapper {
    enum Error: Swift.Error { case tampered }

    func wrap(_ plaintext: Data) throws -> Data {
        var sum: UInt8 = 0
        for byte in plaintext { sum &+= byte }
        var out = Data([sum])
        out.append(plaintext)
        return out
    }

    func unwrap(_ ciphertext: Data) throws -> Data {
        guard let first = ciphertext.first else { throw Error.tampered }
        let body = ciphertext.dropFirst()
        var sum: UInt8 = 0
        for byte in body { sum &+= byte }
        guard sum == first else { throw Error.tampered }
        return body
    }
}
