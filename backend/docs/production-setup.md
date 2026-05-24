# Goldilocks Backend — Setup Runbook (development → production)

This runbook takes the backend from a fresh clone to a working **local dev
environment** (Part 1), and then to a **live production service** on a
single box behind a Cloudflare quick tunnel (Part 2) — no domain, no
Cloudflare account, no static IP.

## Where this stands

Built and ready: the backend API and server-side agents, the production
Docker stack, the Cloudflare quick tunnel, on-box (encrypted) attachment
storage, and the `goldilocks` control CLI.

Still to do, to go live:

1. Run through **Part 1** to confirm the backend works locally.
2. Get a box with Docker + Docker Compose, Node 20+, and git.
3. Work **Part 2**: fill in the production `.env.prod`, then deploy.
4. Confirm the XMTP **production** gRPC endpoint (Part 2, step 3).
5. Point the iOS app at the tunnel URL, ship a TestFlight build (Part 2, step 5).

Deferred — not blockers for a first launch: push notifications (APNs, needs
an Apple Developer account), billing, a stable custom domain, and
uptime / error monitoring. Each is listed in the Deferred section at the end.

## Part 1 — Development environment

Get the backend running locally before touching production. Everything here
runs on your Mac.

**You need:** macOS with Docker Desktop running, Node 20+, git, and Xcode
(for the iOS app). The dev environment also drives the **goldilocks-ios**
repo — clone it next to this one.

1. **Clone both repos and install dependencies.** The CLI expects the iOS
   repo beside this one (override with the `GOLDILOCKS_IOS` environment
   variable).

   ```
   cd goldilocks-backend && npm install
   ```

   That one `npm install` is the only manual dependency step — it bootstraps
   the CLI itself. From there the CLI handles it: the dev **Start** runs
   `npm install` for you, and so does a production deploy.

2. **Start the CLI and let it create `.env.dev`:**

   ```
   npm run cli -- --dev
   ```

   On first run it sees there's no `.env.dev` and offers to set one up —
   say yes. It copies `.env.example`, generates the secrets, and writes
   `.env.dev`; the dev defaults (dev Postgres, local XMTP node, mock
   attachment storage) cover everything else. You can revisit this any time
   under **Settings**.

3. **Start the dev environment.** Still in the CLI, choose
   **Settings → Systems → Start**. That's the whole thing in one step — it
   installs dependencies, brings up the local XMTP node and the dev
   Postgres, runs migrations, and starts the backend server and the agents
   in the background. **Settings → Systems → Stop** takes it all back down;
   **Settings → View logs** opens the dev log folder. (Non-interactive:
   `npm run cli -- --dev stack up`.)

4. **Create an admin slot** so you can reach the admin side of the app:

   ```
   npm run cli -- --dev admins add <your-name>
   ```

   Note the 10-digit upgrade code it prints.

5. **Build the iOS app.** In the goldilocks-ios repo, build the
   **Convos (Local)** scheme and run it in a simulator — it talks to the
   backend on your machine. Register as a client; to become an admin, enter
   the upgrade code from step 4 in the app's debug area.

When all of that works you have a full local environment, and you're ready
for Part 2.

> Tip: `source scripts/goldilocks.zsh` from your `~/.zshrc` and you can run
> `goldilocks --dev` (or `goldilocks --prod`) from anywhere instead of
> `npm run cli --`.

## Part 2 — Production deployment

Take the same backend live on a single box, reachable through a Cloudflare
quick tunnel.

## The model

The whole backend runs on **one machine** as a Docker Compose stack:

- `goldilocks-db` — Postgres
- `backend` — the Fastify API
- `agent` — the server-side XMTP agents
- `cloudflared` — the Cloudflare quick tunnel (the only way traffic gets in)
- `backup` — nightly database + agent-data backups
- `notification-server` — XMTP push relay (enabled later, after APNs setup)

The only published port is Postgres on `127.0.0.1:5432` — loopback only, so
the `goldilocks` CLI on the box can do admin and client management. Nothing
is exposed to the network: the Cloudflare tunnel reaches the API over the
internal Docker network, so the box has no inbound ports open to the internet.

