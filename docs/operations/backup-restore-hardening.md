# Backup & Restore Hardening Plan

**Goal:** make the Goldilocks backend's backup and restore production-ready —
able to survive a bad migration, data corruption, an accidental delete, *or
the box itself dying* — without losing client data or the agents' identities.

This document is a plan, not a change. Nothing here is implemented yet.

---

## Answers to the immediate questions

### Do we have a restore function?

Yes — for production. `./dev/backup` lists backups, runs one on demand,
and restores either the database or the agent identities
(`scripts/backup.sh` / `scripts/restore.sh`;
also documented in `docs/production-setup.md §6`).

What's missing is *confidence* in it:

- The restore path has never been drill-tested. An untested restore is not a
  backup — it's a hope.
- The dev environment has a `Backup` action (just added to the Systems menu)
  but no `Restore`.
- A restore can silently fail if `AGENT_DB_ENCRYPTION_KEY` was lost — see
  the next answer.

### Are the agent keys backed up and protected?

Partly — and this is the most important finding in this document. There are
two distinct things people call "the agent keys":

1. **The agent's signing key** — `server_agents.private_key_hex`, the
   secp256k1 private key that *is* the agent's XMTP identity. It is stored in
   Postgres **in plaintext** (`src/db/schema.ts`, `src/agent/store.ts`), so it
   *is* captured by the nightly `pg_dump`. It is backed up, but it is **not
   protected**: anyone who can read a `db-*.dump` file has full control of
   both server agents.

2. **The agent's XMTP local database** — `/var/lib/goldilocks-agent/*.db3`,
   SQLCipher-encrypted by libxmtp using `AGENT_DB_ENCRYPTION_KEY`. It *is*
   captured by the nightly `agent-data-*.tar.gz`.

**The critical gap:** `AGENT_DB_ENCRYPTION_KEY` itself is in **no backup**. It
exists only in `.env.prod`, and `scripts/backup.sh` does not back up
`.env.prod`. The `agent-data` archive is ciphertext — it is only restorable
*with* that key. So today, backing up `agent-data` without backing up
`.env.prod` is close to pointless, and losing the box loses the key.

### Bottom line

The mechanism (nightly `pg_dump` + agent tar, on-box, with a working restore
path) is a reasonable v1. But it is **not production-ready** for one blunt
reason: every backup lives on the same box as the thing it protects, and the
one secret needed to make the agent backup usable (`AGENT_DB_ENCRYPTION_KEY`)
is never backed up at all. A disk failure or a lost box today is an
unrecoverable event. The plan below fixes that, then makes restore
trustworthy, then improves resilience.

---

## What we have today

| Piece | Detail |
|---|---|
| Schedule | `backup` service in `docker-compose.prod.yml` runs `scripts/backup.sh` in a `while true; sleep 86400` loop |
| Database | `pg_dump --format=custom --no-owner` → `backups/db-<TS>.dump` |
| Agent data | `tar -czf` of the agent volume → `backups/agent-data-<TS>.tar.gz` |
| Retention | Files older than 30 days deleted |
| Location | `./backups` on the production box — and nowhere else |
| Restore | CLI `--prod → Backups`: list, run-now, restore-db, restore-agent |
| Not backed up | `.env.prod`, the `goldilocks-attachments` volume |

What a `db-*.dump` contains: everything in Postgres — `clients`,
`client_channels`, `admin_inboxes` (including `upgrade_code`), `server_agents`
(**including plaintext `private_key_hex`**), `subscriptions`, `devices`,
`attachments` (object keys), etc.

---

## Gaps & risks

### P0 — Critical (data-loss or lockout risk; fix first)

1. **`.env.prod` is never backed up.** It holds `AGENT_DB_ENCRYPTION_KEY`,
   `POSTGRES_PASSWORD`, `JWT_SECRET`, and tunnel/storage config. Losing it
   makes `agent-data-*.tar.gz` permanently undecryptable and the agents
   unrecoverable. It is a single point of total loss.
2. **Backups never leave the box.** `backup.sh`'s own header says so. A disk
   failure, a deleted volume, ransomware, or a dead host loses the data *and*
   every backup of it simultaneously.
3. **Backups are unencrypted at rest.** A `db-*.dump` is a plaintext file
   containing the agent signing keys and admin upgrade codes. Anyone with
   read access to `./backups` (or a stolen drive) owns the system.
4. **Backup failures are silent.** The compose command does
   `|| echo "[backup] run failed"` — into a container log nobody watches.
   A backup job can be broken for weeks unnoticed.

### P1 — High

5. **Restore is untested.** No drill, no automated verification. We do not
   actually know the restore path works end-to-end.
6. **The agent signing key is plaintext in Postgres.** `private_key_hex` is a
   `text` column. Every dump, every DB snapshot, every read replica carries
   it in the clear.
7. **No backup integrity verification.** A truncated or corrupt dump looks
   like a successful backup until the day you need it.
8. **Attachment files aren't backed up.** With `STORAGE_PROVIDER=local`,
   uploaded files live in the `goldilocks-attachments` volume, which is
   excluded from the nightly run. A restore brings back the `attachments`
   rows but not the bytes — broken links.

### P2 — Medium

9. **Up to ~24h of data loss.** Daily snapshots only; no point-in-time
   recovery. A failure at 23:59 loses a full day.
10. **Scheduling is a `sleep 86400` loop.** Not a real schedule — the backup
    time drifts every container restart, and a crash-looping container could
    skip days.
11. **Dev has Backup but no Restore.** Asymmetric and easy to fix.
12. **Flat 30-day retention.** No weekly/monthly tiers, so a problem
    discovered after 31 days has no recovery point.

---

## Recommended plan

