# Encryption-Everywhere & Restorable-Backup Plan

**Goal.** Lock the Goldilocks backend down so (a) every plausible at-rest
and in-transit gap is encrypted and (b) one passphrase plus a copy of
the `restic` repo is enough to re-stand the whole stack — code, data,
secrets, agent identities, attachments — on a clean machine. Applies to
prod and dev with separate keys per environment, so the restore path
is exercised continuously rather than only during a disaster.

The existing [`backup-restore-hardening-plan.md`](backup-restore-hardening-plan.md)
remains the analytical case for *why* the current backup is
insufficient. This document is the confirmed implementation plan.

---

## Confirmed choices

| Decision | Choice |
|---|---|
| Backup destination | `./backups` on the box (local only) |
| Backup contents | Postgres DB **+** agent XMTP identity volume **+** attachments volume **+** secrets bundle (`.env.prod`, `./secrets/`, compose files, deploy scripts) **+** git bundles of **both** `goldilocks-backend` and `goldilocks-ios` |
| Backup engine | `restic` with a passphrase-protected local repo |
| Backup cadence | **Manual** — operator-triggered, no scheduled runs, no failure alerts |
| Backup passphrase | Operator's responsibility; stored wherever you choose |
| Sealed secrets store | SOPS + age |
| Internal TLS | `step-ca` (prod) + `mkcert` (dev) |
| Column encryption | App-layer AES-256-GCM via libsodium-wrappers + drizzle middleware |
| iOS hardening | Secure Enclave for the XMTP identity key; `NSFileProtectionComplete` for on-disk data |
| Existing iOS installs | Not preserved — new posture applies to all installs going forward |
| Dev parity | Same posture in dev with a dev-only passphrase |
| Operator surface | Setup, backup, restore, and key inventory all live in the existing `goldilocks` CLI |
| Testing | Each crypto feature ships with unit + integration tests; the restore path is exercised by `dev/restore-drill` |

Each feature is independent — drop any and the others still work.

---

## Two caveats to acknowledge

**Local-only + manual = box dying means data loss unless you've copied
the repo elsewhere recently.** The restic repo is encrypted at rest, so
commodity storage (iCloud Drive, USB stick, laptop, an untrusted SFTP
host) is safe to use. F7 makes copying off-box a one-command
operation; running it is on you.

---

## Features

Nine features. F1 + F2 are the foundation; F3–F7 are the backend
layering; F8 is the iOS workstream (parallel); F9 is the CLI
integration that surfaces the rest.

### F1 — Restic-based encrypted backup, run manually

Replace `scripts/backup.sh` with a restic-based pipeline, invoked by
the operator on demand via `./dev/backup run` or directly with
`./scripts/backup.sh`.

The backup is a one-shot Docker container. No long-running service,
no `sleep 86400` loop. The prod compose definition collapses to:

```yaml
backup:
  image: restic/restic:latest
  profiles: ["backup"]                # only starts when invoked
  depends_on: [goldilocks-db]
  volumes:
    - goldilocks-agent-data:/agent-data:ro
    - goldilocks-attachments:/attachments:ro
    - ./backups/restic-prod:/repo
    - ./secrets:/secrets:ro
    - ./.env.prod:/secrets/.env.prod:ro
    - ./scripts/backup.sh:/backup.sh:ro
    # Both repos mounted read-only so `git bundle` can run against them.
    # The CLI passes the resolved host paths in via env vars below.
    - ${HOST_GOLDILOCKS_BACKEND_DIR:?}:/source/goldilocks-backend:ro
    - ${HOST_GOLDILOCKS_IOS_DIR:?}:/source/goldilocks-ios:ro
  environment:
    BACKUP_SOURCE_REPOS: "/source/goldilocks-backend,/source/goldilocks-ios"
  entrypoint: ["/backup.sh"]
```

The operator runs:

```bash
docker compose -f docker-compose.prod.yml --profile backup \
  run --rm backup
```

The script then:

1. Streams `pg_dump --format=custom` from the running Postgres into
   `restic backup --stdin --stdin-filename db.dump`. The dump never
   lands as a plaintext file on disk.
2. Snapshots the agent volume, attachments volume, `.env.prod`,
   `./secrets/`, `docker-compose.prod.yml`, `Dockerfile`,
   `scripts/`, `migrations/`.
3. For each path in `BACKUP_SOURCE_REPOS`, runs `git bundle create
   <name>.bundle --all` and snapshots the resulting bundle. One file
   per repo, restic dedups the chunks across snapshots, so daily
   source-code backups are nearly free in storage.
4. Writes the current backend commit SHA into `repo-snapshot.txt` so
   the restore script can refuse a code mismatch.
5. Runs `restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6
   --prune`.
6. Runs `restic check --read-data-subset=5%` and exits non-zero if
   verification fails.

