# Security

This document is the operator-facing reference for the security
posture of the Goldilocks backend. It describes what is protected,
how, and what an operator needs to do (and not do) to keep the
guarantees intact.

The implementation plan and design rationale live in
[`docs/encryption-and-backup-plan.md`](docs/encryption-and-backup-plan.md).
This document focuses on the running system.

---

## 1. What the system stores, and why that matters

The backend runs as a small Docker Compose stack on a single host
fronted by a Cloudflare tunnel. The data classes it stores, and why
each one matters from a security perspective:

- **The XMTP identities of two server-side agents** (`admins-agent`,
  `reports-agent`). These are secp256k1 private keys that *are* those
  agents on the XMTP network. Anyone with these keys can impersonate
  the agents, send messages on their behalf, and add or remove members
  from every Advisory / Reports group the agents manage.
- **The admin upgrade codes.** One-time secrets that bind a particular
  iOS device to the "admin" role. An adversary with a valid code can
  claim admin status until the slot is revoked.
- **Stripe billing identifiers** — customer IDs, session IDs, payment
  intent IDs. Useful to an attacker who wants to query Stripe directly,
  refund themselves, or correlate purchases to identities.
- **iOS device push tokens.** Personal identifiers; sensitive if joined
  against other data.
- **Per-client people lists** (the encrypted CRDT in
  `client_people_list`). End-to-end encrypted with a key the server
  never sees; we forward the ciphertext.
- **JWT signing secret.** Anyone with this can mint tokens that grant
  arbitrary identities the API trusts.
- **Per-XMTP-installation push HMAC keys**, attachment object keys,
  audit events.

Roughly, the threats we defend against are:

- Theft of the box's disk (sale, scrap, exfiltration through a
  hosting-provider mistake).
- Exfiltration of a backup file by anyone with read access to it.
- Reading database queries off the wire by a compromised neighbor
  container.
- Loss of the box without prior backup — leaving the operator unable
  to bring the service back up.

What is **out of scope** for this layer of defense:

- A fully compromised running host (root + kernel access). At that
  point any in-memory secrets are readable.
- Cryptographic compromise of TLS, AES-GCM, secp256k1, or X25519
  primitives.
- Insider-threat scenarios on the part of the single operator.

---

## 2. The layered defenses, at a glance

The backend has five overlapping at-rest / in-transit defenses, plus
a backup story that gives any restored box the same posture without
re-keying:

| Layer | What it protects | Implementation |
|---|---|---|
| **F1 / F2 — Encrypted backups** | Disk loss; box loss | `restic` repo at `./backups/restic-<env>/`, passphrase-protected, snapshots DB + agent volume + attachments + secrets bundle + git bundles of both repos |
| **F3 — Sealed secrets** | Plaintext `.env.<env>` on disk; secrets in the git repo | SOPS-encrypted `secrets/<env>.env.enc`, age key per env, runtime cache regenerated on demand |
| **F4 — Column encryption** | A leaked DB dump still reveals nothing for the most sensitive columns | AES-256-GCM with HKDF-per-column key derivation from `APP_ENCRYPTION_KEY`; transparent drizzle codec |
| **F5 — Internal TLS** | Eavesdropping between containers on the compose network | Per-env self-signed CA, postgres requires SSL ≥ TLS 1.3, backend / agent / backup verify the pinned CA |
| **Cloudflare tunnel** | Inbound network exposure | No public IP, no open inbound ports — cloudflared opens an outbound tunnel and Cloudflare terminates TLS at the edge |

Each layer's design rationale lives in the plan doc. The sections
that follow document how the running system depends on them and
what the operator needs to do to keep them working.

---

## 3. Setup, day-to-day, and rotation

Every security-relevant operation lives in the goldilocks CLI, so
the operator never has to remember which file lives where.

### First-time setup

From a fresh checkout, with Docker running:

1. `npm run cli -- --dev` (or `--prod`).
2. Pick the environment if prompted.
3. **Settings → Run setup.** In one screen the CLI:
   - writes `.env.<env>` with strong random `JWT_SECRET`,
     `AGENT_DB_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEY`, and
     `POSTGRES_PASSWORD` (prod);
   - generates the restic backup passphrase at
     `.restic-passphrase.<env>` (chmod 600, gitignored);
   - mints the SOPS age key at `secrets/.age/<env>.key`, writes
     `.sops.yaml`, and seals `.env.<env>` to
     `secrets/<env>.env.enc`;
   - mints the TLS CA + postgres server leaf in `secrets/tls/`;
   - leaves a notice on screen telling you to save the
     restic passphrase somewhere safe.
4. **Backups → Build backup image** (one-time, ~1 min). Prebuilds the
   image so the first backup doesn't wait on it.
5. **Backups → View backup passphrase**, copy to your password
   manager, close the file without saving.
6. Bring the stack up via the normal path (`./dev/up` for dev,
   `./scripts/deploy.sh` for prod).

The Keys screen (Settings → Keys) is the single dashboard for
inspecting and managing all of the above.

### Running a backup

Backups are manual by design — no scheduling, no failure alerts.
Trigger them from **Backups → Run backup now** in the CLI, or
directly:

```
docker compose -f docker-compose.<env>.yml --profile backup run --rm backup
```

Each run produces one logical snapshot in the restic repo at
`./backups/restic-<env>/`. The snapshot captures: a streamed
`pg_dump`, the agent's XMTP identity volume, the attachments volume,
the entire `secrets/` directory, `.env.<env>`, the compose files,
the deploy scripts, and `git bundle --all` of both repositories.

After the backup writes its snapshot it runs `restic forget --prune`
with a tiered retention policy (7 daily, 4 weekly, 6 monthly) and a
`restic check --read-data-subset=5%` integrity check. The script
exits non-zero if any step fails — watch the terminal you launched it
in to know.

### Restoring on a fresh machine

Read the plan's "Box-died recovery narrative" for the timeboxed
version. The short version: install Docker on the new box, copy
`./backups/restic-<env>/` over (it's encrypted at rest, so commodity
transports are fine), then run `./scripts/restore.sh --bootstrap
./backups/restic-<env>`. The script rehydrates the backend repo from
the snapshot's git bundle, lays down the secrets and compose files,
runs `pg_restore` into a fresh database, loads the agent and
attachments volumes, and brings the stack up. Target time on a clean
Ubuntu host: under 30 minutes.

A restore on the **same** box where the stack is currently running
will refuse to clobber the live volumes. Stop the stack first
(`docker compose down`, volumes preserved) and re-run.

### Rotation

The CLI exposes the operations the running system has needed so far:

- **Backup passphrase.** Restic supports `restic key add` / `restic
  key remove`, which rotates the passphrase without re-encrypting the
  repo. The CLI doesn't wrap this yet; the underlying restic command
  is `docker compose --profile backup run --rm backup restic key add`.
- **SOPS age key.** Generate a new key, then run `sops updatekeys
  secrets/<env>.env.enc` against the new recipient. The encrypted
  envelope rotates; the secrets inside don't.
- **TLS postgres leaf.** Settings → Keys → **Renew TLS leaf**. The CA
  is preserved so pinned clients keep working; only the leaf rotates
  (annual cadence is fine).
- **TLS CA.** Currently a manual run of `./scripts/init-tls.sh <env>
  --force`. Re-issues the entire chain. Plan for this if/when the CA
  expires (10-year default lifetime, so this is a far-future task).
- **`APP_ENCRYPTION_KEY`** (column-encryption master). Not yet
  automated in the CLI — rotating requires re-encrypting every
  encrypted column with a HKDF re-derive. Documented as a v2
  follow-up in the plan.

### Periodic operator tasks

Manual cadence; the running system doesn't nag:

- After each backup: **Backups → Pull snapshots to laptop**. The
  prod box dying takes the local backup with it; the laptop's restic
  copy is what keeps the "spin up on another machine" promise honest.
- **Backups → Run restore drill** (dev only). Spins up a parallel
  `goldilocks-restore-test` compose project from the latest dev
  snapshot, smoke-probes it, tears down. Run this whenever any
  backup / restore code changes — it's the only way to know the
  restore path actually works before you need it.
- **Backups → Verify backup integrity.** Full `restic check
  --read-data` against the repo. Slower than the per-run subset check
  but catches anything that's drifted.
- **Keys → Encrypt remaining plaintext columns.** Idempotent;
  encrypts any rows in the F4-targeted columns that are still in the
  legacy plaintext format. Safe to run any time. The dry-run variant
  reports without writing.
- **Keys → Renew TLS leaf** before the postgres cert expires (the
  TLS-status line shows days remaining; red at < 30, yellow at
  < 90).

---

## 4. Per-feature detail

### Encrypted, restorable backups (F1 / F2)

Implementation: `dev/Dockerfile.backup` (the image with `restic` +
`pg_dump` + `git` + `sops` + `age` + `step`), `scripts/backup.sh`,
`scripts/restore.sh`. Compose service `backup` in both
`docker-compose.yml` and `docker-compose.prod.yml`, gated by
`profiles: ["backup"]` so it only runs when invoked.

The encryption envelope is restic's: AES-256 in counter mode for
content, Poly1305 for authentication, scrypt for the passphrase-key
derivation. The repo is a single directory on disk; commodity storage
for off-box copies is safe because the repo itself is encrypted.

**Critical operator note:** the restic passphrase is the only
unrecoverable secret in this system. Losing it makes the entire
backup repository permanently unreadable. Store it somewhere
durable, off the box, before doing anything else.

### Sealed secrets (F3)

Two files per environment in `secrets/`:

- `secrets/.age/<env>.key` — the age private key. Mode 600,
  gitignored. Backed up in the encrypted restic repo.
- `secrets/<env>.env.enc` — the SOPS-encrypted env file. Committable
  to git.

The runtime cache `.env.<env>` is regenerated from the encrypted
file by the CLI session-start auto-unseal, by Settings → Keys →
Unseal, or by `./scripts/unseal-env.sh <env>`. Edit `.env.<env>`
directly when you need to change a value, then Settings → Keys → Seal
to refresh the encrypted form. The Keys screen shows green / yellow
/ red drift status.

As of security plan item P1.5, `docker-compose.prod.yml` no longer
uses `env_file:` for the backend and agent services. Deploy commands
go through `scripts/with-prod-secrets.sh`, which decrypts
`secrets/prod.env.enc` into the deploy process env in-memory and
exec's `docker compose` — Compose substitutes `${VAR}` references into
the YAML and forwards only the explicit list of variables into each
container. Plaintext `.env.prod` is never required at deploy time;
it's only ever transiently present while the operator edits secrets
through the CLI Keys screen, after which it should be removed.

### Column encryption (F4)

Six columns are wrapped in AES-256-GCM with per-column derived keys:

- `server_agents.private_key_hex` — the agent secp256k1 signing key.
  Most important target — without this, even a leaked DB dump can't
  impersonate the agents.
- `admin_inboxes.upgrade_code` — admin-claim one-time secrets.
  Equality lookups against an encrypted column are impossible (each
  encrypt uses a fresh AES-GCM nonce, so re-encrypting a query value
  produces a different ciphertext than the stored row). Migration 019
  added a sidecar `upgrade_code_lookup` column carrying a
  deterministic keyed HMAC of the plaintext code — `/v2/admin/upgrade`
  and the CLI both look slots up by that column. Construction lives
  in `src/crypto/lookup-hash.ts` (HKDF-SHA256 → HMAC-SHA256 with a
  distinct per-column lookup key derived from `APP_ENCRYPTION_KEY`).
  Without the master key, an attacker holding only a DB dump cannot
  pre-compute candidate hashes across the 10^16 code space — the same
  hardness as the encryption story itself.