### Phase 0 — Survive a box loss (P0)

The single most important phase. Until this is done, the backups are
theatre.

- **0.1 — Add `.env.prod` to the backup set.** It is tiny. Without it the
  agent backup is unusable. (If we'd rather not put it next to the DB dump,
  back it up to a separate, tightly-controlled location — but back it up.)
- **0.2 — Replicate backups off-box automatically.** Recommended:
  **`restic` to S3-compatible object storage** (Cloudflare R2, AWS S3, or
  Backblaze B2). `restic` gives offsite + client-side encryption + dedup +
  retention + integrity-checkable snapshots in one tool. The `backup`
  service runs `restic backup` of `./backups` and `.env.prod` after each
  local dump.
- **0.3 — Encrypt backups at rest.** Falls out of 0.2 for free — `restic`
  repositories are encrypted with a passphrase. (That passphrase becomes a
  secret to safeguard, like `AGENT_DB_ENCRYPTION_KEY` — store both in a
  password manager / secrets vault, not just on the box.)
- **0.4 — Alert on backup failure.** At minimum: a healthcheck-style ping
  (e.g. healthchecks.io / Cloudflare Worker / email) that fires when a run
  fails *or* when no run has succeeded in 25h. Silent failure is the worst
  failure.

### Phase 1 — Make restore trustworthy (P1)

- **1.1 — Restore drill + runbook.** Do a real end-to-end restore onto a
  scratch host from offsite backups only. Write the result up as a
  step-by-step disaster-recovery runbook (target outline below).
- **1.2 — Automated restore verification.** After each backup, restore the
  dump into a throwaway Postgres container and run a sanity query (row
  counts on `clients`, `server_agents`, `client_channels`). Fail loudly if
  it doesn't load. This converts "we have backups" into "we have *restorable*
  backups."
- **1.3 — Encrypt `server_agents.private_key_hex` at rest.** Application-level
  encryption with a key from the environment (a new `AGENT_KEY_ENCRYPTION_KEY`,
  or reuse the secrets-management approach). This keeps plaintext agent keys
  out of every DB dump, snapshot, and log. Decision point — see below.
- **1.4 — Back up attachments.** Either include the `goldilocks-attachments`
  volume in the `restic` set, or move `local` storage to the same object
  store the backups use (cleaner long-term).

### Phase 2 — Resilience & polish (P2)

- **2.1 — Shrink the data-loss window.** Enable Postgres WAL archiving for
  point-in-time recovery, or — simpler — take dumps more often than daily.
  PITR is the production-grade answer.
- **2.2 — Real scheduling.** Replace the `sleep` loop with a cron container
  (e.g. Ofelia), a host cron/systemd timer, or the platform scheduler — so
  runs are deterministic and survive restarts.
- **2.3 — Tiered retention.** `restic forget --keep-daily 7 --keep-weekly 4
  --keep-monthly 6` (or similar) instead of a flat 30-day prune.
- **2.4 — Dev `Restore`.** Add a restore action to the CLI Systems menu to
  match the new dev `Backup`, so the dev loop is symmetric and the restore
  code gets exercised routinely.

---

## Recommended tooling: `restic`

One tool covers most of Phase 0 and parts of Phase 1:

- **Offsite** — pushes to any S3-compatible bucket.
- **Encrypted** — repository is encrypted client-side; the box never holds a
  readable backup.
- **Deduplicated & incremental** — cheap to run often.
- **Verifiable** — `restic check` validates repository integrity.
- **Retention** — `restic forget --prune` handles tiered retention.

The local `pg_dump` / agent-tar step stays as-is (it produces clean,
restorable artifacts); `restic` becomes the layer that gets them off the box
safely. Keep the local copy too for fast restores — defence in depth.

---

## Target-state disaster-recovery runbook (outline)

To be filled in and *tested* during Phase 1:

1. Provision a fresh box, install Docker.
2. Pull the repo. Restore `.env.prod` from the secrets vault / offsite.
3. `restic restore` the latest snapshot → recover `backups/`.
4. `docker compose -f docker-compose.prod.yml up -d goldilocks-db`.
5. `pg_restore` the newest `db-*.dump`.
6. Restore the agent volume from `agent-data-*.tar.gz` (needs
   `AGENT_DB_ENCRYPTION_KEY` from the recovered `.env.prod`).
7. Restore the attachments volume.
8. Bring up `backend`, `agent`, `cloudflared`. Note the new tunnel URL.
9. Verify: agents reconnect to XMTP, a client can reach the API, channels
   reconcile.
10. Record the recovery time — that is our real RTO.

---

## Decisions needed from you

- **Offsite destination.** Cloudflare R2, AWS S3, Backblaze B2, or another
  S3-compatible store? (R2 has no egress fees and pairs naturally with the
  Cloudflare tunnel already in use.)
- **Encrypt `private_key_hex` in the DB (item 1.3)?** It's the right call for
  production, but it's a schema + code change with a migration. Alternative:
  accept it for now, relying on DB access controls plus the new at-rest
  encryption of backups. Recommendation: do it, in Phase 1.
- **Point-in-time recovery (item 2.1)?** Full WAL archiving vs. simply
  dumping every few hours. Depends on how much data loss is tolerable.
- **Scope of "production ready."** This plan targets: no single point of
  loss, encrypted offsite backups, monitored runs, and a tested restore.
  Confirm that's the bar, or adjust.

---

## Suggested sequencing

Phase 0 is small and high-leverage — it is mostly wiring `restic` into the
existing `backup` service plus a failure alert, and it removes the
catastrophic-loss risk. It should be done first and on its own. Phase 1
makes restore trustworthy and is the bulk of the "production ready" work.
Phase 2 is incremental hardening that can land over time.
