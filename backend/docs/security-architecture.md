# Security Architecture

A single-page map of every security primitive in Goldilocks — iOS, backend, and the trust boundary between them. Use this as the orientation guide; the per-feature detail lives in `SECURITY.md` (backend) and `docs/plans/2026-05-29-security-hardening.md` (iOS).

---

## Trust boundary at a glance

```
                                                                              .
   ┌──────────────────────────────┐                       ┌───────────────────┐ .       ┌────────────────────────┐
   │            iOS               │                       │  Cloudflare edge  │ .       │  goldilocksdigital.xyz │
   │  (Convos main app + App Clip)│                       │  TLS-terminated   │ .       │  goldilocks-backend    │
   │                              │   HTTPS (TLS 1.3 +    │  WAF / Bot Fight  │ .       │  + agents              │
   │  • SecureWindow              │   SPKI pin) over the  │  Edge rate limits │ .       │  + Postgres            │
   │  • CertificatePinner         │ ─ Cloudflare tunnel ─ │                   │ ─ inbound tunnel ─                │
   │  • Refresh-token rotation    │                       │                   │ .       │  Non-root containers   │
   │  • XMTP E2E (separate)       │                       │                   │ .       │  F5 internal TLS       │
   │  • Keychain device-locked    │                       │                   │ .       │  F4 column encryption  │
   └──────────────────────────────┘                       └───────────────────┘ .       └────────────────────────┘
                                                                              .
                                                                  ─ public ─  ─  ─ operator-controlled ─
```

The dotted line is the trust boundary. Everything left is in user hands; everything right is in operator hands; the wire between them is HTTPS pinned end-to-end.

---

## iOS — defense in depth

```
┌──────────────────────────── App process ────────────────────────────┐
│                                                                     │
│   ┌─────────────────── SecureWindow (UIWindow shim) ─────────────┐  │
│   │                                                              │  │
│   │   ┌───────── SwiftUI scene ─────────┐                        │  │
│   │   │                                 │                        │  │
│   │   │   ConvosAPIClient               │ ─── X-Convos-AuthToken │  │
│   │   │   • Single-flight refresh       │     (short-lived JWT)  │  │
│   │   │   • Refresh-on-401              │ ─── HTTPS              │  │
│   │   │   └─ URLSession                 │     ↓                  │  │
│   │   │       └─ CertificatePinner ─────│──── SPKI hash check ───│──┼── api.goldilocksdigital.xyz
│   │   │                                 │     (shadow → enforce) │  │
│   │   │                                 │                        │  │
│   │   │   SessionStateMachine           │                        │  │
│   │   │   • SIWE handshake (secp256k1)  │                        │  │
│   │   │                                 │                        │  │
│   │   │   Profiles / drafts             │ ─── AES-256-GCM        │  │
│   │   │   (image, blob payloads)        │     HKDF per-file key  │  │
│   │   │                                 │                        │  │
│   │   │   GRDB (local store)            │ ─── NSFileProtection   │  │
│   │   │                                 │     Complete           │  │
│   │   │                                 │                        │  │
│   │   │   XMTP E2E (libxmtp)            │ ─── MLS group keys     │  │
│   │   └─────────────────────────────────┘                        │  │
│   │                                                              │  │
│   │   CaptureMonitor → Sentry (screenshot attempts, recordings)  │  │
│   └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│                Keychain (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
│                ├── XMTP identity keys (Secure Enclave-backed where supported)
│                ├── JWT access token (per deviceId)
│                └── Refresh token (per deviceId)
└─────────────────────────────────────────────────────────────────────┘
```

What each piece defends:

| Layer | Defends against |
|---|---|
| `SecureWindow` (isSecureTextEntry trick) | Casual screenshot / recording exfil — including AirPlay mirroring |
| `CertificatePinner` (SPKI pinning) | Compromised public CA, corporate MITM with installed root |
| `CaptureMonitor` (Sentry telemetry) | Visibility into who's *trying* to capture |
| `ConvosAPIClient.TokenRefresher` (actor, single-flight) | Concurrent 401s triggering refresh-token replay → false family revocation |
| Refresh-token rotation | Long-lived JWT theft window (access token TTL is 1h) |
| AES-256-GCM with HKDF per-file | Image / profile data at rest + in IPFS |
| `NSFileProtectionComplete` | Locked-device sandbox escape, forensic extraction at rest |
| Keychain access class | Off-device keychain replay, off-device backup capture |
| XMTP MLS E2E | Operator reading messages, network-level interception of content |
| `SecureWindow` debug flag (Dev only) | Lets engineers screenshot bug reports without bypassing prod |

---

## Backend — layered defenses (F1–F5)

