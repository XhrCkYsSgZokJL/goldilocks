# Identity Recovery & Hardening

**Category:** Security · **Primary strategy:** REPLACE-EXTEND (preserve exactly) + OWN

## What

Goldilocks adds a hardened identity-key lifecycle on top of upstream's XMTP identity:

- **Secure-Enclave key wrapping** (F8.1) — the device-local identity key is SE-wrapped, not stored raw.
- **iCloud key backup** (adopted from upstream #971) — a synced backup slot so a user can recover their identity on a new device. The two-slot keychain holds an SE-wrapped device-local primary **and** a synced iCloud raw-key backup.
- **Capture protection** — `SecureWindow` / `CaptureMonitor` blur sensitive UI under screen recording / screenshots.
- **File protection** — `NSFileProtectionComplete` entitlement; `ProtectedFile` for at-rest data.
- **Cert pinning + SIWE** in the API client (see [Auth against Goldilocks backend](auth-against-goldilocks-backend.md)).

## Why

This is the security spine of the product. Every item here is a deliberate hardening that upstream does not do (or does differently). It is the **highest-risk cluster to reconcile** — a silent regression here is a security incident, not a bug.

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks |
|--------|----------|------------|
| Identity key at rest | Keychain | Secure-Enclave-wrapped (device-local) + synced iCloud backup slot |
| Recovery on new device | — | iCloud backup slot (#971), restore picker |
| Sensitive UI under capture | visible | blurred (`SecureWindow`/`CaptureMonitor`) |
| At-rest files | default | `NSFileProtectionComplete` + `ProtectedFile` |

## Files affected

### Owned (additive)
- `ConvosCore/Sources/ConvosCore/Auth/SecureEnclave/IdentityKeyWrapper.swift` — the SE key-wrap protocol.
- `ConvosCore/Sources/ConvosCoreiOS/SecureEnclaveIdentityKeyWrapper.swift` — iOS SE implementation (injected via the bridge).
- `ConvosCore/Sources/ConvosCore/Storage/ProtectedFile.swift` — file-protection wrapper.
- `Convos/Window/SecureWindow.swift`, `CaptureMonitor.swift`, `CaptureOverlay.swift` — capture protection.

### Extended (REPLACE-EXTEND — re-apply exactly)
- `ConvosCore/Sources/ConvosCore/Auth/Keychain/KeychainIdentityStore.swift` — the two-slot keychain (SE primary + synced backup). **The crux file.**
- `ConvosCore/Sources/ConvosCore/PlatformProviders.swift` — injects the key wrapper.
- `ConvosCore/Sources/ConvosCore/ConvosClient+App.swift` — wires the identity store with the wrapper + device-name provider.
- `ConvosCore/Sources/ConvosCore/Sessions/ClipIdentityBootstrap.swift`, `Notifications/NotificationExtensionEnvironment.swift` — SE wrapping in the App Clip + NSE.
- `Convos/Convos.entitlements` — `NSFileProtectionComplete`, keychain access groups.
- `Convos/ConvosAppDelegate.swift` — installs `SecureWindow` / `CaptureMonitor`.

## Markers

`identityKeyWrapper`, `IdentityKeyWrapper`, `SecureEnclave`, `KeychainIdentityStore`, `SecureWindow`, `CaptureMonitor`, `NSFileProtectionComplete`, `ProtectedFile`, the synced-backup slot logic in `ConvosKeychainItem` / `KeychainIdentityStore`.

## Upstream-sync guidance

- **Preserve exactly. Reconcile this cluster hardest, and test against a live node.** If upstream refactors `KeychainIdentityStore` or the identity bootstrap, re-apply our SE-wrapping + two-slot backup on top of their new structure — do not let a merge silently drop a slot or unwrap a key.
- **The bridge pattern protects most of this.** The SE implementation lives in `ConvosCoreiOS` behind `IdentityKeyWrapper`; upstream edits to the protocol surface are rare. Keep using injection rather than editing the core identity files in place.
- If upstream adopts its own key-backup scheme, evaluate it against ours (#971) before switching — don't adopt by accident.
- Reference design: `docs/plans/identity-recovery-icloud.md`, `docs/operations/encryption-and-backup.md`, `docs/identity-system-overview.md`.

## Related

[Auth against Goldilocks backend](auth-against-goldilocks-backend.md) (cert pinning + SIWE) · [Platform build constraints](platform-build-constraints.md) (the `ConvosCoreiOS` bridge) · [No telemetry / no-egress](no-telemetry-no-egress.md)
