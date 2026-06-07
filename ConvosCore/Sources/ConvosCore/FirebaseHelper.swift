import Foundation

// Firebase stripped (Goldilocks security): no Firebase / App Check SDK ships.
// Goldilocks authenticates via GoldilocksAuth (SIWE against the Goldilocks
// backend), so the upstream App-Check-SIWE path that called these is never
// invoked at runtime. These no-op stubs keep that dead path compiling without
// pulling the Firebase SDK into the binary.
public enum FirebaseHelperCore {
    public static func configure(with optionsURL: URL, debugToken: String? = nil) {
        // no-op: Firebase is not used.
    }

    public static func getAppCheckToken(forceRefresh: Bool = false) async throws -> String {
        // No App Check token in Goldilocks; the SIWE-with-AppCheck path is dead.
        ""
    }
}