> **The tunnel URL is temporary.** A quick tunnel hands you a random
> `https://<random>.trycloudflare.com` address instead of a custom domain.
> That address stays alive as long as the `cloudflared` container keeps
> running — it survives a normal backend redeploy — but a **fresh address
> is issued whenever `cloudflared` restarts** (box reboot, crash, or an
> explicit restart of that container). Whenever it changes you must point
> the iOS app at the new address and ship a new build. The upside is setup
> takes minutes with zero DNS work; the trade-off is that churn. See
> "Moving to a stable custom domain later" at the end when you're ready.

> **Reliability note.** One box behind a tunnel is simple and cheap, but it
> is a single point of failure (power, internet, hardware). Keep the machine
> on a UPS, disable sleep, and copy `./backups` off the box periodically. If
> usage grows, the same `docker-compose.prod.yml` lifts onto a cloud VM with
> no changes.

## What the quick tunnel does not give you

A quick tunnel is not attached to a Cloudflare zone, so the dashboard
security layers that come with a full domain setup are unavailable: no WAF
managed ruleset, no edge rate limiting, no Bot Fight Mode. Protection is
whatever the app itself enforces — Helmet security headers and the built-in
120 requests/minute per-IP rate limit. That is adequate for a private
preview served to a handful of known iOS clients. Add the edge protections
by moving to a custom domain before any real public launch.

## Prerequisites

- The box has Docker + Docker Compose, Node 20+, and git, and a clone of this repo.
- **No Cloudflare account and no domain are needed** for the quick tunnel.
- Push notifications are **deferred** — see the Deferred section at the end.

---

## 1. Secrets and the `.env.prod` file

On the box, in the repo, start the CLI:

```
npm run cli -- --prod
```

It sees there's no `.env.prod` and offers to set one up — say yes. The
wizard copies `.env.production.example`, **generates** `POSTGRES_PASSWORD`,
`JWT_SECRET`, and `AGENT_DB_ENCRYPTION_KEY`, prompts for the XMTP production
gRPC endpoint (step 3 — you can skip it and fill it in later), and writes
`.env.prod` with `chmod 600`. Revisit it any time under **Environment &
setup**, which can also re-run setup, check the required values, or open the
file in your editor.

A few values the wizard leaves at their defaults:

- `CLOUDFLARE_TUNNEL_TOKEN` stays blank — the quick tunnel needs no token.
- `STORAGE_PROVIDER` is `local`: attachments are stored on the box (a Docker
  volume), so no Lighthouse account is needed. The iOS app end-to-end
  encrypts them, so only ciphertext is written to disk.
- `PUBLIC_BASE_URL` stays blank — the local storage provider builds its URLs
  from each request, tracking the tunnel hostname automatically.
- `SIWE_DOMAIN` / `SIWE_URI` are pre-filled fixed values that must match the
  iOS app — do **not** point them at the ephemeral tunnel URL.

`AGENT_DB_ENCRYPTION_KEY` — **back this up** (see step 6). Never commit
`.env.prod`; it's gitignored. `GOLDILOCKS_ALLOW_SELF_PROMOTE` is absent on
purpose — `docker-compose.prod.yml` forces it off.

## 2. The Cloudflare quick tunnel

There is nothing to set up. The `cloudflared` service in
`docker-compose.prod.yml` runs `cloudflared tunnel --url http://backend:4000`,
which opens an outbound connection to Cloudflare and is assigned a random
`trycloudflare.com` hostname. No account, no token, no dashboard.

After the stack is up (step 4), read the current public URL with:

```
./scripts/tunnel-url.sh
```

That prints something like `https://random-words-here.trycloudflare.com`.
That URL — plus `/api` — is what the iOS app points at (step 5).

Remember the URL is reissued every time `cloudflared` restarts. A normal
`./scripts/deploy.sh` only recreates the services whose image or config
changed, so `cloudflared` is left running and the URL **survives ordinary
code deploys**. It changes on a box reboot, a `cloudflared` crash, or an
explicit `docker compose ... restart cloudflared`.

## 3. XMTP production network

`.env.prod` already sets `XMTP_NETWORK=production`. One value to confirm:

