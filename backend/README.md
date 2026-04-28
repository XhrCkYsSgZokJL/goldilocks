# Goldilocks Backend

Minimal backend that replaces the Convos backend for the Goldilocks Digital iOS app.

## What it does

- **Auth** — issues our own JWTs (no Firebase App Check). `POST /v2/auth/token`
- **Device registration** — stores device + APNs push tokens. `POST /v2/device/register`
- **Push subscriptions** — tracks which device subscribes to which XMTP topics, for handoff to the XMTP notification server. `POST /v2/notifications/subscribe`, `unsubscribe`, `DELETE /v2/notifications/unregister/:clientId`
- **Attachments** — issues short-lived upload tokens for IPFS via Lighthouse. `GET /v2/attachments/presigned`

What it does *not* do (yet): subscriptions/billing, AI agents, OAuth integrations, invite-code redemption.

## Quick start

```bash
# from goldilocks-backend/
cp .env.example .env
# edit .env: at minimum set JWT_SECRET (openssl rand -hex 32)

npm install
npm run migrate          # creates tables in Postgres
npm run dev              # http://localhost:4000
```

## Postgres

Easiest: reuse the Postgres already running in convos-ios's `dev/up` stack. Default `DATABASE_URL` points at it (`postgres://postgres:xmtp@localhost:25432/goldilocks`). You may need to create the `goldilocks` database first:

```bash
docker exec -it convos-ios-db-1 psql -U postgres -c "CREATE DATABASE goldilocks;"
```

## Storage providers

Set `STORAGE_PROVIDER` in `.env`:

- `mock` — returns fake URLs; useful for local dev when you don't want to spend gas
- `lighthouse` — real IPFS uploads via Lighthouse.storage; requires `LIGHTHOUSE_API_KEY` or a funded wallet via `LIGHTHOUSE_WALLET_PRIVATE_KEY`

To swap to Pinata, Storacha, or anything else later: implement the `StorageProvider` interface in `src/storage/`.

## Project layout

```
src/
  server.ts                Fastify entry point
  config.ts                env loading + validation
  db/
    schema.ts              Drizzle schema
    client.ts              connection pool
    migrate.ts             runs SQL migrations
  middleware/
    jwt.ts                 verifies Bearer JWT, attaches deviceId
  routes/
    auth.ts                POST /v2/auth/token
    devices.ts             POST /v2/device/register
    notifications.ts       /v2/notifications/{subscribe,unsubscribe,unregister}
    attachments.ts         GET /v2/attachments/presigned
    health.ts              GET /healthz
  storage/
    provider.ts            interface
    lighthouse.ts          Lighthouse.storage impl
    mock.ts                no-op impl for dev
migrations/
  001_initial.sql
```

## Why this is one folder inside convos-ios for now

Cowork's sandbox only had access to `convos-ios/`, so this lives here temporarily. To split it into its own private GitHub repo:

```bash
mv goldilocks-backend ../
cd ../goldilocks-backend
git init
gh repo create goldilocks-digital/goldilocks-backend --private --source=. --remote=origin
git add . && git commit -m "Initial backend scaffold"
git push -u origin main
```