```
                                  ┌─────────────────── Public ─────────────────────┐
                                  │                                                │
                                  │  Cloudflare tunnel (TryCloudflare quick or     │
                                  │  named) → TLS 1.3 → WAF → edge rate limits     │
                                  │                                                │
                                  └────────────────────┬───────────────────────────┘
                                                       │ private outbound tunnel
                                                       ▼
┌─────────────────────────────────────── Compose network (TLS 1.3 internal, F5) ────────────────────────────────────┐
│                                                                                                                   │
│   ┌──────────────── backend (Fastify, non-root node) ────────────────┐    ┌──────────── goldilocks-db ─────────┐  │
│   │                                                                  │    │                                    │  │
│   │   helmet (CSP, HSTS, etc.)                                       │    │  Postgres 16                       │  │
│   │   @fastify/rate-limit                                            │    │  ssl=on, min TLS 1.3               │  │
│   │     ├─ global 120/min/IP                                         │    │  CA-pinned, mTLS-ready             │  │
│   │     └─ per-route: /auth/token (10), /auth/refresh (30),          │    │  ────────────────────────────────  │  │
│   │       /device/register (5), /admin/upgrade (3), webhook off      │    │  F4 — column encryption:           │  │
│   │   pino redact (auth, signatures, push tokens, HMAC keys)         │    │   • server_agents.private_key_hex  │  │
│   │                                                                  │    │   • admin_inboxes.upgrade_code     │  │
│   │   ┌─ /v2/auth/token ────────────────────────────────────────┐    │    │   • admin_inboxes.upgrade_code_    │  │
│   │   │   issueToken (HS256, 1h)                                │    │ ──▶│       lookup (HMAC sidecar)        │  │
│   │   │   issueNewFamily (refresh, 30d, SHA-256 hash stored)    │    │    │   • clients.stripe_customer_id     │  │
│   │   └─────────────────────────────────────────────────────────┘    │    │   • billing_checkouts.*            │  │
│   │   ┌─ /v2/auth/refresh ──────────────────────────────────────┐    │    │   • devices.push_token             │  │
│   │   │   rotateRefreshToken                                    │    │    │   • subscriptions.hmac_keys (jsonb │  │
│   │   │     ├─ valid + unused → mark used, issue child          │    │    │       → text + encryptedJson)      │  │
│   │   │     ├─ used  → revoke entire family (RFC 6819 §5.2.2.3) │    │    │  ────────────────────────────────  │  │
│   │   │     └─ revoked → reject                                 │    │    │  refresh_tokens (token_hash only,  │  │
│   │   └─────────────────────────────────────────────────────────┘    │    │  never plaintext)                  │  │
│   │   ┌─ /v2/me (SIWE) ─────────────────────────────────────────┐    │    │                                    │  │
│   │   │   verifyChallenge (secp256k1 recovery, domain + nonce)  │    │    │  sessions (JTI revocation)         │  │
│   │   │   bind device_id ↔ inbox_id permanently (impersonation  │    │    └────────────────────────────────────┘  │
│   │   │     guard)                                              │    │                                            │
│   │   └─────────────────────────────────────────────────────────┘    │    ┌──────────── agent ─────────────────┐  │
│   │   ┌─ /v2/admin/upgrade ─────────────────────────────────────┐    │    │  XMTP agents (admins, reports)     │  │
│   │   │   lookupHash(code) → O(1) WHERE on upgrade_code_lookup  │    │    │  Encrypted local SQLCipher store   │  │
│   │   │     ├─ matches  → bind slot                             │    │    │  (AGENT_DB_ENCRYPTION_KEY)         │  │
│   │   │     └─ legacy row scan + opportunistic backfill         │    │    │  E2E group membership reconcile    │  │
│   │   └─────────────────────────────────────────────────────────┘    │    └────────────────────────────────────┘  │
│   │   ┌─ /v2/stripe/webhook ────────────────────────────────────┐    │                                            │
│   │   │   raw-body capture                                      │    │                                            │
│   │   │   constructEvent (signing-secret verify)                │    │                                            │
│   │   └─────────────────────────────────────────────────────────┘    │                                            │
│   └──────────────────────────────────────────────────────────────────┘                                            │
│                                                                                                                   │
│   ┌──────────────── backup (on-demand) ─────────────────────────────┐                                             │
│   │  restic + age (F1) over pg_dump + secrets bundle + repo bundles │                                             │
│   │  Off-box mirror via pull-latest-backup.sh (manual cadence)      │                                             │
│   └─────────────────────────────────────────────────────────────────┘                                             │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

Host:
   secrets/prod.env.enc  (SOPS + age, F3)        ←─── only encrypted form on disk
   secrets/.age/prod.key (chmod 0600)
   secrets/tls/          (F5 CA + leaf, rotated annually)
   backups/restic-prod/  (F1 + F2, age-encrypted snapshots)
   scripts/with-prod-secrets.sh  ←── in-memory unseal for every deploy command
```

### Where the F-numbers live

