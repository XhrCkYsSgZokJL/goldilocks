# First-time walkthrough — testing the security stack

A linear, copy-paste-friendly guide that takes you from a clean Mac
to "I've confirmed the whole security stack works end-to-end." Plan
on ~30 minutes of clock time, most of it watching Docker build a
container.

Two paths run in parallel: **backend** (this repo) and **iOS** (the
sibling `goldilocks-ios` checkout). They don't depend on each other
in this order, but the backend goes first so the iOS app has
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

The two repos should sit side by side, which they already do:

```
~/Desktop/git/goldilocks-backend
~/Desktop/git/goldilocks-ios
```

The backend's backup includes a git bundle of *both* repos by
default — that's why the sibling layout matters.

There is **no manual `npm install` or `./dev/up` step.** The CLI
handles both for you on first launch.

---

## 1. Backend — open the CLI (one command does it all)

```bash
cd ~/Desktop/git/goldilocks-backend
npm run cli -- --dev
```

That's it. The CLI bootstrap will:

- Detect that this is a first run and `npm install` the
  dependencies automatically (~30 s, one-time).
- Drop you into the interactive dashboard.

The dashboard navigation is `↑↓ enter`; `q` or `ctrl+c` quits.
You'll see **Admins**, **Backups**, **Clients**, **Payments**,
**Settings**, **Systems**, and **Quit**.

On a brand-new checkout where `.env.dev` doesn't exist yet, the CLI
takes you straight to the setup prompt instead of the dashboard.
That's the next step.

### 2a. Run setup (one click does everything)

Pick **Settings → Run setup**.

If you've never run setup before, the CLI will tell you it's
building the backup image and continue automatically after. This
takes about a minute. You'll see Docker output streaming. When it's
done, the screen shows a single notice like:

> Wrote .env.dev — dev defaults cover everything else. Generated
> restic passphrase at dev/restic-passphrase.dev — save it to your
> password manager (Backups → View backup passphrase). Minted age
> key (recipient age1abc…) and sealed the env file. Generated TLS
> material in secrets/tls/.

That single action just:

- Wrote `.env.dev` with strong random `JWT_SECRET`,
  `AGENT_DB_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEY` (re-runs preserve
  existing values to keep encrypted columns readable).
- Wrote a strong random restic backup passphrase to
  `dev/restic-passphrase.dev` (chmod 600, gitignored).
- Built the `goldilocks-backup` Docker image (which carries
  `restic`, `age`, `sops`, `git`, and `openssl` — everything the
  CLI needs for backups, sealed secrets, and TLS minting).
- Minted a per-env age private key at `secrets/.age/dev.key`,
  wrote `.sops.yaml`, sealed `.env.dev` into
  `secrets/dev.env.enc`.
- Generated a 10-year self-signed TLS CA + a 1-year postgres
  server leaf in `secrets/tls/`.

### 2b. Save the backup passphrase

The passphrase view is reachable from two places — pick whichever
you land on:

- **Backups → View backup passphrase**, or
- **Settings → Keys → View restic backup passphrase**.

Either one opens `dev/restic-passphrase.dev` in your default text
editor. Copy the contents into 1Password (or wherever you keep
passwords); close the file without saving any changes.

This is the only unrecoverable secret in the whole system. Losing
it means losing every backup. It's fine to copy a development
passphrase into a password manager too — the security model
benefits from operator habit.

### 2c. Check the Keys screen — everything should be green

Pick **Settings → Keys**. You should see three status lines:

- **Seal status: green** — "In sync (last sealed ...)".
- **TLS status: green** — "Healthy (leaf expires 2027-…)".
- **Columns: green** — "On — new writes are encrypted in the
  targeted columns".