- `XMTP_GRPC_URL` — the backend uses this to verify that a caller's wallet
  address is bound to the inbox they claim. Set it to XMTP's **production**
  gRPC endpoint and keep `XMTP_GRPC_SECURE=true`. Confirm the current endpoint
  in XMTP's documentation before launch.

Moving to the production network is a clean slate: the agents create fresh
inboxes on first boot, and there's no test data to migrate. The iOS app must
also be built against the XMTP production network so the two match.

## 4. Deploy

First deploy and every deploy after it — from the CLI (`--prod` → **Deploy**),
or directly:

```
./scripts/deploy.sh
```

Either way it pulls the latest code, installs dependencies, runs the preflight
checks (typecheck + tests + lint), builds the images, applies database
migrations, and starts/updates the stack.

Check it came up:

```
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f backend
curl "$(./scripts/tunnel-url.sh)/healthz"
```

Everything has `restart: unless-stopped`, so the stack comes back on its own
after a crash or a reboot. Note that a reboot gives `cloudflared` a **new**
tunnel URL — re-run `./scripts/tunnel-url.sh` afterward and update the iOS
app if it changed (step 5).

## 5. Point the iOS app at the backend

The CLI does this for you. Whenever the tunnel comes up — `--prod` →
**Cloudflare tunnel → Start** (or **Restart**, or a stack **Start**) — it
reads the tunnel URL and writes it into the iOS app's production config,
`goldilocks-ios/Convos/Config/config.prod.json` (the `backendUrl` field).
There's also **Cloudflare tunnel → Point the iOS app at this backend** to
re-sync without restarting anything. The CLI finds the iOS repo beside this
one, or at `$GOLDILOCKS_IOS`.

That leaves one genuinely manual step — building a native app can't be
driven from here: open the **production** scheme in Xcode, build, and ship
it through TestFlight / the App Store. The iOS build must also target the
XMTP **production** network so it matches the backend.

> **Whenever the tunnel URL changes** (box reboot, `cloudflared` restart):
> the CLI re-syncs `config.prod.json` the next time the tunnel comes up — you
> just rebuild and ship. The backend itself needs no change; it auto-detects
> the new host. One side effect of self-hosted storage: attachments sent
> *before* the change keep their old URL baked into the message, so they
> stop loading after a URL change — newly sent attachments are fine. To
> minimise this churn keep the box on a UPS, disable sleep, and don't
> restart `cloudflared` unnecessarily. A stable custom domain removes the
> problem entirely (last section).

## 6. Backups and restore

The `backup` service runs `scripts/backup.sh` once a day: a `pg_dump` of the
database and a tar of the agent identity data, written to `./backups` and
pruned after 30 days.

The CLI handles all of this — `--prod` → **Backups** lists every backup, runs
one on demand, and restores the database or the agent identities from a
chosen file. The commands below are what it runs, if you'd rather do it by
hand.

Attachment files (the `goldilocks-attachments` volume) are **not** in the
nightly backup — they can be large, and the `attachments` table already
records every object key. If preserving uploaded files matters, copy that
volume off-box separately.

> Backups live on the same box, so they cover bad migrations, corruption, and
> accidental deletes — **not** the box dying. Copy `./backups` to an external
> drive or off-site location regularly.

**Restore the database** — stop the app, restore, start it again:

```
docker compose --env-file .env.prod -f docker-compose.prod.yml stop backend agent
cat backups/db-YYYYMMDD-HHMMSS.dump | docker compose --env-file .env.prod \
  -f docker-compose.prod.yml exec -T goldilocks-db \
  pg_restore -U goldilocks -d goldilocks --clean --if-exists --no-owner
docker compose --env-file .env.prod -f docker-compose.prod.yml start backend agent
```

**Restore the agent identities** — stop the `agent`, clear the
`goldilocks-agent-data` volume and extract `agent-data-YYYYMMDD-HHMMSS.tar.gz`
into it, then restart. Losing the agent data **and** `AGENT_DB_ENCRYPTION_KEY`
means the agents lose their XMTP inboxes and every managed group — guard both.

## Moving to a stable custom domain later