- `clients.stripe_customer_id`
- `billing_checkouts.stripe_session_id`,
  `billing_checkouts.stripe_payment_intent_id`
- `devices.push_token`

Implementation in `src/crypto/at-rest.ts` + `src/crypto/encrypted-text.ts`.
Reads always tolerate both encrypted and plaintext formats so a
rollout can be gradual; the migration script
(`scripts/migrate-encrypt-columns.ts`, exposed in the CLI) backfills.

The master key is `APP_ENCRYPTION_KEY` in `.env.<env>` (so it's
inside the sealed secrets envelope and the backup). HKDF-SHA256
derives a distinct 256-bit key per column from a string label like
`server_agents.private_key_hex`; this means a leaked ciphertext from
one column can't be replayed against another.

Tests live in `src/crypto/at-rest.test.ts` (run via `npm test`).
They cover round-trip, nonce uniqueness across 1k calls,
tamper-rejection via the GCM auth tag, label domain-separation,
wrong-key rejection, UTF-8 + binary plaintexts, and clear errors on
a missing / malformed master key.

As of migration 017, `subscriptions.hmac_keys` is also wrapped in v1
via `encryptedJson<HmacKey[]>` (the column was converted from `jsonb`
to `text`). The HMAC envelope keys held there protect push-payload
authenticity — encrypting them at rest closes the dump-then-replay
path. The upstream XMTP example notification server reads this column
directly as jsonb, so re-enabling its production deployment requires
either a forked reader or `ENCRYPT_AT_REST_V1=false` until the reader
is updated. Push is deferred in production today, so this affects no
live consumer.

### Internal TLS (F5)

The compose network is isolated from the host network, but a
compromised container can still read another service's traffic in
the clear unless we lock it down. So:

- Postgres boots with `ssl=on`, `ssl_min_protocol_version=TLSv1.3`,
  presenting `secrets/tls/postgres.crt` (a leaf cert with SANs for
  `goldilocks-db`, `localhost`, and `127.0.0.1`).
- **Mutual TLS.** `scripts/db-entrypoint.sh` generates a `pg_hba.conf`
  that requires every TCP connection to present a CA-signed client
  certificate (`hostssl all all all cert`). Postgres maps the cert
  CN onto the requested DB role, so the wrong CN gets rejected at
  the auth layer before any password check.
- `scripts/init-tls.sh` mints a separate client leaf per consumer
  process — `client-backend.crt/.key`, `client-agent.crt/.key`,
  `client-backup.crt/.key` — all with `CN=goldilocks` so they map to
  the standard DB role. A leaked client key revokes one
  container's access, not every container's.
- Backend, agent, and backup `DATABASE_URL` carry both
  `sslrootcert` (CA pin) and `sslcert` + `sslkey` (client identity).
- Unix-socket connections inside the postgres container stay
  password-less via `local all all trust` — only the postgres
  filesystem itself can reach them, and that already requires
  container compromise.
- The CA itself (`secrets/tls/ca.crt` + `ca.key`) is a 10-year
  self-signed root, generated by `scripts/init-tls.sh` via the
  openssl binary bundled in the backup image. Client leaves rotate
  on a yearly cadence via `scripts/renew-tls.sh`.

Backend ↔ cloudflared traffic stays plain HTTP inside the compose
network. Cloudflared handles TLS termination at the Cloudflare edge,
so the public path is HTTPS end to end; the in-network leg is
deliberately left in the clear to avoid the complexity of
cloudflared cert pinning. Documented decision, not an oversight.

### Cloudflare tunnel — the network edge

`cloudflared` runs in `docker-compose.prod.yml`. It opens an
outbound connection to Cloudflare; nothing is bound on the host's
public interfaces. The dev compose doesn't run cloudflared.

