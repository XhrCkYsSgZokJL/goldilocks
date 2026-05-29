# Security

This document describes the security posture of the Convos iOS app —
what protects what, where, and how. It is written for developers
joining the project, security reviewers, and anyone trying to extend
the app without accidentally regressing one of the guarantees.

The Goldilocks-backend side of the conversation is covered in the
backend repo's [`SECURITY.md`](https://github.com/xmtplabs/goldilocks-backend/blob/main/SECURITY.md).
This document covers the device side.

---

## 1. What lives on the device

A Convos install holds three classes of secret data on disk:

- **The XMTP identity.** A secp256k1 private key plus an associated
  database key, persisted via `ConvosCore/.../KeychainIdentityStore.swift`.
  The signing key *is* the user on the XMTP network — anyone with
  these bytes can impersonate the install.
- **The XMTP local database.** The local copy of every message the
  user has sent or received, plus group state. Encrypted at rest by
  libxmtp using SQLCipher with the database key above.
- **Cached user-facing content.** Profile images, attachments,
  voice memos, video, link previews. Some encrypted at the
  application layer (profile images, AES-256-GCM with a per-Advisory
  key the server never sees), some relying on iOS file-system
  protection alone.

Plus several smaller items: the `AGENT_DB_ENCRYPTION_KEY` used by
the agent runtime, OAuth session tokens, push tokens, attestation
artifacts, and the like.

Roughly, the threats the device is defending against are:

- A **lost or stolen device**. Whoever has it can try to extract
  identity material to impersonate the user on XMTP, even after a
  factory reset.
- An **attacker who has physical access while the device is
  unlocked** (the "evil maid" with passcode). Their reach is broader,
  but file-protection still bounds what they can read between
  unlocks.
- **iCloud account compromise** — historically, this would have
  given an attacker the user's XMTP identity (iCloud Keychain sync
  carried it). After F8.1 the identity is device-bound and an iCloud
  compromise no longer exposes it.
- **A malicious app on the same device** with the same
  keychain-access-group — bounded by what the app itself can read,
  which is in turn bounded by the device lock state.

Out of scope:

- A jailbroken device with root + kernel access. At that point any
  in-memory secret is fair game.
- Sophisticated side-channel attacks against the Secure Enclave.
- Cryptographic compromise of AES-GCM, ChaCha20-Poly1305, ECDH on
  P-256, or secp256k1.

---

## 2. The layered defenses, at a glance

The device-side defenses are designed to overlap so that a single
mistake or compromise doesn't expose everything:

| Layer | What it protects | Implementation |
|---|---|---|
| **F8.1 — Secure Enclave wrapping** | The XMTP identity key bytes at rest | `SecureEnclave.P256.KeyAgreement` derives a wrapping key via ECDH + HKDF; AES-GCM encrypts the secp256k1 bytes before they reach the keychain |
| **F8.2 — File protection** | Files unreadable while the device is locked | Entitlement `com.apple.developer.default-data-protection = NSFileProtectionComplete` on the main app; `NSFileProtectionCompleteUnlessOpen` on the notification extension |
| **Keychain access controls** | Identity readable only after first unlock, only on this device | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` + `synchronizable: false` for the wrapped identity (post-F8.1) |
| **Profile-image encryption** | Profile images leaked from IPFS / backend storage | AES-256-GCM with a per-Advisory key the backend never sees — see `ConvosCore/Sources/ConvosCore/Profiles/` |
| **End-to-end message encryption** | Messages in transit and at rest in groups | XMTP MLS, handled by libxmtp |
| **SQLCipher local DB** | Messages on the device | libxmtp's local store, encrypted with the database key from the identity |
| **TLS to the backend** | Eavesdropping on the API path | Cloudflare-terminated HTTPS to the backend tunnel |

Each layer's design rationale is in the goldilocks-backend repo's
[`docs/encryption-and-backup-plan.md`](https://github.com/xmtplabs/goldilocks-backend/blob/main/docs/encryption-and-backup-plan.md)
under F8. The sections that follow document how the running app
depends on each one, and what a developer needs to do to keep them
working.

---

## 3. Identity protection (F8.1) — the most important layer

### What the identity is

The identity is created the first time the user onboards. Two
secrets sit in `KeychainIdentityKeys`:

- `privateKey: PrivateKey` — the secp256k1 signing key that defines
  the user's XMTP inbox.
- `databaseKey: Data` — the symmetric key libxmtp uses to encrypt
  the local SQLCipher DB.

These are bundled into a `KeychainIdentity` (with the `inboxId` and
`clientId`) and persisted in the device keychain as a single JSON blob.

### What F8.1 changes

Before F8.1, those JSON bytes were stored in the keychain with iCloud
sync on (`kSecAttrSynchronizable = true`) and the default keychain
access control. A device-passcode-equipped attacker, or anyone with
access to the user's iCloud Keychain on another Apple device, could
read the JSON and extract the raw secp256k1 bytes.

After F8.1:

1. The JSON is encrypted by a **Secure Enclave**-backed wrapping
   key before it ever touches the keychain.
2. The Secure Enclave key is a `SecureEnclave.P256.KeyAgreement`
   private key. The Secure Enclave generates it; the bytes never
   leave the hardware. iOS hands back an opaque `dataRepresentation`
   that we store in the keychain — useless on any other device.
3. The keychain item is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
   and `synchronizable: false`. **No iCloud Keychain sync of the
   identity.**

The wrap format is documented in
`ConvosCoreiOS/SecureEnclaveIdentityKeyWrapper.swift`:

```
0x01 || u32(ephPubLen, BE) || ephPub || AES.GCM.SealedBox.combined
```

Each `wrap` call generates a fresh ephemeral P-256 keypair, performs
ECDH with the SE-backed key's public component, runs the result
through HKDF-SHA256 with a domain-separation salt, and AES-GCM-seals
the plaintext under the derived 256-bit key. Each call produces a
distinct ciphertext even for identical inputs.

`unwrap` reverses the process. It requires the original Secure
Enclave on the original device — there is no fallback path.

### Trade-off: identity is now device-bound

This is the deliberate design decision called out in the encryption
plan: the price of Secure Enclave wrapping is that the identity no
longer follows the user across devices through iCloud Keychain. A
user installing Convos on a new phone re-onboards through the SIWE
flow. The same Apple ID does not get them the same XMTP inbox.

If we ever want to bring sync back, the options are (a) accept that
iCloud-sync of the wrapping key undermines the SE guarantee or (b)
a server-side key escrow protocol — both are larger projects than
F8.1 itself.

### How to NOT break F8.1

These patterns will silently weaken the identity's protection if
they end up in the codebase:

- Persisting the unwrapped `KeychainIdentityKeys` to any
  filesystem location outside the keychain.
- Building a debug helper that calls `KeychainIdentityStore.load()`
  and then writes the result to a log line. Even DEBUG logs end up
  in crash reports.
- Writing the `databaseKey` to disk anywhere other than passing it
  to libxmtp.
- Using `kSecAttrSynchronizable = true` on any new keychain item
  that derives from the identity material.

The `KeychainIdentityStore.load(...)` call returns a
`KeychainIdentity` instance whose lifetime should be as short as the
operation that needed it. Don't hold it on a long-lived property.

---

## 4. File protection (F8.2)

### The entitlement-level default

The main app target's
[`Convos/Convos.entitlements`](Convos/Convos.entitlements) sets:

```xml
<key>com.apple.developer.default-data-protection</key>
<string>NSFileProtectionComplete</string>
```

This makes every file the main app creates **unreadable while the
device is locked**. Reads, writes, and even existence checks fail
between the user pressing the power button and the next Touch ID /
Face ID / passcode unlock.

The
[`NotificationService/NotificationService.entitlements`](NotificationService/NotificationService.entitlements)
target relaxes that to `NSFileProtectionCompleteUnlessOpen` for the
extension only. The push notification path wakes while the device
is locked — `Complete` would prevent the extension from decrypting
the payload at all.

### Per-write-site overrides

If a write site needs a different protection class than the
entitlement default (background URLSession downloads that have to
land while locked, for example), use the
[`ConvosCore/Sources/ConvosCore/Storage/ProtectedFile.swift`](ConvosCore/Sources/ConvosCore/Storage/ProtectedFile.swift)
helper:

```swift
try ProtectedFile.write(
    data,
    to: url,
    options: [.atomic, .completeUnlessOpen],
)
```

The helper defaults to `.atomic | .completeFileProtection`, matching
the entitlement, so passing it through plainly is the safe choice
when you don't know which class you need.

For files that arrive without a `Data.WritingOptions` parameter (a
`URLSessionDownloadTask` writing to a target URL, for instance),
call `ProtectedFile.setProtection(.complete, on: url)` after the
write completes.

### Adding a new write site

The default-everything-Complete-via-entitlement approach catches new
write sites for free. But if you're working in the
`NotificationService` extension or in any context that runs while
the device is locked, think explicitly about whether a stricter
protection level would break your write path before tightening it.

---

## 5. Existing layers (in place before F8)

### Profile-image encryption

`ConvosCore/Sources/ConvosCore/Profiles/` ships an
`EncryptedImageRef` + `ProfileUpdate` / `ProfileSnapshot` system
that wraps every profile image in AES-256-GCM under a key the
backend never sees (the per-Advisory group key). Backend storage
holds opaque ciphertext.

When you add new image-bearing fields, route them through this
system rather than uploading raw bytes to attachments.

### XMTP MLS for messages

All real conversation traffic happens over MLS via libxmtp. The
group key is held by group members only; the backend doesn't
participate in group cryptography. The agent on the backend
(`admins-agent`, `reports-agent`) is a regular MLS member from XMTP's
perspective, not a privileged middlebox.

### SQLCipher local message DB

libxmtp's local store is SQLCipher under the hood. The encryption
key is the `databaseKey` from `KeychainIdentityKeys`, which after
F8.1 is itself protected by the Secure Enclave wrapping layer.

The agent runtime has the same property on the backend side, keyed
on `AGENT_DB_ENCRYPTION_KEY` from the backend's `.env.<env>` — see
the backend's `SECURITY.md` for details.

### TLS to the backend

API traffic uses the Cloudflare tunnel endpoint. Cloudflare
terminates TLS at the edge; the request travels over their
backbone to the cloudflared container running on the backend host
and then over plain HTTP inside the compose network. The TLS leg
the device sees is HTTPS with a Cloudflare-managed certificate.

The backend's internal TLS (F5 on that side) protects the
container-to-container leg. The device side just needs to use the
HTTPS endpoint URL and reject HTTP redirects.

### Keychain access groups

`Convos.entitlements` lists two keychain-access-groups: the app
group identifier (so the notification service extension can read
the identity), and a dedicated `keychain-access-groups` entry for
items that should be visible across other related processes. New
keychain items default to the app-group entry unless they have a
reason to be more or less restricted.

### Firebase App Check (in flight removal)

App Check is currently active and is being removed (see the backend
plan's open-decisions section). Don't add new code that depends on
App Check; if you need device attestation, plan around Apple's
DCAppAttestService directly — it's the v2 follow-up identified in
the plan.

---

## 6. Patterns to follow when adding new code

A short list of "do this, not that" entries that come up repeatedly:

**Adding a new keychain item.**

```swift
// Good: ThisDeviceOnly, not synchronizable, narrow access group.
let attrs: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "your.service.id",
    kSecAttrAccount as String: "your-account-name",
    kSecAttrAccessGroup as String: environment.keychainAccessGroup,
    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    kSecAttrSynchronizable as String: false,
]
```

Default to the strictest accessible class that lets your code path
work. Default to `synchronizable: false` unless there's a deliberate
reason to opt in.

**Reading the identity.**

Go through `KeychainIdentityStore.load()` (or `loadSync()` from
nonisolated contexts). Don't bypass the store to read the keychain
item directly — the SE-unwrap step lives in the store.

**Writing a file to disk.**

Default to `ProtectedFile.write(_:to:)`. Only pass an explicit
weaker `WritingOptions` if you know the file has to be readable
while locked. Document the why in a comment next to the call.

**Logging.**

Never log keys, key references, ciphertexts, or anything derived
from them. The `Log` system writes to disk and ends up in crash
reports. The legacy keychain item formats sometimes had identity
material round-trip through `print` during debugging — don't
re-introduce that.

**Adding a new service-to-backend call.**

Use HTTPS endpoint URLs. Reject HTTP redirects (URLSession does this
by default with App Transport Security enabled, which it is).

**Cross-platform code in ConvosCore.**

ConvosCore must compile on macOS without UIKit. Don't
`import UIKit` there; use the `ImageType` typealias and the
`PlatformProviders` injection pattern.

---

## 7. Known limitations and v2 follow-ups

These are deliberate v1 trade-offs documented in the backend plan:

- **No iCloud Keychain sync of the identity.** Stated trade-off of
  F8.1. A future server-side key escrow protocol could bring sync
  back without weakening the SE guarantee.
- **Per-write-site audit not exhaustive.** The entitlement default
  catches new write sites for free, but a deliberate audit pass to
  annotate every existing FileManager / `Data.write` call site with
  an explicit protection class is the v2 follow-up.
- **No crypto-shredding on logout.** A logout that deletes the
  SE-wrapped key handle would make every existing encrypted blob
  instantly unrecoverable. Cleaner than wiping the SQLCipher DB
  byte by byte; a v2 follow-up.
- **App Attest as defense in depth.** Apple-native attestation is
  stronger than App Check on iOS; pending the Firebase rip-out.
- **No SE-on-SE-replace path.** If the Secure Enclave key is lost
  for any reason (corrupted keychain item, device wipe), the
  identity is unrecoverable. The SIWE re-onboarding path is the
  fallback.
- **`subscriptions.hmac_keys` on the backend stays plaintext in v1.**
  See backend `SECURITY.md`.

---

## 8. Reporting a vulnerability

If you believe you've found a security issue in Convos iOS, please
do not file a public GitHub issue. Email the project's security
contact (see the main README for current contact information).

Please include: a description of the vulnerability, steps to
reproduce, the affected component / commit, and any proof of
concept you have. The team's response goal is to acknowledge
receipt within 72 hours and to follow up with a remediation plan or
clarifying questions shortly after.

---

## 9. Where to find more detail

- The backend's
  [`SECURITY.md`](https://github.com/xmtplabs/goldilocks-backend/blob/main/SECURITY.md)
  — the other half of the system. Most attacks span both repos;
  the two docs are meant to be read together.
- The backend's
  [`docs/encryption-and-backup-plan.md`](https://github.com/xmtplabs/goldilocks-backend/blob/main/docs/encryption-and-backup-plan.md)
  — the implementation plan. F8 is the iOS section.
- [`ConvosCore/Sources/ConvosCore/Auth/SecureEnclave/IdentityKeyWrapper.swift`](ConvosCore/Sources/ConvosCore/Auth/SecureEnclave/IdentityKeyWrapper.swift)
  — the protocol.
- [`ConvosCore/Sources/ConvosCoreiOS/SecureEnclaveIdentityKeyWrapper.swift`](ConvosCore/Sources/ConvosCoreiOS/SecureEnclaveIdentityKeyWrapper.swift)
  — the implementation.
- [`ConvosCore/Sources/ConvosCore/Auth/Keychain/KeychainIdentityStore.swift`](ConvosCore/Sources/ConvosCore/Auth/Keychain/KeychainIdentityStore.swift)
  — the store that uses the wrapper.
- [`ConvosCore/Sources/ConvosCore/Storage/ProtectedFile.swift`](ConvosCore/Sources/ConvosCore/Storage/ProtectedFile.swift)
  — the file-protection helper.
- [`ConvosCore/Tests/ConvosCoreTests/IdentityKeyWrapperTests.swift`](ConvosCore/Tests/ConvosCoreTests/IdentityKeyWrapperTests.swift)
  — tests for the wrapper protocol contract.

If anything here drifts out of sync with the code, the code is
canonical. Open a PR against this document the same day.
