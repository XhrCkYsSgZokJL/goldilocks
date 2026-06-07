# Identity Recovery via iCloud Keychain (adopt upstream #971)

_Authored 2026-06-07 (goldilocks-v2 rebase). Reverses the F8 "no iCloud sync of the XMTP identity" decision in `docs/operations/encryption-and-backup.md` in favor of recoverability. Design to be implemented in the combined API/session/identity reconciliation pass._

## Decision

Goldilocks **will** support identity recovery: a client who loses or replaces their device gets their XMTP inbox (and thus their conversations) back, instead of re-onboarding into a fresh identity. The mechanism is **iCloud Keychain**, adopting upstream's #971 two-slot design and layering Goldilocks' F8.1 Secure-Enclave wrapping onto the runtime slot.

## Background: what must be recovered

The recoverable root is the **secp256k1 private key** in `KeychainIdentityKeys.privateKey` — it owns the XMTP inbox. The `databaseKey` (SQLCipher) is **not** backed up: the local message DB is a cache that rebuilds from the network, and a new device gets a fresh DB key. With the secp256k1 key restored, the new device creates a new XMTP *installation* under the *same inbox* and regains history.

Today the key is app-generated random + SE-wrapped + `ThisDeviceOnly` + non-synchronizable → losing the device loses it permanently (SIWE "re-onboard" produces a *new* identity, not recovery, because the eth key itself is gone).

## Design — two keychain slots (merge #971 + F8.1)

| Slot | Purpose | Sync | At-rest form | Read when |
|------|---------|------|--------------|-----------|
| **Primary** (`service = keychainService`) | Runtime identity, read every launch | `synchronizable = false`, `ThisDeviceOnly` | **SE-wrapped** (F8.1: `IdentityKeyWrapper.wrap` over the secp256k1 bytes) | always |
| **Synced backup** (`service = syncedBackupService`) | Recovery only | `synchronizable = true` → iCloud Keychain | **raw** `KeychainIdentityBackup` = `{inboxId, clientId, privateKey, deviceName, backedUpAt}` (no `databaseKey`) | only by an explicit recovery flow |

- The SE wrap still fully protects the **runtime** key device-locally — it never leaves the Enclave, so the "good" security property F8.1 bought is preserved for normal operation.
- The **recovery copy is the raw key** (SE-wrapped blobs cannot be restored on another device by definition), protected by **iCloud Keychain's** guarantees instead of our SE: Apple end-to-end encryption, HSM-backed escrow, gated on the user's Apple ID + a device passcode from the iCloud Keychain trust circle.
- Each identity backs up under its own account (keyed by `inboxId`) so multiple unpaired identities on one Apple ID coexist. When a save displaces a different identity, its backup is removed.
- The App Clip constructs the store with `syncedBackupEnabled = false` (ephemeral surface; the user never opted into backup). The full app `backfillSyncedBackupIfNeeded()` on authorize so installs predating the backup slot become recoverable.

## Recovery flow (new device)

1. New install detects no primary-slot identity.
2. Read `loadSyncedBackups()` from the iCloud-synced slot (may list several identities).
3. User picks the identity to restore (or auto-pick if exactly one).
4. Write it into the **primary** slot, **re-SE-wrapping** for *this* device (the wrap is device-specific; the restored raw key gets a fresh local wrap).
5. Create a new XMTP installation under the recovered inbox; sync history.

## Security tradeoff (recorded honestly)

This is a deliberate reversal of the documented F8 stance. The threat model shifts:

- **Before:** identity extractable only from the physical device's Secure Enclave. Maximal device-binding; zero cloud escrow; lost device = lost identity.
- **After:** identity *also* present (raw) in the user's iCloud Keychain. An attacker who **fully compromises the user's Apple ID** — credentials + 2FA + a passcode from a device in the iCloud Keychain trust circle — could extract it. This is the standard recovery posture used by password managers and most wallets; for the "really locked down" operator preference it is a step down, accepted in exchange for recoverability.

Mitigations that keep this defensible:
- Runtime key stays SE-wrapped and device-local — a stolen *device* (without the user's Apple ID) still can't extract the identity from the primary slot.
- `databaseKey` is never backed up — message-DB plaintext is not recoverable from iCloud; only the identity is.
- iCloud Keychain is itself E2E + HSM; Apple cannot read the backup.

> If the operator later wants recovery **without** Apple escrow, the fallback is a Goldilocks zero-knowledge backend escrow (key encrypted under a user-held recovery passphrase, ciphertext stored server-side). Out of scope for this pass; noted for the future.

## Implementation (in the combined reconciliation pass)

1. **`KeychainIdentityStore`**: start from upstream/dev's #971 two-slot version (revising the provisional `e397a122` "reject #971" commit). Re-apply F8.1 SE-wrapping to the **primary** slot's encode/decode only; the synced slot stores the raw `KeychainIdentityBackup`. Keep the injected `IdentityKeyWrapper`. Restore `KeychainIdentityStoreProtocol`'s `loadSyncedBackups()` / `backfillSyncedBackupIfNeeded()`.
2. **`PlatformProviders`**: keep both `identityKeyWrapper` (F8.1) and upstream's params.
3. **Call sites**: `ClipIdentityBootstrap` → `syncedBackupEnabled: false` + `keyWrapper`. `ConvosClient+App` / `NotificationExtensionEnvironment` → `keyWrapper` + default synced backup on. `SessionStateMachine` → keep `backfillSyncedBackupIfNeeded()` on authorize.
4. **Mocks/tests**: `MockKeychainIdentityStore` keeps the synced-backup methods; retain `KeychainSyncConfigTests`.
5. **Recovery UI**: a restore picker on fresh-install when synced backups exist. (Can land as a follow-up; the store + backfill are the prerequisite.)
6. **Update `docs/operations/encryption-and-backup.md`** F8 note to reflect the reversal (done alongside this doc).