The default config uses TryCloudflare quick tunnels — no account,
no token, no domain, but the hostname is ephemeral
(`https://<random>.trycloudflare.com`, reassigned on every
cloudflared restart). The named-tunnel variant (stable custom
domain) is commented out in the compose file with a TODO; switching
to it requires putting `CLOUDFLARE_TUNNEL_TOKEN` in `.env.prod`.

The Cloudflare tunnel is the only inbound network path. The
`goldilocks-db` port is published on `127.0.0.1` only and is
unreachable from the network or the internet.

### Authentication & authorization

- **SIWE challenge / response** via `POST /v2/auth/challenge` and
  `POST /v2/me`. The challenge is a one-time nonce bound to the
  caller's `deviceId` and `inboxId`; the response signs it with an
  Ethereum-compatible key and the server cross-checks the
  `eth_address ↔ inbox_id` binding against the XMTP node's identity
  ledger.
- **JWTs** signed with `JWT_SECRET` (32 hex chars, generated by
  setup). `JWT_TTL_SECONDS` defaults to one day. The `sessions`
  table tracks `jti` + `revoked` so individual tokens can be
  invalidated.
- **Admin promotion** via the `admin_inboxes` table. Each admin slot
  is created with a unique `upgrade_code` (now F4-encrypted) that
  the operator hands to the future admin; the admin claims it from
  the iOS debug area. `disabled = true` revokes admin status
  immediately.

### Filesystem and OS-level posture

Not enforced by code, but verify before deploying:

- **Host disk encryption.** FileVault on the dev Mac; LUKS or the
  cloud provider's equivalent on the prod box. The CA private key
  and the SOPS age private key both live in `secrets/` at rest —
  host-level encryption is the last layer between them and a
  stolen-drive attacker.
- **`secrets/` permissions.** Setup `chmod 600`s the relevant files,
  but a sudo-`chmod` rampage by a careless operator could reset
  them. Periodic `ls -l secrets/.age/` to confirm `-rw-------` is
  cheap insurance.
- **Compose socket exposure.** Don't bind-mount `/var/run/docker.sock`
  into any service unless you've considered who can then escape to
  root on the host.

---

## 5. Incident response — quick reference

If something has gone wrong, work down this list:

- **Backup file leaked.** It's encrypted with the restic passphrase.
  Confirm the passphrase wasn't also leaked. If it was: assume the
  attacker has every secret in the snapshot. Rotate everything in
  the system — JWT secret, postgres password, agent signing keys,
  Stripe webhook secret, the SOPS age key, the restic passphrase
  itself.
- **`secrets/.age/<env>.key` leaked.** The attacker can decrypt
  `secrets/<env>.env.enc` from any snapshot or any committed copy.
  Mint a new age key, run `sops updatekeys` against the new
  recipient, rotate every secret inside the env file.