**If Seal status is yellow** ("Not sealed yet" or ".env.dev has
changes"): scroll down in the Actions list and pick
**"Seal .env.dev → secrets/dev.env.enc"**. The status flips to
green instantly. This happens after a re-run of Setup, because
Setup regenerates the secrets in `.env.dev` and the encrypted
copy needs to catch up.

**If TLS status is red** (less likely on a fresh install): pick
**Renew TLS leaf** in the same screen.

**If Columns is yellow** ("Key present but ENCRYPT_AT_REST_V1=false"):
this only happens if you've manually edited `.env.dev`. Set the
flag back to `true` and re-seal.

Pick **Back** to return to Settings, and **Back** again to return
to the dashboard.

---

## 3. Backend — bring the stack up and take the first backup

In the CLI, pick **Systems → Start**. This single action:

- Starts the upstream XMTP node from `goldilocks-ios/dev/up`.
- Brings up the `goldilocks-db` Postgres container (now requiring
  SSL with the cert you just minted) and waits for the
  healthcheck.
- Runs database migrations.
- Reports a checklist of services that are up and what's left to
  start in your own terminal (`server:dev`, `agents:dev`).

When it finishes, in two separate terminals run:

```bash
cd ~/Desktop/git/goldilocks-backend
npm run server:dev          # in terminal 1
npm run agents:dev          # in terminal 2
```

These stay running for the duration of your test session.

Verify the backend is healthy:

```bash
curl -s http://localhost:4000/healthz | head
```

You should get a 200 with a small JSON body. If you see a TLS
error talking to the DB, the database certificate didn't get
picked up — re-run **Settings → Keys → Renew TLS leaf** in the
CLI and restart the db container.

### 3a. Run the first backup

Back in the CLI: **Backups → Run a backup now**. Docker output
streams; the script does:

- `pg_dump` of the dev database, streamed straight into restic
  (no plaintext dump file on disk).
- A snapshot of the agent volume, the attachments dir, the secrets
  dir, your `.env.dev`.
- `git bundle` of both `goldilocks-backend` and `goldilocks-ios`
  repos.
- `restic forget --prune` with tiered retention.
- `restic check` on a 5% sample of the new repo to catch silent
  corruption.

When it finishes, **Backups** shows your first snapshot listed
under "Snapshots (newest first)" with a short ID and a timestamp.

### 3b. Run the restore drill — proves the end-to-end story

**Backups → Run restore drill**.

Confirm the prompt. The drill runs in four steps:

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

In yet another terminal (or in Xcode's GUI):

```bash
cd ~/Desktop/git/goldilocks-ios
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

Production is `--prod` instead of `--dev` everywhere above. Four
real differences:

- **The prod backup passphrase is the only unrecoverable secret in
  the system.** Save it in 1Password *and* on paper in a safe before
  doing anything else. Losing it loses everything.
- **The Cloudflare tunnel hostname is ephemeral.** Each tunnel
  restart issues a new `*.trycloudflare.com` URL. Read it via
  `./scripts/tunnel-url.sh` after every restart. For a stable domain,
  switch to the named-tunnel branch in
  `docker-compose.prod.yml` (commented out, with a TODO).
- **Run the prod restore drill regularly.** Settings → Keys →
  Encrypt remaining plaintext columns after migration, then take a
  prod backup, then pull it to your laptop with **Backups → Pull
  snapshots to laptop**. Test a restore from the laptop copy onto a
  scratch host once before you actually need it.
- **Save the SOPS age key off the box.** `secrets/.age/prod.key` is
  in the encrypted backup, so a working restore brings it back —
  but a fresh box with no backup needs the key from somewhere else.
  Copy it to 1Password alongside the passphrase.

---

## 6. What to do if something looks wrong

Each likely failure mode and the most direct path back:

**Setup-time issues:**

- **Run setup says "TLS setup failed: docker: command not found".**
  Docker Desktop isn't running. Start it and re-run.
- **Run setup says backup image build failed.** Look at the streaming
  Docker output above the message — usually a network blip pulling
  the `postgres:16` base image or fetching one of the pinned
  binaries (restic, age, sops). Re-run setup.

**Keys screen colors:**

- **TLS status is red.** Click **Renew TLS leaf** in the same
  screen. The CA is preserved; only the postgres leaf rotates.
- **Seal status is yellow ("Not sealed yet" or ".env.dev has
  changes").** Scroll down in the actions list and pick
  **"Seal .env.dev → secrets/dev.env.enc"**. The status flips to
  green instantly. This is normal after a re-run of Setup — Setup
  refreshes `.env.dev` and the encrypted copy needs to catch up.
- **Columns is yellow ("Key present but ENCRYPT_AT_REST_V1=false").**
  You've manually edited `.env.dev` and changed the flag. Set it
  back to `true` and re-seal.

**Backups screen issues:**

- **"Snapshot fetch timed out after 15s" in red.** Docker Desktop
  isn't running or is unresponsive. Restart it.
- **"Snapshot fetch error: ... locked" + "Unlock restic repo"
  action appears.** A previous backup was interrupted and left a
  stale lock in the repo. Pick **Unlock restic repo** — it clears
  the lock and the next refresh succeeds.
- **"Backups → Run a backup now" prints "input/output error" on
  several files** with the snapshot saving as empty. This is the
  Docker Desktop on macOS virtiofs bug — should be auto-mitigated
  by the staging-copy in `backup.sh`. If it recurs, restarting
  Docker Desktop tends to clear it.
- **Backup says "passphrase file missing".** The
  `dev/restic-passphrase.dev` file got deleted somehow. Pick
  **Backups → Generate backup passphrase** to mint a new one
  (this invalidates the existing backup repo — fine in dev).

**Systems → Start issues:**

- **Postgres container exits 1 immediately.** The TLS material is
  missing or has bad ownership. Run **Settings → Keys → Initialize
  TLS material** (if there's no CA yet) or **Renew TLS leaf** (if
  postgres complains specifically about the leaf), then **Systems
  → Stop** and **Systems → Start** again.
- **Migrations fail with "ECONNREFUSED localhost:25432".** Your
  `.env.dev` has a stale `DATABASE_URL`. Settings → Open .env in
  editor; confirm the URL has port `25433` and
  `?sslmode=verify-full&sslrootcert=secrets/tls/ca.crt`. Or just
  re-run Settings → Run setup (it re-templates the URL and now
  preserves your existing secrets).

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

- [`SECURITY.md`](SECURITY.md) — the operator-facing reference for
  the whole security setup. Read this once after you've completed
  this walkthrough; it's the document you'll come back to.
- [`docs/encryption-and-backup-plan.md`](docs/encryption-and-backup-plan.md)
  — the implementation plan, with the rationale for every design
  decision. Useful when you're considering an extension.
- [`docs/production-setup.md`](docs/production-setup.md) — the
  production runbook proper.
- [`../goldilocks-ios/SECURITY.md`](../goldilocks-ios/SECURITY.md)
  — the iOS-side counterpart. Most attacks span both repos; the
  two docs are designed to be read together.
