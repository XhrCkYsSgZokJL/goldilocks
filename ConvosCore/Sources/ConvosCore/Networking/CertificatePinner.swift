import CryptoKit
import Foundation
import Security

/// Hand-rolled SPKI certificate pinning. A custom `URLSessionDelegate`
/// validates server trust against a known set of SubjectPublicKeyInfo
/// SHA-256 hashes. Designed to be simple enough to audit in one sitting
/// and to live without third-party dependencies (TrustKit had its last
/// substantive release in 2021).
///
/// **Threat model.** Defends against:
/// - Compromised public CAs (DigiNotar-style)
/// - Corporate / on-path TLS interception with a user-installed root CA
/// - Targeted MITM with a forged cert from any other CA
///
/// Does NOT defend against:
/// - A compromise of the pinned key itself
/// - A backdoored device (no system-level integrity assumptions)
///
/// **Pin material.** SPKI SHA-256 hashes are public information — they
/// can ship in the binary or alongside it. To generate one from a cert:
///
///     openssl x509 -in cert.pem -pubkey -noout \
///       | openssl pkey -pubin -outform der \
///       | openssl dgst -sha256 -binary \
///       | openssl base64
///
/// Always pin at least two values per host (current leaf + a backup key
/// generated offline). A single-pin rotation that loses the key bricks
/// every installed app — every modern pinning guide hammers this.
///
/// **Shadow vs enforce.** Ship `.shadow` first. The delegate evaluates
/// the pin set but does not reject mismatches — it logs them. After a
/// full TestFlight cycle with no false positives, flip to `.enforce`.
public enum CertificatePinningMode: Sendable {
    /// Evaluate pins; report mismatches to Sentry; allow the connection.
    /// Use this for the first release that introduces pinning.
    case shadow
    /// Evaluate pins; reject the connection on mismatch.
    case enforce
}

/// One pin set per host. Hosts not in this map are not pinned (the OS
/// default TLS validation still runs — pinning is additive).
public struct CertificatePinSet: Sendable {
    /// Lowercased host (e.g. "api.goldilocksdigital.xyz"). Subdomains
    /// match only if listed explicitly — there is no wildcard support
    /// here.
    public let host: String
    /// Base64-encoded SHA-256 hashes of the SubjectPublicKeyInfo. At
    /// least one must match for the connection to be accepted in
    /// enforce mode.
    public let spkiHashesBase64: Set<String>

    public init(host: String, spkiHashesBase64: Set<String>) {
        self.host = host.lowercased()
        self.spkiHashesBase64 = spkiHashesBase64
    }
}

public final class CertificatePinner: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let pinSets: [String: CertificatePinSet]
    private let mode: CertificatePinningMode

    public init(pinSets: [CertificatePinSet], mode: CertificatePinningMode) {
        var map: [String: CertificatePinSet] = [:]
        for set in pinSets {
            map[set.host] = set
        }
        self.pinSets = map
        self.mode = mode
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        let host = challenge.protectionSpace.host.lowercased()
        guard let pinSet = pinSets[host] else {
            // Host isn't pinned — fall through to the OS default trust
            // evaluation. (We don't want to pin every host the app
            // talks to, only ones we control.)
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // First, let the OS evaluate the chain against system roots. If
        // the system rejects the chain, we don't second-guess it — the
        // connection fails regardless of whether the pin would match.
        var error: CFError?
        let systemTrusted = SecTrustEvaluateWithError(serverTrust, &error)
        guard systemTrusted else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        // Walk the certificate chain looking for a public key whose
        // SPKI hash matches our pin set. Most pinning libraries pin the
        // leaf or its issuer; matching against any cert in the chain is
        // the same approach Android's NSC and TrustKit take.
        let chain = (SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate]) ?? []
        var matched = false
        for certificate in chain {
            if let hash = Self.spkiSha256Base64(for: certificate),
               pinSet.spkiHashesBase64.contains(hash) {
                matched = true
                break
            }
        }

        if matched {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
            return
        }

        Self.reportPinMismatch(host: host)
        switch mode {
        case .shadow:
            // Log only; allow the connection. The first release with
            // pinning ships in this mode so we can confirm zero false
            // positives across the install base before enforcing.
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        case .enforce:
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    // MARK: - SPKI hashing

    private static func spkiSha256Base64(for certificate: SecCertificate) -> String? {
        guard let publicKey = SecCertificateCopyKey(certificate) else { return nil }
        guard let attributes = SecKeyCopyAttributes(publicKey) as? [CFString: Any] else { return nil }
        guard let keyType = attributes[kSecAttrKeyType] as? String,
              let sizeBits = attributes[kSecAttrKeySizeInBits] as? Int else {
            return nil
        }
        guard let rawKey = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else { return nil }
        guard let header = Self.spkiHeader(keyType: keyType, sizeBits: sizeBits) else { return nil }

        var spki = Data()
        spki.append(header)
        spki.append(rawKey)
        let digest = SHA256.hash(data: spki)
        return Data(digest).base64EncodedString()
    }

    // ASN.1 SubjectPublicKeyInfo prefix bytes per key type / size. These
    // are constants documented in the standard SPKI-pinning recipe (e.g.
    // OWASP MASTG, Moxie's 2011 pinning post). Adding more key types
    // means looking up the prefix once and dropping it into this table.
    private static func spkiHeader(keyType: String, sizeBits: Int) -> Data? {
        switch (keyType, sizeBits) {
        case (kSecAttrKeyTypeRSA as String, 2048):
            return Data([
                0x30, 0x82, 0x01, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
                0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0f, 0x00,
            ])
        case (kSecAttrKeyTypeRSA as String, 4096):
            return Data([
                0x30, 0x82, 0x02, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
                0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x02, 0x0f, 0x00,
            ])
        case (kSecAttrKeyTypeECSECPrimeRandom as String, 256):
            return Data([
                0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
                0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
                0x42, 0x00,
            ])
        case (kSecAttrKeyTypeECSECPrimeRandom as String, 384):
            return Data([
                0x30, 0x76, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
                0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22, 0x03, 0x62, 0x00,
            ])
        default:
            return nil
        }
    }

    private static func reportPinMismatch(host: String) {
        SecurityLog.event(.pinningMismatch, severity: .critical, context: ["host": host])
    }
}

/// Default Goldilocks pin set. Empty by default — the operator fills
/// these in once the production cert is provisioned (and at least one
/// backup pin from an offline-generated key). Until at least one hash
/// is present, no enforcement happens for the host.
public enum GoldilocksPinning {
    public static let apiHost: String = "api.goldilocksdigital.xyz"

    /// Replace with real SPKI hashes before flipping mode to `.enforce`.
    /// Generate via the openssl one-liner in CertificatePinner.swift's
    /// docs. Keep at least one backup hash in this set so a single key
    /// loss doesn't brick the app.
    public static let apiSpkiHashes: Set<String> = []

    public static func defaultPinSet() -> CertificatePinSet {
        CertificatePinSet(host: apiHost, spkiHashesBase64: apiSpkiHashes)
    }

    /// Build the pinner the API client should use. Returns nil when the
    /// pin set is empty — the API client falls back to a stock
    /// URLSession and the OS-default trust evaluation.
    public static func defaultPinner(mode: CertificatePinningMode = .shadow) -> CertificatePinner? {
        let pinSet = defaultPinSet()
        guard !pinSet.spkiHashesBase64.isEmpty else { return nil }
        return CertificatePinner(pinSets: [pinSet], mode: mode)
    }
}
