# Backend

Fastify + Postgres backend for the Goldilocks Digital iOS app. Handles auth, device registration, push subscriptions, billing, XMTP agents, and attachments.

## Running

From the monorepo root:

```bash
./dev/setup     # first-time setup (generates .env.dev + secrets)
./dev/start     # Docker, migrations, server + agents (background)
./dev/status    # check what's running
./dev/stop      # tear down
./dev/reset     # wipe Docker volumes + agent data + start fresh
```

Operations scripts (from the monorepo root):

```bash
./dev/admins list             # List admin slots
./dev/admins add <name>       # Add an admin (prints upgrade code)
./dev/backup list             # List backup snapshots
./dev/backup run              # Run a backup now
./dev/keys status             # Show key material status
./dev/security status         # Show security config
```

## API surface

| Route | Method | Purpose |
|-------|--------|---------|
| `/v2/auth/token` | POST | Issue JWT (HS256, 1h TTL) + refresh token (30d) |
| `/v2/auth/refresh` | POST | Rotate refresh token (RFC 6819 family revocation) |
| `/v2/auth/challenge` | POST | Generate SIWE challenge for inbox verification |
| `/v2/me` | POST | Verify SIWE signature, bind device to inbox |
| `/v2/device/register` | POST | Store device + APNs push token |
| `/v2/notifications/*` | POST/DELETE | Subscribe/unsubscribe/unregister push topics |
| `/v2/attachments/presigned` | GET | Short-lived upload token for storage provider |
| `/v2/admin/upgrade` | POST | Redeem admin upgrade code |
| `/v2/stripe/webhook` | POST | Stripe payment events |
| `/healthz` | GET | Health check |

## Project layout

```
src/
  server.ts              Fastify entry point
  config.ts              env loading + validation
  crypto/                column encryption (AES-256-GCM, HKDF, HMAC lookup)
  db/
    schema.ts            Drizzle schema
    client.ts            connection pool (SSL required)
    migrate.ts           SQL migration runner
  middleware/
    jwt.ts               verifies X-Convos-AuthToken, attaches deviceId
  routes/                one file per resource
  storage/
    provider.ts          interface
    lighthouse.ts        Lighthouse.storage (IPFS)
    mock.ts              no-op for local dev
migrations/              numbered SQL files
scripts/
  admins.ts              admin slot management (add/remove/list)
  dev-env.sh             Docker + migration orchestration
  backup.sh              encrypted backup (restic + age)
  restore.sh             backup restore
```

## Security

See [Security Architecture](../docs/architecture/security-architecture.md) for the full picture. Backend-specific details are in [Security Backend](../docs/architecture/security-backend.md).

Key primitives: column encryption (F4), sealed env secrets via SOPS + age (F3), internal TLS between containers (F5), encrypted backups via restic + age (F1/F2).

## Documentation

All project documentation lives in [`docs/`](../docs/):

- [Walkthrough](../docs/operations/walkthrough.md) — first-time setup guide
- [Production Setup](../docs/operations/production-setup.md) — deployment runbook
- [Encryption & Backup](../docs/operations/encryption-and-backup.md) — backup system design