Passphrase is read from `RESTIC_PASSWORD_FILE` (Docker secret mount).
Restic supports `restic key add` / `restic key remove`, so the
passphrase can be rotated later without re-encrypting the repo.

Storage win: a typical snapshot stores only changed Postgres pages
and new attachment chunks — expect 5–10× reduction vs. the current
full-tarball approach. Tiered retention plus dedup means you can keep
more history in the same disk footprint.

### F2 — `scripts/restore.sh`: one command, fresh machine, working stack

```bash
./scripts/restore.sh /path/to/restic-prod-repo            # latest snapshot
./scripts/restore.sh /path/to/restic-prod-repo <snap-id>  # specific point in time
```

Restic's snapshot model means you can roll back to any retained
point, not just "the latest" — useful if you discover a bad
migration ran two days ago.

Sequence:

1. `restic snapshots` to confirm the repo opens with the passphrase.
2. `restic restore <id> --target /tmp/restore` to materialise all
   captured files including the git bundles.
3. Read `repo-snapshot.txt`. If running from an existing checkout
   whose SHA doesn't match the captured one, refuse — so a restore
   can't silently downgrade code. With `--bootstrap` (the "box died,
   nothing on disk yet" mode), `git clone goldilocks-backend.bundle
   ./goldilocks-backend` rehydrates the backend repo at the
   captured commit before anything else runs.
4. Lay down `.env.prod`, `secrets/`, `docker-compose.prod.yml`.
5. `docker compose up -d goldilocks-db`, wait for healthcheck.
6. `pg_restore` the dump into the fresh database.
7. Load the agent and attachments archives into their named volumes
   via a one-shot helper container so volume permissions stay
   correct.
8. `docker compose up -d backend agent cloudflared`.
9. Probe `localhost:4000/healthz`, then call `scripts/tunnel-url.sh`
   and print the new tunnel URL.
10. Restore the iOS repo into `../goldilocks-ios` as a sibling
    directory (optional flag — only relevant if you want to rebuild
    the client from this snapshot).

Idempotency: refuses to run if a `goldilocks-prod` compose project is
already up with non-empty volumes.

### F3 — Sealed secrets via SOPS + age — **landed (v1)**

Move `.env.prod` and `./secrets/` from "plaintext at rest, chmod 600"
to "encrypted at rest, decrypted only into running container
memory."

Status: **v1 shipped.** What's live now:

- Per-env age keypair at `secrets/.age/<env>.key` (+ `.key.pub`),
  generated by `Settings → Run setup` via `age-keygen` inside the
  backup image. Gitignored.
- Encrypted env file at `secrets/<env>.env.enc`, committable.
  Created and refreshed by the CLI via `scripts/seal-env.sh`.
- `.env.<env>` remains the **runtime cache** that compose's
  `env_file:` reads from. The CLI auto-unseals at session start
  whenever the sealed file is newer than the plaintext, so the
  operator's day-to-day workflow doesn't change.
- New `Settings → Keys` screen with rows for the restic passphrase
  and the SOPS age key, plus **Seal** / **Unseal** actions and a
  drift indicator ("In sync" / ".env has changes — seal to update").

What's deferred to v2 (not in this PR):

- Wrapping compose itself in `sops exec-env` so secrets exist only
  in container memory, never on the host filesystem. v1 keeps the
  plaintext `.env.<env>` cache for compose `env_file:` compatibility.
- Key rotation flows in the Keys screen (rotate restic passphrase
  via `restic key add`/`remove`; rotate age key via
  `sops updatekeys`).

- `.env.prod` becomes `secrets/prod.env.enc`, SOPS-encrypted with an
  age recipient. Safe to commit.
- The container entrypoint runs
  `sops exec-env secrets/prod.env.enc -- /entrypoint.sh`, so the
  decrypted values exist only as the process environment of the
  running container, never on the filesystem.
- The age private key needed for decryption lives at
  `secrets/.age/prod.key`, mode 600, **included in F1's restic
  backup** so the new box can decrypt on restore.
- The restic passphrase stays separate (the operator types it on
  restore) — this prevents a stolen backup from being self-bootable.

Side effect: secrets become committable. A new collaborator with the
right age key can bring up dev directly from the repo.

### F4 — App-layer encryption for sensitive DB columns — **landed (v1)**

Status: **v1 shipped.** Notable implementation divergences from the
original plan:

- **AES-256-GCM via Node's native `crypto` module** instead of
  `libsodium-wrappers` + xchacha20-poly1305. Native module = zero added
  dependency, equally constant-time/audited via OpenSSL, sufficient
  collision margin at our row volumes (random 96-bit nonces ≪ 2^48
  guidance ceiling).
- **`hmac_keys` (jsonb) deferred to v2.** The other six columns ship.
  Wrapping a jsonb column needs a JSON-aware codec layer that's a
  separate small project — clean follow-up.

What's live:

- `src/crypto/at-rest.ts` — primitive `encryptAtRest(plaintext, label)`
  / `decryptAtRest(ciphertext, label)` with HKDF-per-column key
  derivation from `APP_ENCRYPTION_KEY`. Wire format `v1.<nonce-b64>.
  <ciphertext+tag-b64>`. Detection helper `isEncryptedAtRest`.
- `src/crypto/encrypted-text.ts` — drizzle `customType` codec
  (`encryptedText(name, label)`). Transparently encrypts on write,
  decrypts on read, **tolerates plaintext on read** so the rollout
  is gradual.
- `src/db/schema.ts` — `server_agents.private_key_hex`,
  `admin_inboxes.upgrade_code`, `clients.stripe_customer_id`,
  `billing_checkouts.{stripe_session_id, stripe_payment_intent_id}`,
  `devices.push_token` swapped to `encryptedText`.
- `src/crypto/at-rest.test.ts` — 11 tests covering round-trip, nonce
  uniqueness across 1k calls, tampered-ciphertext failure, label
  domain separation, wrong-key failure, UTF-8 + binary plaintexts,
  clear errors on missing/malformed key.
- `scripts/migrate-encrypt-columns.ts` — idempotent backfill: scans
  every target column, encrypts plaintext rows in place. Supports
  `--dry-run`. Wired into the CLI as
  Settings → Keys → **Encrypt remaining plaintext columns**.
- Setup auto-generates `APP_ENCRYPTION_KEY` (64-char hex) and sets
  `ENCRYPT_AT_REST_V1=true` in `.env.<env>` for fresh installs.
- Keys screen shows the new "Columns" status row (green / yellow /
  gray) and an `APP_ENCRYPTION_KEY (F4)` inventory line.

What's deferred to v2 (not in this PR):

- `subscriptions.hmac_keys` (jsonb). Needs a jsonb-aware codec.
- Key rotation. The plan mentioned `APP_ENCRYPTION_KEY` rotation
  in the Keys screen — that's a more involved flow (HKDF
  re-derive + re-encrypt every row) than the v1 ships. Manual
  rotation: deploy a new key, run a custom re-encrypt script
  per column. Putting it in the CLI is a clean follow-up.
- A "verify all columns are encrypted" health check action in
  the Keys screen (complement to the dry-run scan we have).

Targets (from `src/db/schema.ts`):

| Table | Column | Why |
|---|---|---|
| `server_agents` | `private_key_hex` | **Critical.** The secp256k1 key *is* the agent's XMTP identity. Plaintext today. |
| `admin_inboxes` | `upgrade_code` | One-time admin-claim secret. |
| `clients` | `stripe_customer_id` | Billing PII / linkage to external system. |
| `billing_checkouts` | `stripe_session_id`, `stripe_payment_intent_id` | Billing identifiers usable to query Stripe. |
| `devices` | `push_token` | Personal device identifier. |
| `subscriptions` | `hmac_keys` | Push HMAC keys. |

Skip:

- `client_people_list.ciphertext` — already E2E-encrypted with a key
  the server never sees (migration 013).
- `auth_challenges.nonce`, `sessions.jti` — short-lived, low-value,
  not worth the read-path cost.

Implementation:

- New module `src/crypto/at-rest.ts` exposing
  `encrypt(plaintext: string, label: string)` and
  `decrypt(ciphertext: string, label: string)`. Per-column derived
  keys via HKDF from a single master `APP_ENCRYPTION_KEY`, so a
  leaked dump of one column can't be cross-replayed against another.
- Primitive: `libsodium-wrappers`
  (`crypto_aead_xchacha20poly1305_ietf_encrypt`). Constant-time,
  side-channel resistant, well-audited.
- Wire format: `<nonce-b64>.<ciphertext+tag-b64>` in the existing
  text column. No schema migration required.
- Transparent integration via a small drizzle-orm column codec, so
  call sites read and write plaintext and the codec handles crypto
  on the boundary. Removes "did the dev remember to wrap this" as a
  failure mode.
- Migration: ship behind `ENCRYPT_AT_REST_V1` flag. Code reads both
  formats during transition (decrypt if it looks like ciphertext,
  return raw otherwise) and writes ciphertext. A one-shot script
  re-encrypts existing rows. Flip the flag, drop the read-fallback
  in a later release.
- The master key lives in F3's sealed secrets and is included in the
  backup. Losing it = losing the encrypted columns. Document
  prominently.

### F5 — Internal TLS between services (openssl one-shot) — **landed (v1)**

The compose network is isolated from the host network, but a single
compromised container today can read every other service's traffic
in the clear. Closing that gap with one CA per environment.

Status: **v1 shipped.** Notable implementation divergences from the
original plan:

- **Switched from the smallstep `step` CLI to openssl** for cert
  minting. openssl is already bundled in the `postgres:16` base of
  the backup image — no extra download, no fragile dependency on
  GitHub release availability. The smallstep route was attempted
  first and abandoned after the upstream tarball URL turned out to
  be unreliable in build pipelines.
- **No step-ca-as-a-service with ACME.** One-shot generation is
  simpler, gives equivalent in-network protection, and leaves a clean
  path to "step-ca + ACME + auto-renewal" later if needed.
- **mkcert dropped** for the same reason — its system-trust
  integration is for browsers, which we don't expose internally.

What's live:

- `secrets/tls/ca.{crt,key}` — 10-year self-signed P-256 ECDSA root CA
  (generated by `scripts/init-tls.sh` via openssl in the backup
  image).
- `secrets/tls/postgres.{crt,key}` — 1-year postgres server leaf with
  SANs for `goldilocks-db`, `localhost`, `127.0.0.1`.
- Postgres compose command flags now require SSL ≥ TLS 1.3.
- Backend + agent + backup `DATABASE_URL` use `sslmode=verify-full`
  with the pinned CA mounted into each container at
  `/etc/goldilocks-tls/ca.crt`.
- Settings → Run setup mints both files on first run.
- Settings → Keys shows TLS status (CA + leaf expiry, days remaining,
  red / yellow / green health) and exposes **Initialize TLS material**
  / **Renew TLS leaf** / **View TLS material** actions.
- Cert material is in `secrets/`, which the backup container already
  snapshots — so restoring a snapshot brings back the same CA + leaf
  and everything continues to verify without a rotation.

What's deferred to v2 (not in this PR):

- step-ca as a long-running service with ACME for automatic leaf
  rotation. Annual manual renewal via the CLI's "Renew TLS leaf"
  action is fine for one operator and one box.
- Mutual TLS (client cert verification). v1 is "server presents
  cert, client verifies CA" — covers the eavesdropping threat.
  Server-side `clientcert=verify-full` adds mTLS in a clean follow-up.

The original plan text is preserved below as the v2 design target.

- **Production CA: `step-ca`.** Added as a small service to
  `docker-compose.prod.yml`. step-ca is a self-hosted certificate
  authority in a single binary with an ACME endpoint baked in.
  Backend, agent, and Postgres get leaf certs via ACME on container
  start, auto-renewed before expiry — so cert rotation stops being
  a thing humans have to remember. Initialised once via
  `step ca init`; the root key is included in F1's backup.
- **Dev CA: `mkcert`.** `mkcert -install` adds a trusted dev CA to
  the Mac's system trust store; a one-shot script produces leaf
  certs for the dev compose services.
- **Postgres SSL on.** `ssl=on`,
  `ssl_min_protocol_version='TLSv1.3'`, client certs required
  (`hostssl ... clientcert=verify-full`). Backend and agent connect
  with `sslmode=verify-full` and pinned CA.
- **Backend ↔ cloudflared.** Cloudflared already does TLS at the
  edge; leave backend on HTTP within the isolated compose network.
  Explicit choice, not an oversight.
- **Cert material:** `secrets/tls/{ca.crt, postgres.{crt,key},
  backend.{crt,key}, agent.{crt,key}}` plus the step-ca root key.
  Included in the backup so the same CA continues to issue certs on
  a restored box — no cert rotation as part of restore.

### F6 — Dev parity

Everything above runs in dev too, with separated keys and outputs:

- `docker-compose.yml` gets the same backup container, scoped to dev,
  also gated by `--profile backup`.
- `secrets/dev.env.enc` (SOPS) + `secrets/.age/dev.key`.
- Dev restic repo at `./backups/restic-dev/`, separate from prod.
- Dev backup passphrase is a fixed, well-known value committed to
  `dev/dev-backup.passphrase` (or pulled from `direnv`). The prod
  passphrase is never committed and never in the repo.
- A new `dev/restore-drill` script:
  1. Take the latest snapshot from the dev restic repo.
  2. Spin up a parallel compose project named
     `goldilocks-restore-test` from the restored bundle.
  3. Run a smoke probe (auth challenge round-trip, channel reconcile,
     attachment fetch).
  4. Tear it all down.

Since backups are manual, the drill is too — run it whenever the
backup or restore code changes. It's the only way to know the
restore path actually works.

### F7 — `pull-latest-backup` (the local-only mitigation, via `restic copy`)

A small helper that runs **on your Mac, not the box**. With restic
in F1, it's a `restic copy` from the box's repo (reached via SFTP)
into a local repo on the Mac:

```bash
./scripts/pull-latest-backup.sh
# restic --repo ~/Backups/goldilocks/restic-prod \
#   copy --from-repo sftp:goldilocks-prod:/srv/goldilocks/backups/restic-prod
```

Subsequent runs are incremental — only new chunks transfer. The
local repo can live anywhere: iCloud Drive, a Time Machine volume, a
USB stick, an external SSH host. Restic content is encrypted at
rest, so the storage medium doesn't need to be trusted.

Run it manually after each backup, or attach a launchd plist if you
want it automatic on your side. This is what closes the gap between
"the box has a backup" and "the backup exists somewhere the dying
box isn't."

### F8 — iOS hardening (parallel workstream) — **landed (v1)**

The iOS app already has AES-256-GCM for profile images, Keychain
for identity, and SQLCipher (via XMTP) for the local message DB.
Two upgrades take it from "good" to "wallet-grade":

Status: **v1 shipped.** Notable architectural decision that wasn't
fully surfaced in the original plan:

- **iCloud Keychain sync of the XMTP identity is now off.** The
  Secure Enclave is device-bound by design — its private keys cannot
  be exported, so they cannot sync. Keeping iCloud sync of the
  identity would make the SE wrapping pointless (an attacker could
  pull the keychain item from another device on the same Apple ID).
  Trade-off accepted: new devices re-onboard via SIWE rather than
  having the identity follow the Apple ID. Per the operator's
  "really locked down" preference.
- **SE wraps, doesn't sign.** SE keys are P-256 ECDH; XMTP signing
  uses secp256k1. We can't replace the secp256k1 signing key with an
  SE-resident one. Instead the SE key derives a wrapping key via
  ECDH + HKDF, AES-GCM-encrypts the secp256k1 bytes, and stores the
  wrapped blob. On every read we unwrap (which requires the SE) and
  hand the bytes to XMTP. The raw secp256k1 key never exists at
  rest in extractable form.

What's live:

- `ConvosCore/Sources/ConvosCore/Auth/SecureEnclave/IdentityKeyWrapper.swift`
  — cross-platform protocol with a pass-through implementation for
  tests + the macOS build of ConvosCore.
- `ConvosCore/Sources/ConvosCoreiOS/SecureEnclaveIdentityKeyWrapper.swift`
  — the real implementation: `SecureEnclave.P256.KeyAgreement` key
  persisted via its `dataRepresentation` in the keychain, ECDH +
  HKDF-SHA256 + AES-GCM wrapping with a versioned wire format.
- `ConvosCore/.../KeychainIdentityStore.swift` — takes the wrapper
  via init, wraps before save / unwraps after load, and the
  underlying keychain item is now `ThisDeviceOnly` +
  non-synchronizable.
- `PlatformProviders` — new `identityKeyWrapper` field. iOS factory
  (`.iOS(accessGroup:)`) creates a real SE wrapper; tests + macOS
  inject the pass-through. Three call sites updated:
  main app (`Convos/ConvosApp.swift`), app clip
  (`ConvosAppClip/ConvosAppClipApp.swift`), notification service
  (`NotificationService/NotificationService.swift`).
- `IdentityKeyWrapperTests.swift` — round-trip, empty data, XOR
  mock wrapper, tamper-rejection via a checksum mock. The SE-backed
  tests run on-device only.

**F8.2 — `NSFileProtectionComplete` everywhere.** Sets the
app-level data-protection default via the entitlement
`com.apple.developer.default-data-protection`:

- `Convos/Convos.entitlements` →
  `NSFileProtectionComplete`. Every file the main app creates now
  defaults to "unreadable when the device is locked."
- `NotificationService/NotificationService.entitlements` →
  `NSFileProtectionCompleteUnlessOpen`. The push extension wakes
  while locked to decrypt payloads; full `Complete` would prevent
  it from writing the decrypted notification at all. Down-shift is
  deliberate and scoped to the extension target only.
- `ConvosCore/Sources/ConvosCore/Storage/ProtectedFile.swift` — a
  small explicit-protection helper for write sites that want to
  pin a class regardless of entitlement default (e.g. background
  URL session downloads that arrive while locked).

What's deferred to v2 (not in this PR):

- Per-write-site audit pass to explicitly annotate every FileManager
  / `Data.write` call with a protection class. Entitlement default
  covers everything by default; the helper makes per-site
  overrides trivial when they're needed.
- Crypto-shredding on logout (one-shot delete of the SE-wrapped
  key handle to make the entire keychain item unrecoverable
  without erasing the SQLCipher DB byte-by-byte).
- App Attest as defense in depth for device verification.

The iOS app already has AES-256-GCM for profile images, Keychain
for identity, and SQLCipher (via XMTP) for the local message DB.
The text below documents the v2 design target for reference.

**F8.1 — Secure Enclave for the XMTP identity key.** Today, the
identity key sits in the iOS Keychain. Keychain is encrypted at
rest and gated by the device passcode, but the key bytes are
extractable by anything with the right access group. Secure
Enclave keys are generated inside the SE and the private half
*cannot be extracted* — only signing operations can be performed,
and only when the SE is unlocked.

Implementation: `SecKeyCreateRandomKey` with
`kSecAttrTokenIDSecureEnclave` plus
`kSecAttrAccessControl = .privateKeyUsage | .biometryCurrentSet`.
The XMTP signing flow needs to call into the SE for every
signature instead of holding the key in memory.

No migration story. All installs use SE going forward; older
installs without an SE-backed identity simply re-onboard the next
time they're launched.

This pairs conceptually with F4: both sides of the conversation
move from "key sits in plaintext somewhere readable" to "key
lives in hardware / under a master DEK."

**F8.2 — `NSFileProtectionComplete` everywhere.** Default protection
class on iOS is `CompleteUntilFirstUserAuthentication` — files
become readable after the user unlocks once, and stay readable
until power off. `NSFileProtectionComplete` makes files readable
*only when the device is currently unlocked*, which is the right
posture for messaging app data.

Implementation: one Info.plist key (app-level default) plus an
audit pass over `FileManager` write sites — especially in
`ConvosCore` and the `NotificationService` extension — to set the
attribute on existing files.

Trade-off: NotificationService runs while the device is locked.
Push-payload decryption material must remain on
`CompleteUnlessOpen` (readable while locked but written only when
the device unlocks at least once). Plan: split storage so identity
material is `Complete`, push-decryption material is
`CompleteUnlessOpen`, and nothing leaks into the wrong bucket.

### F9 — Script integration (everything reachable from `./dev/`)

Every operator-facing action lands in the `./dev/` scripts so
there's never a "run this bash command I memorised three months ago"
step.

#### Dashboard menu (today)

```text
Admins • Clients • Payments • Deploy • Production stack •
Backups • Cloudflare tunnel • Settings • Systems • Quit
```

Backups already has the right shape — list, run, restore-db,
restore-agent. F1/F2/F6 expand it.

#### Backups screen (post-F1+F2)

```text
Available snapshots
  2026-05-27 03:00   (latest)
  2026-05-26 03:00
  ... (tiered retention listing from `restic snapshots`)