When the tunnel-URL churn becomes annoying — or before any real public
launch — switch from the quick tunnel to a **named tunnel** on a domain you
control. This gives a permanent `https://api.<domain>` URL plus the
Cloudflare WAF, edge rate limiting, and Bot Fight Mode.

Two ways to get a domain onto Cloudflare without disturbing the existing
`goldilocksdigital.xyz` website:

- **A separate domain** (recommended for least risk). Register a cheap
  domain used only for the API, add it to Cloudflare, and move *its*
  nameservers. `goldilocksdigital.xyz` is untouched.
- **`goldilocksdigital.xyz` itself.** Moving its nameservers to Cloudflare
  makes Cloudflare authoritative for the whole zone. Before switching,
  audit every existing DNS record (A/AAAA, CNAME, **MX**, all **TXT** —
  SPF/DKIM/DMARC) and recreate anything Cloudflare's import scan misses, or
  the existing website and email break.

Then:

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** →
   **Create a tunnel** → **Cloudflared**, name it `goldilocks-prod`.
2. Copy **just the token** from the install command into `.env.prod` as
   `CLOUDFLARE_TUNNEL_TOKEN`.
3. On the tunnel's **Public Hostname** tab: subdomain `api`, your domain,
   service **HTTP**, URL `backend:4000`.
4. In `docker-compose.prod.yml`, comment out the quick-tunnel `cloudflared`
   service and uncomment the named-tunnel block below it.
5. Harden the zone: **SSL/TLS** → **Full**; **Always Use HTTPS** on;
   **WAF** managed ruleset on; **Bot Fight Mode** on; a rate-limiting rule
   (~300/min per IP → block 10 min).
6. Set `SIWE_DOMAIN` / `SIWE_URI`, `CORS_ORIGIN`, and `PUBLIC_BASE_URL` to
   the new `api.<domain>` values, point the iOS app at it, and redeploy.

## Operations cheatsheet

Day-to-day operations go through the interactive control CLI. It always
targets one environment, chosen with `--dev` or `--prod`:

```
npm run cli -- --prod
```

It opens a menu — arrow keys move, Enter selects — covering admins, a
read-only client-subscriptions view, the production stack (deploy, status,
logs, restart, backups), and the Cloudflare tunnel (start / stop, show URL).
`--dev` instead targets the local development environment. If you source
`scripts/goldilocks.zsh` from your shell, the CLI is available anywhere as
`goldilocks --prod` / `goldilocks --dev`.

Everything also has a non-interactive form, for scripting — the environment
flag is required here too:

```
npm run cli -- --prod stack deploy
npm run cli -- --prod stack status
npm run cli -- --prod stack logs backend
npm run cli -- --prod stack backup
npm run cli -- --prod tunnel url
npm run cli -- --prod admins list
npm run cli -- --prod clients list
```

The raw commands still work if you prefer them:

```
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f backend
docker compose --env-file .env.prod -f docker-compose.prod.yml restart backend
./scripts/deploy.sh
./scripts/tunnel-url.sh
```

## Deferred

- **Billing.** Stripe (card) and the crypto provider are not wired up yet.
  When you build them, the backend only ever receives seat counts — never
  client names, emails, or phone numbers.
- **Stable custom domain.** Running on an ephemeral quick-tunnel URL for
  now — see "Moving to a stable custom domain later" above.
- **Push notifications (APNs).** Deferred — going to production without push
  for now. The `notification-server` service stays commented out in
  `docker-compose.prod.yml`. When an Apple Developer account is available:
  create an APNs key (Apple Developer → Certificates, Identifiers & Profiles
  → Keys), download the `.p8` once to `secrets/apns_auth_key.p8`, set
  `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` (your app's bundle id) in
  `.env.prod`, uncomment the `notification-server` service, and redeploy.
- **Uptime monitoring.** No external monitor yet. A free UptimeRobot / Better
  Stack check against the tunnel URL's `/healthz` is a quick add when you
  want downtime alerts (re-point it whenever the URL changes).
- **Error tracking.** Logs only for now (`docker compose logs`). Sentry can be
  added later for backend exception tracking.
