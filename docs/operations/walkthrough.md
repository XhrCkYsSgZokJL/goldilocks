# First-time walkthrough — testing the security stack

A linear, copy-paste-friendly guide that takes you from a clean Mac
to "I've confirmed the whole security stack works end-to-end." Plan
on ~30 minutes of clock time, most of it watching Docker build a
container.

Two paths run in parallel: **backend** (`backend/`) and **iOS**
(the repo root). The backend goes first so the iOS app has
something to talk to.

---

## 0. Prerequisites — install once

You probably already have these. Run the checks below to confirm:

```bash
docker --version              # Docker Desktop, 24.x or newer
node --version                # 20.x or newer
xcodebuild -version           # Xcode 26 or newer
```

If `docker` fails, install Docker Desktop from
<https://www.docker.com/products/docker-desktop/> and start it.
**Docker Desktop must be running** before you launch the CLI — the
setup flow builds a container.

If `node` fails, the easiest path on macOS is `brew install node`.

If `xcodebuild` fails, install Xcode from the App Store (this is the
slow one — start it before you start anything else if it isn't there).

Everything lives in the `goldilocks` monorepo: the iOS app at the
root, the backend in `backend/`.

---

## 1. Backend — setup and install

```bash
cd ~/Desktop/git/goldilocks
cd backend && npm install
```

### 2a. Run setup

```bash
./dev/setup
```

This generates `.env.dev` with strong random secrets, builds the
`goldilocks-backup` Docker image, mints age keys, seals the env
file, and generates TLS certificates. Specifically:

- Writes `.env.dev` with strong random `JWT_SECRET`,
  `AGENT_DB_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEY` (re-runs preserve
  existing values to keep encrypted columns readable).
- Writes a strong random restic backup passphrase to
  `dev/restic-passphrase.dev` (chmod 600, gitignored).
- Builds the `goldilocks-backup` Docker image (which carries
  `restic`, `age`, `sops`, `git`, and `openssl`).
- Mints a per-env age private key at `secrets/.age/dev.key`,
  writes `.sops.yaml`, seals `.env.dev` into
  `secrets/dev.env.enc`.
- Generates a 10-year self-signed TLS CA + a 1-year postgres
  server leaf in `secrets/tls/`.

### 2b. Save the backup passphrase

Open `backend/dev/restic-passphrase.dev` and copy the contents into
1Password (or wherever you keep passwords).

This is the only unrecoverable secret in the whole system. Losing
it means losing every backup.

### 2c. Check key status

```bash
./dev/keys status
```

You should see checkmarks for `.env.dev`, age keys, sealed env, and
TLS certificates.

If the sealed env is out of sync: `./dev/keys seal`.
If TLS is missing: `./dev/keys init-tls`.

---

## 3. Backend — bring the stack up and take the first backup

```bash
./dev/start
```

This starts Docker (XMTP node + Postgres), runs database migrations,
and launches the backend server and agents as background processes.

Verify the backend is healthy:

```bash
curl -s http://localhost:4000/healthz | head
```

You should get a 200 with a small JSON body. If you see a TLS
error talking to the DB, run `./dev/keys renew-tls` and restart
the db container.

### 3a. Run the first backup

```bash
./dev/backup run
```

The backup script does:

- `pg_dump` of the dev database, streamed straight into restic
  (no plaintext dump file on disk).
- A snapshot of the agent volume, the attachments dir, the secrets
  dir, your `.env.dev`.
- `git bundle` of both `goldilocks-backend` and `goldilocks-ios`
  repos.
- `restic forget --prune` with tiered retention.
- `restic check` on a 5% sample of the new repo to catch silent
  corruption.

When it finishes, `./dev/backup list` shows your first snapshot
with a short ID and a timestamp.

### 3b. Run the restore drill — proves the end-to-end story

The restore drill runs in four steps:

1. Runs another fresh backup.
2. Restores the latest backup run into a parallel compose project
   named `goldilocks-restore-test`. Postgres comes up on host
   port 25434 (not 25433 — to avoid colliding with your live dev
   db) under an isolated network + isolated named volumes.
3. **Postgres-side smoke probes** via `docker compose exec`:
   - `SELECT count(*) FROM schema_migrations` → proves the
     pg_dump applied (the migrations table is the strongest
     signal the restore landed).
   - `SELECT count(*) FROM devices` → proves the schema is
     well-formed and queryable.
4. Tears the parallel project down — containers stopped, network
   removed, named volumes wiped.

When it ends with **`PASS: restore drill passed end-to-end`**, you
have proof that the entire encrypted-backup → restore round-trip
works: backup encryption, restic snapshot, decryption, secrets
bundle restore, pg_restore against a fresh database, volume
rehydration, and live postgres against the restored data. That's
the integration test for F1 + F2 + F6.

Notes on what the drill deliberately does NOT do:

- It does **not** start the backend service — live dev runs
  backend natively via `npm run server:dev`, so the Docker image
  is never built in normal operation. The drill validates the
  restore mechanics; verifying the backend separately is what
  `curl localhost:4000/healthz` is for.
- It does **not** start the agent or notification-server. The
  former needs the iOS app to be a useful test; the latter's
  image isn't on Docker Hub.

---

## 4. iOS — build and run

In Xcode:

```bash
open Convos.xcodeproj
```

In Xcode:

1. Select the **Convos (Local)** scheme.
2. Pick an iPhone simulator (any iPhone 15 Pro or later — Secure
   Enclave is emulated correctly in modern simulators).
3. ⌘R to build and run.

### 4a. Verify F8.1 — SE-backed identity on a fresh install

On the first launch, the app will SIWE-onboard you. Walk through
the flow — pick "client" role for a first test. When you land on
the conversations list, the identity has been:

- Generated as a fresh secp256k1 private key.
- Wrapped via the Secure Enclave (SE-backed P-256 ECDH + HKDF +
  AES-GCM).
- The wrapped blob stored in the iOS keychain with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and
  `synchronizable: false`.

To prove the wrapping actually happened, in Xcode hit ⌘⇧Y to open
the debug console, then in the running app go to the Debug View
(usually in Settings → Debug). The console shows
`[KeychainIdentityStore] save ...` at the install moment. There's
no plaintext private key in any log line.

You can also confirm iCloud sync is off:

```bash
xcrun simctl get_app_container booted org.convos.ios-local data \
  | xargs -I{} ls -la {}/Library/Keychain/
```

The keychain file is local; nothing is being copied to the
simulator's "iCloud" mock directory.

### 4b. Verify F8.2 — file protection

You can confirm the entitlement is in place by inspecting the built
app bundle:

```bash
codesign -d --entitlements - \
  $(xcrun simctl get_app_container booted org.convos.ios-local) \
  2>&1 | grep -A1 default-data-protection
```

Expect to see `<string>NSFileProtectionComplete</string>`. The
NotificationService extension's entitlement is one notch weaker by
design — confirm it separately:

```bash
codesign -d --entitlements - \
  $(xcrun simctl get_app_container booted org.convos.ios-local)/PlugIns/NotificationService.appex \
  2>&1 | grep -A1 default-data-protection
```

Expect `<string>NSFileProtectionCompleteUnlessOpen</string>`.

### 4c. Round-trip a message

To convince yourself the whole stack is working as designed, send a
test message through the app. Watch the backend terminal — you
should see:

- The backend log a Postgres query going over TLS (no plain-text
  warnings).
- The agent (if running) acknowledge the new client and provision
  the Advisory group.

That's the full path: device-encrypted identity → backend-encrypted
column for the agent's signing key → TLS-encrypted DB write → MLS-
encrypted message in the XMTP group → push payload decrypted by the
locked-but-readable notification extension. Five layers of
encryption working in one round-trip.

---

## 5. Things to know before pushing to production

Four real differences in production:

- **The prod backup passphrase is the only unrecoverable secret in
  the system.** Save it in 1Password *and* on paper in a safe before
  doing anything else. Losing it loses everything.
- **The Cloudflare tunnel hostname is ephemeral.** Each tunnel
  restart issues a new `*.trycloudflare.com` URL. Read it via
  `./scripts/tunnel-url.sh` after every restart. For a stable domain,
  switch to the named-tunnel branch in
  `docker-compose.prod.yml` (commented out, with a TODO).
- **Run the prod restore drill regularly.** Take a prod backup,
  then test a restore from the backup onto a scratch host once
  before you actually need it.
- **Save the SOPS age key off the box.** `secrets/.age/prod.key` is
  in the encrypted backup, so a working restore brings it back —
  but a fresh box with no backup needs the key from somewhere else.
  Copy it to 1Password alongside the passphrase.

---

## 6. What to do if something looks wrong

Each likely failure mode and the most direct path back:

**Setup-time issues:**

- **Setup says "TLS setup failed: docker: command not found".**
  Docker Desktop isn't running. Start it and re-run `./dev/setup`.
- **Setup says backup image build failed.** Usually a network blip
  pulling the `postgres:16` base image or fetching one of the pinned
  binaries (restic, age, sops). Re-run `./dev/setup`.

**Key status issues:**

- **TLS missing.** Run `./dev/keys init-tls`. The CA is preserved;
  only the postgres leaf rotates with `./dev/keys renew-tls`.
- **Sealed env out of sync.** Run `./dev/keys seal`. This is normal
  after re-running setup — setup refreshes `.env.dev` and the
  encrypted copy needs to catch up.

**Backup issues:**

- **Docker not running.** Start Docker Desktop and retry.
- **"locked" error.** A previous backup was interrupted and left a
  stale lock. Run `./dev/backup unlock`.
- **"input/output error" on several files.** Docker Desktop on macOS
  virtiofs bug — should be auto-mitigated by the staging-copy in
  `backup.sh`. If it recurs, restarting Docker Desktop tends to
  clear it.
- **"passphrase file missing".** `dev/restic-passphrase.dev` got
  deleted. Re-run `./dev/setup` to regenerate (this invalidates the
  existing backup repo — fine in dev).

**Start issues:**

- **Postgres container exits 1 immediately.** TLS material is
  missing or has bad ownership. Run `./dev/keys init-tls` (if
  there's no CA yet) or `./dev/keys renew-tls`, then
  `./dev/stop && ./dev/start`.
- **Migrations fail with "ECONNREFUSED localhost:25432".** Your
  `.env.dev` has a stale `DATABASE_URL`. Confirm the URL has port
  `25433` and `?sslmode=verify-full&sslrootcert=secrets/tls/ca.crt`.
  Or re-run `./dev/setup` (it re-templates the URL and preserves
  your existing secrets).

**Restore drill issues:**

- **Drill fails at "schema_migrations probe failed".** Postgres in
  the parallel project isn't reachable, or `pg_restore` didn't
  complete cleanly. Check the streaming output above the failure
  line — usually a TLS material issue on the parallel postgres or
  a port-conflict (`docker ps` to see what's bound to 25434).
- **Drill fails at "no secrets directory in snapshot".** The most
  recent backup didn't capture secrets (likely the macOS virtiofs
  bug surfaced and the staging copy retries exhausted). Run
  **Backups → Run a backup now** again, then retry the drill.

**iOS issues:**

- **iOS app crashes on first launch with "kSecItemNotFound".** A
  stale identity from a previous install is lingering in the
  simulator. Hold the app icon → Delete → reinstall. Or
  `xcrun simctl erase all` to wipe the simulator entirely.

If something here doesn't match what you see, the code is canonical
— open a PR against this document the same day.

---

## 7. Where to go next

- [`security-backend.md`](../architecture/security-backend.md) — the operator-facing reference for
  the whole security setup. Read this once after you've completed
  this walkthrough; it's the document you'll come back to.
- [`encryption-and-backup.md`](encryption-and-backup.md)
  — the implementation plan, with the rationale for every design
  decision. Useful when you're considering an extension.
- [`production-setup.md`](production-setup.md) — the
  production runbook proper.
- [`security-ios.md`](../architecture/security-ios.md)
  — the iOS-side counterpart. The two docs are designed to be read together.