| ID | Name | Layer | File / dir |
|---|---|---|---|
| F1 | Restorable backups | restic + age | `scripts/backup.sh`, `backups/` |
| F2 | Repo bundles in backup | restic snapshot | `scripts/backup.sh` |
| F3 | Sealed env secrets | SOPS + age | `secrets/<env>.env.enc`, `scripts/with-prod-secrets.sh` |
| F4 | Column encryption | AES-256-GCM + HKDF + HMAC lookup | `src/crypto/{at-rest,encrypted-text,encrypted-json,lookup-hash}.ts` |
| F5 | Internal TLS / mTLS | Postgres ssl=verify-full | `secrets/tls/`, `docker-compose.prod.yml`, `scripts/init-tls.sh` |

---

## iOS ⇄ Backend — request lifecycle

```
   iOS                                          Backend
   ───                                          ───────
   1. App launches
   2. POST /v2/auth/token  (deviceId)  ────────▶  rate-limit (10/min/IP)
                                                  upsert device row
                                                  issueToken    (HS256, exp=now+1h, sub=deviceId, jti)
                                                  issueNewFamily(token_hash, expires_at=now+30d)
                                              ◀── {token, refreshToken, refreshExpiresAt}
   3. Keychain.save(jwt, refresh)
   4. POST /v2/auth/challenge (inboxId)  ──────▶  requireJwt
                                                  rate-limit (10/min/IP)
                                                  generate SIWE message with nonce + domain
                                              ◀── {siweMessage, nonce, expiresAt}
   5. Sign with XMTP secp256k1 key
   6. POST /v2/me {siweMessage,signature}  ────▶  requireJwt
                                                  verifyChallenge (recover address)
                                                  query XMTP node: is this eth_address in
                                                    the claimed inbox's identity ledger?
                                                  bind devices.inbox_id ↔ inbox_id (immutable)
                                              ◀── {isAdmin, inboxId, …}

   ── steady state ──
   7. GET /v2/whatever  + X-Convos-AuthToken ──▶  requireJwt → handler
                                              ◀── 200 OK
   8. (1h passes)
   9. GET /v2/whatever  + stale JWT ────────────▶ requireJwt → 401
   10. ConvosAPIClient.performAuthenticatedRequest sees 401
   11. TokenRefresher.refresh { single-flight }
   12. POST /v2/auth/refresh {refreshToken}  ──▶  rotateRefreshToken
                                                  ├─ unused, valid → mark used,
                                                  │     issue child, issue new JWT
                                                  ├─ used → revoke entire family,
                                                  │     log, return 401
                                                  └─ expired → 401
                                              ◀── {token, refreshToken, …}
   13. Keychain.save(new token + refresh)
   14. Retry original request                ──▶  200 OK

   ── logout ──
   15. POST /v2/auth/logout {refreshToken}  ──▶  revokeFamilyByToken (idempotent)
                                              ◀── 204
   16. Keychain.delete(jwt, refresh)

   ── message send (separate channel, not via backend) ──
   17. XMTP MLS group operation  ────────────────────────────────────▶  XMTP node
   18. Receiver's iOS pulls + decrypts E2E (operator can't read)
```

What the backend never sees:
- Message content (XMTP E2E, end-to-end)
- The user's XMTP private key (lives in the Secure Enclave-backed Keychain)
- Plaintext attachments (AES-256-GCM with per-image key derived in the iOS app)

What the backend stores about each user:
- `deviceId` ↔ `inbox_id` ↔ `eth_address` (immutable after first SIWE)
- `push_token` (F4-encrypted)
- `refresh_tokens.token_hash` (SHA-256, plain token never persisted)
- Per-subscription HMAC keys (F4-encrypted)
- Admin slot + upgrade code (F4-encrypted) + deterministic lookup hash

What the backend can do unilaterally without the user noticing:
- Revoke a JWT (set `sessions.revoked = true`)
- Revoke a refresh family (`refresh_tokens.revoked_at`)
- Force a re-login (delete sessions + refresh families for a device)
- Read every F4-encrypted column (it holds `APP_ENCRYPTION_KEY`)

What requires a coordinated compromise:
- Reading anyone's messages — requires XMTP MLS keys, which never leave the user's device
- Impersonating a user — requires their secp256k1 private key
- Stealing the deploy-time secrets — requires both the host AND `secrets/.age/prod.key`
- Replaying a backup — requires both the snapshot AND the restic passphrase (off-host)

---

## Operational surface — what the CLI exposes

`npm run cli -- --prod` → `Security` (added by security plan item 19) surfaces every toggle that doesn't need a redeploy:

- Cert pinning: fetch live cert, show SPKI hash, write into iOS source
- Cert pinning: switch shadow / enforce mode
- Secure-window: toggle the dev escape hatch
- JWT TTL + refresh TTL editor (re-seal on save)
- Seal & shred (deletes plaintext .env after a clean seal)
- F4 status: column encryption key present, `ENCRYPT_AT_REST_V1` state, columns backfilled
- F3 status: sealed-env drift indicator
- F5 status: cert age, expiry, mTLS toggle
- Refresh-token family audit: list active families, revoke by deviceId
- Admin upgrade lookup: regenerate hashes after a master-key rotation