Actions:
  > Run backup now                         [F1]
    Restore from latest snapshot           [F2]
    Restore from a specific snapshot…      [F2 picker]
    Verify backup integrity                [restic check]
    Pull snapshots to laptop (prod only)   [F7]
    Open backup folder
    Back
```

The "Restore from..." flows accept the optional `--bootstrap` flag
when invoked from the CLI's "fresh box" path (a new dashboard item:
**Restore from scratch**, available before any compose project is
up).

#### Settings screen (with **Keys** above View logs, per your spec)

```text
Settings
  > Keys                       [F9 — new]
    View logs
    Re-run setup
    Open .env in editor
    Back
```

#### Keys screen (new)

Inventory + actions for every long-lived secret the system depends
on. Values are never displayed — only fingerprints, status, and
"set / not set" markers. Suggested rows:

| Row | Source | Actions |
|---|---|---|
| Restic backup passphrase | (operator-held) | **set / change** — writes a new `RESTIC_PASSWORD_FILE` and runs `restic key add` / `restic key remove` |
| SOPS age key | `secrets/.age/<env>.key` | **rotate** (re-encrypts all `*.env.enc` files) • **view fingerprint** |
| `APP_ENCRYPTION_KEY` (F4 master) | sealed secret | **rotate** (kicks off the column re-encrypt batch) • **view fingerprint** • **last rotated: <date>** |
| step-ca root | `secrets/tls/ca.crt` | **view fingerprint + expiry** • **rotate root** (manual, annual) |
| Agent signing keys | `server_agents.private_key_hex` | **list** (kind, inbox_id) • **rotate** (heavy — invalidates current XMTP identity, guarded by a confirmation) |
| JWT secret | `JWT_SECRET` in `.env.prod` | **rotate** (invalidates all sessions) |
| Lighthouse wallet key | `LIGHTHOUSE_WALLET_PRIVATE_KEY` | **view fingerprint** • **rotate** |

Each row shows: name, "set / not set", a short status line (last
rotated, expiry if applicable, what depends on it), and a list of
actions. Actions that have destructive consequences (rotating the
JWT secret, the agent signing key, the SOPS key) confirm with a
typed-string check before running, à la the existing
"Remove an admin" flow.

#### Setup flow (today)

`Settings → Run setup` already exists. F9 augments it so first-run
setup also:

- Generates a fresh restic passphrase if none exists (prompts the
  operator to copy it somewhere safe — *the only time the passphrase
  is displayed in cleartext*).
- Initialises the per-env SOPS age key.
- Initialises step-ca (prod) or runs `mkcert -install` (dev).
- Generates the master `APP_ENCRYPTION_KEY` for F4.

Setup is rerunnable — re-running it for an env that already has
keys lists what's set and asks before overwriting anything.

#### Implementation notes

- All flows shell out to `scripts/backup.sh` /
  `scripts/restore.sh` / a new `scripts/keys.sh` so the underlying
  ops are testable and runnable outside the CLI too.
- Host paths for the source-repo mounts in F1
  (`HOST_GOLDILOCKS_BACKEND_DIR`, `HOST_GOLDILOCKS_IOS_DIR`) are
  resolved by the CLI from `process.cwd()` and a small config blob
  in `.env.<env>`. The CLI nags at setup time if the iOS repo isn't
  found at the expected sibling path.

---

## Testing strategy

Each crypto feature ships with unit and integration coverage so
that "the encryption works" is something the test suite asserts on
every PR, not something the operator hopes about. Tests are part of
each feature's definition of done, not a parallel workstream.

**F1 / F2 — backup + restore round-trip.** Integration test under
`ConvosTests` / backend test suite that runs `dev/restore-drill`:
take a known dev DB state, run F1, blow away the live state, run
F2 into a `goldilocks-restore-test` compose project, assert that
key tables (`clients`, `server_agents`, `client_channels`,
`devices`) round-trip identically. Also assert that
`repo-snapshot.txt` carries the current commit SHA and the git
bundles open with `git clone --bare`.

**F3 — sealed secrets.** Unit test that `sops --encrypt` /
`sops --decrypt` round-trips a known plaintext under a dev age
key. Integration test that the entrypoint shim starts a container,
SOPS decrypts the env file, and the process sees the expected
`DATABASE_URL` value — without ever materialising plaintext on
disk (assert by inspecting the container's `/proc/1/environ` is
populated but no plaintext `.env` file exists).

**F4 — column encryption.** Heaviest testing surface, four
categories:

1. *Primitive correctness.* Unit tests in `src/crypto/at-rest.test.ts`:
   round-trip, distinct ciphertexts for same plaintext (nonce
   uniqueness across 1k invocations), tampered ciphertext raises
   auth error, distinct labels produce non-interchangeable
   ciphertexts (decrypt with the wrong label fails).
2. *Drizzle codec integration.* For each wrapped column, write a row
   through the ORM, query Postgres directly via `pg` and assert the
   raw column matches `^[A-Za-z0-9+/]+\.[A-Za-z0-9+/]+$` (i.e. it's
   ciphertext, not plaintext); query through the ORM and assert
   plaintext.
3. *Migration safety.* Mixed-format read test: seed a table with
   half plaintext, half ciphertext rows; assert the dual-format
   reader returns the right value for both. Then run the
   re-encrypt script; assert all rows are ciphertext and reads
   still work.
4. *Key isolation.* Assert that swapping the master
   `APP_ENCRYPTION_KEY` makes every encrypted column unreadable —
   protects against "wait, did rotation actually rotate?"

**F5 — internal TLS.** Negative test: connect to Postgres with
`sslmode=disable` and assert connection refused. Positive test:
backend opens a TLS connection, verifies the step-ca root, and a
query round-trips. Cert lifecycle: assert step-ca issues a leaf
cert with a < 90-day expiry, and that the renewal cron in the
backend container picks up a new leaf without restart.

**F6 — dev parity.** Already covered by the F1/F2 round-trip test
above, plus a smoke probe in `restore-drill` (auth challenge
round-trip, channel reconcile, attachment fetch).

**F7 — pull-to-laptop.** Integration test that runs F1 against a
dev box, then runs `pull-latest-backup.sh` to a temp directory,
then runs `restic check` on the pulled copy. Asserts both repos
have the same snapshot IDs.

**F8.1 — Secure Enclave.** XCTest in `ConvosTests` that:
generates an SE-backed key, signs a known message, verifies the
signature. Negative test: attempt to read the key bytes via
`SecKeyCopyExternalRepresentation` and assert it returns nil with
`errSecParam` (SE keys cannot be exported).

**F8.2 — File protection.** XCTest that writes a file in
`ConvosCore`, reads back its attributes via `FileManager`, and
asserts `FileProtectionType` is `.complete` for non-extension
files and `.completeUnlessOpen` for the NotificationService bucket.
A snapshot test at app startup that walks
`URLs(for: .applicationSupportDirectory, …)` and asserts no file
in the protected set has a weaker protection class.

**F9 — Script integration.** End-to-end test that invokes the dev
scripts (`./dev/setup`, `./dev/backup run`, `./dev/backup restore`)
and asserts the expected files land in the expected places.

---

## What I'm explicitly **not** doing

- **Off-site / cloud destination.** Local only. With restic in F1,
  flipping this on later is one config line — adding `s3:...` or
  `b2:...` as an additional `restic copy` destination. No
  re-encryption required.
- **Asymmetric / hardware-backed backup key.** Passphrase only.
  Restic's `restic key add` lets you stack a second passphrase or
  add an `age-plugin-se` / `age-plugin-yubikey` identity later
  without re-encrypting the repo.
- **Backup-failure alerts.** Skipped per your direction. The
  `restic check` step still runs and the script exits non-zero on
  failure — you'll see it in the terminal you launched the manual
  backup from. Add alerts later by piping the exit code into
  whatever notification surface you already use.
- **Backup scheduling.** Manual operation per your direction.
  Re-introducing scheduling is dropping the `--profile backup`
  flag and wrapping the script in cron / systemd / a long-running
  container, when you're ready.
- **Preserving existing iOS installs across the F8.1 rollout.** Not
  a concern per your direction. New posture is the only posture.
- **Crypto-shredding on iOS logout, App Attest.** Deferred. Worth
  revisiting later; not part of this round.
- **Host disk encryption.** Not code. Confirm FileVault is on for
  your Mac and the prod box's root volume is encrypted (LUKS or
  the cloud provider's equivalent) before deploying F1.
- **Point-in-time recovery / WAL archiving.** Daily-grain snapshots
  only. RPO is bounded by how often you run the backup.

---

## Implementation order

Each phase ships with its tests in the same PR — tests are not a
follow-up. F9 (CLI integration) lands incrementally with each
phase: F1/F2 wires the new Backups actions, F3 adds the SOPS key
rotation flow to the Keys screen, etc.

1. **F1 + F2 + F9 (Backups screen wiring)** — restic backup +
   restore script + CLI Backups screen showing snapshots and
   running the new flows. Smallest unit that delivers "boot another
   box from one passphrase + the restic repo." Stop here for a
   narrow first PR.
2. **F6 (partial)** — port F1/F2 to dev and add `restore-drill`
   so the restore path is exercised from day one.
3. **F3 + F9 (Keys screen + Setup augmentation)** — SOPS-sealed
   secrets, new Keys screen in Settings (SOPS row + setup-time
   key generation). Depends on F1 having a backup story for the
   SOPS age key.
4. **F5** — step-ca + mkcert TLS. Adds the step-ca-root row to
   Keys. Independent of F3/F4; can land in parallel.
5. **F4** — column encryption. Longest tail because of the
   per-column migration; start with
   `server_agents.private_key_hex`. Adds `APP_ENCRYPTION_KEY` and
   the agent-signing-key rows to Keys.
6. **F7** — pull-to-laptop. ~15 lines of bash, plus a Backups
   menu item.
7. **F8 (iOS, parallel)** — Secure Enclave + `NSFileProtectionComplete`.
   Separate branch, independent of all backend work.
8. **Update `docs/production-setup.md`** with the new restore
   runbook pointing at `scripts/restore.sh`. The existing runbook
   becomes "legacy / pre-restic."

---

## "Box-died" recovery narrative (target state, post-F1+F2)

If wall-clock time exceeds ~30 min on a clean Ubuntu box, something
in the plan is wrong.

```text
# On a fresh box:
1. Install Docker + restic.                                     (~3 min)
2. rsync ~/Backups/goldilocks/restic-prod from your laptop      (~3 min)
   (or any other copy you keep off-box; it's an encrypted
   restic repo, doesn't need a trusted transport)
3. curl -L https://raw.../scripts/restore-bootstrap.sh | bash
     installs sops + git
     downloads restore.sh (clones repo *from the bundle* in     (~2 min)
     step 4, so GitHub doesn't need to be reachable)
4. ./scripts/restore.sh --bootstrap ./restic-prod
     prompts for restic passphrase
     restores latest snapshot to /tmp/restore
     git clone goldilocks-backend.bundle ./goldilocks-backend
     lays down .env.prod, secrets/, compose files
     pg_restore into fresh Postgres
     loads agent + attachments volumes
     brings up the stack                                        (~10 min)
5. ./scripts/tunnel-url.sh
     prints the new https://*.trycloudflare.com URL             (~10 s)
6. Update DNS / iOS config if you're on a named tunnel.         (variable)
```

The iOS repo lives in the same snapshot; restore it separately
with `./scripts/restore.sh --ios-only ./restic-prod ../goldilocks-ios`
if and when you need the client source.

The dev equivalent is `./dev/restore-drill` and runs in under 2
minutes.

---

## Open decisions

- **F4 key model: single master or per-table masters?** Plan
  currently uses one master with HKDF domain separation per column.
  Distinct master keys would give stronger blast-radius isolation
  if a per-column key leaks; one master is simpler. Recommend the
  HKDF approach (plan default).
- **Keys screen — which rows ship in v1?** Seven rows proposed
  (restic passphrase, SOPS, `APP_ENCRYPTION_KEY`, step-ca root,
  agent signing keys, JWT secret, Lighthouse wallet). The first
  five pair directly with features in this plan; the last two
  (JWT, Lighthouse) are pre-existing secrets that would benefit
  from being listed but don't strictly need the rotate flow on
  day one. Confirm the v1 cut.

---

## First PR

F1 + F2 + the dev half of F6 + the F9 Backups screen wiring, all in
one PR. The restic-based restore path is tested by `restore-drill`
from the first commit, and the operator never has to touch a raw
bash script — Backup / Restore / Verify integrity / Pull to laptop
are all in the CLI Backups screen. F8 (iOS) lands on a separate,
parallel branch.