- **Restic passphrase leaked but the repo wasn't.** Use `restic key
  add` + `restic key remove` to swap it out. No data re-encryption
  needed.
- **Postgres TLS leaf leaked.** Settings → Keys → Renew TLS leaf.
  The CA is preserved; backend and agent keep verifying against the
  same root.
- **TLS CA private key leaked.** Generate a fresh root via
  `./scripts/init-tls.sh <env> --force`, then redeploy the entire
  stack. Backend and agent need to be restarted to pick up the new
  CA.
- **An agent signing key (`server_agents.private_key_hex`) leaked.**
  Rotate the row, restart the agent (it generates a new XMTP
  identity), accept that every group the old identity managed needs
  to be rebuilt. The clean recipe lives in `scripts/reset.ts`.
- **Stripe webhook secret leaked.** Rotate via the Stripe dashboard
  and put the new value in `.env.<env>`, then re-seal.
- **Compromised box.** Treat every secret in the snapshot as
  compromised. Stand up a new box from a snapshot taken *before* the
  compromise; rotate everything in `secrets/`. The host's restic
  passphrase + the SOPS age private key should be rotated too if
  they were exposed.

For everything except a leaked restic passphrase, the recovery
involves rotating one or more secrets and redeploying. Plan a
post-mortem afterwards: write down the indicator, the blast radius,
the rotation steps, and what could detect this earlier.

---

## 6. Known limitations and v2 follow-ups

These are deliberate v1 trade-offs documented in the plan:

- **Backups are local-only.** F7 in the plan (`pull-latest-backup.sh`
  to your laptop) is the mitigation, but it's still a manual habit.
  Off-site replication to S3 / R2 is one config line away (restic
  natively supports both) and worth a follow-up.
- **No backup-failure alerts.** Manual operation by design; the
  script exits non-zero on failure but only you see it. Worth
  revisiting if the operational load grows.
- **Backup passphrase only.** The plan documents a hardware-backed
  alternative (age-plugin-yubikey / age-plugin-se) and how to add it
  as an additional decryption path without re-encrypting existing
  snapshots.
- ~~**Sealed secrets still materialize as plaintext at deploy time.**~~
  Closed by security plan item P1.5 — `scripts/with-prod-secrets.sh`
  now decrypts the SOPS-sealed env in-memory before invoking
  `docker compose`. Compose only forwards the explicit list of
  variables declared in the YAML.
- ~~**No mTLS to Postgres.**~~ Closed in security plan item 33.
  Server-side `cert` auth in `pg_hba.conf` now requires every TCP
  connection to present a CA-signed client leaf — see the F5 section
  above.
- **No automatic TLS rotation.** A 1-year leaf with a manual annual
  renewal is acceptable. If it gets onerous, run step-ca as a
  service with ACME — designed for exactly this.
- **No column-encryption key rotation flow.** Currently a one-time
  master; rotating it requires re-encrypting every encrypted row.
  Worth surfacing in the CLI Keys screen when the operational
  pattern is clearer.
- ~~**`subscriptions.hmac_keys` (jsonb) not yet wrapped**~~ — closed
  in migration 017 via `encryptedJson` (column now text). The upstream
  notification-server reader needs an update before it can be
  re-enabled in prod; tracked in the F4 section above.

---

## 7. Reporting a vulnerability

If you believe you've found a security issue in Goldilocks, please
do not file a public GitHub issue. Email the operator directly
(see `package.json` and the project's main README for contact
information). For coordinated disclosure questions, contact
information should accompany the issue you report.

Please include: a description of the vulnerability, steps to
reproduce, affected components / commits, and any proof of concept
you have. The operator's response goal is to acknowledge receipt
within 72 hours and to follow up with a remediation plan or
clarifying questions shortly after.

---

## 8. Where to find more detail

- [`docs/encryption-and-backup-plan.md`](docs/encryption-and-backup-plan.md)
  — the implementation plan, with the rationale for each design
  decision (including the divergences from the original options:
  `step` CLI rather than step-ca-as-service, AES-256-GCM via native
  `crypto` rather than libsodium-wrappers, manual backup cadence
  rather than scheduled, local-only rather than off-site).
- [`docs/backup-restore-hardening-plan.md`](docs/backup-restore-hardening-plan.md)
  — the original analytical case for *why* the pre-F1 backup was
  insufficient. Preserved for historical context.
- [`docs/production-setup.md`](docs/production-setup.md) — the
  production-deployment runbook.
- [`scripts/backup.sh`](scripts/backup.sh),
  [`scripts/restore.sh`](scripts/restore.sh),
  [`scripts/init-tls.sh`](scripts/init-tls.sh) — the actual
  implementations, with comments that explain the design choices
  at the point of execution.
- [`scripts/goldilocks.tsx`](scripts/goldilocks.tsx) — the CLI.
  Search for "F1" / "F3" / "F4" / "F5" to find the relevant
  helpers.

If something here drifts out of sync with the code, the code is
canonical. Open a PR against this document the same day.
