# Local Setup: Push Notifications & Apple Payments

A step-by-step guide for wiring up our **new Apple Developer account** to test push
notifications and payments **locally**. Notifications come first, then payments.

> **Scope:** Local testing only. TestFlight, associated-domain / universal-link
> verification, and production deploy are deliberately out of scope — save those
> for next time. Everything below runs against `./dev/start` and the Local Xcode
> scheme.

---

## 0. Before you start — facts about our current wiring

A few things that are already true in the repo and will save you confusion:

- **The pipeline already exists.** iOS registers a device token → `POST /v2/device/register`
  stores it → the app subscribes topics via `POST /v2/notifications/subscribe` →
  the XMTP `notification-server` watches those topics and pushes to APNs. The only
  missing pieces are the Apple credentials (`.p8`) and a couple of toggles.
- **The `notification-server` is NOT started by `./dev/start`.** `dev-env.sh`
  explicitly excludes it (`CORE_SERVICES` list). You bring it up by hand.
- **The `.p8` mount is commented out** in `backend/docker-compose.yml`. Until you
  add the key and uncomment it, push delivery silently no-ops (by design).
- **The team ID in the repo is the upstream Convos team** (`FY4NZR34Z3`) and the
  bundle IDs are `org.convos.*`. With a brand-new Apple account you'll be using a
  **different Team ID** and you may not own the `org.convos` prefix — so you'll
  register your own App IDs and swap the Team ID in the xcconfig. (More below.)
- **APNs to the iOS Simulator is limited.** The Simulator can *display* a
  notification you hand it locally (`xcrun simctl push`), but it does **not**
  receive real remote pushes from Apple. To test the *real* XMTP → notification-server
  → APNs path end-to-end you need a **physical iPhone** on the Local scheme.

Relevant config you'll be touching:

| Thing | Where |
|---|---|
| Team ID + bundle IDs (local) | `Convos/Config/Local.xcconfig` |
| APNs env (sandbox/prod) | `APNS_ENVIRONMENT` in the xcconfig (Local = `development`) |
| App entitlements | `Convos/Convos.entitlements`, `NotificationService/NotificationService.entitlements` |
| Notification server | `backend/docker-compose.yml` → `notification-server` service |
| Backend payment/notif secrets | `backend/.env.dev` (generated from `.env.example`) |

---

## Part 1 — Push Notifications

### Step 1.1 — Apple Developer portal: App IDs

Log into [developer.apple.com](https://developer.apple.com) → Certificates,
Identifiers & Profiles → **Identifiers**. Register App IDs for the Local bundle
IDs (or your rebranded equivalents). With the current xcconfig the Local IDs are:

- Main app: `org.convos.ios-local`
- Notification Service Extension: `org.convos.ios-local.ConvosNSE`
- App Clip (optional for now): `org.convos.ios-local.Clip`

> If your new account can't use the `org.convos` prefix, pick your own (e.g.
> `com.hopscotch.goldilocks*`) and update `MAIN_BUNDLE_ID` in `Local.xcconfig`.
> The NSE / Clip IDs derive from it automatically.

On **each** App ID enable these capabilities:

- **Push Notifications** (main app + NSE)
- **App Groups** — create/assign `group.<your-main-bundle-id>` (matches
  `APP_GROUP_IDENTIFIER = group.$(MAIN_BUNDLE_ID)`). The main app and the NSE must
  share the *same* group — that's how badge counts and shared state pass between them.
- **Keychain Sharing** (main app; the NSE shares the same keychain group)

### Step 1.2 — Create the APNs auth key (`.p8`)

Still in the portal → **Keys** → **+** → enable **Apple Push Notifications service
(APNs)** → register → **Download** the `.p8`.

You can only download it once. Note these three values — you need all of them for
the backend:

- **Key ID** — the 10-char ID shown next to the key
- **Team ID** — top-right of the portal (your *new* account's team)
- **Topic** — your main app bundle ID (`org.convos.ios-local` locally)

A single APNs key works for both sandbox and production, and for all your bundle IDs.

### Step 1.3 — Point Xcode at the new account

In `Convos/Config/Local.xcconfig`:

```diff
- DEVELOPMENT_TEAM = FY4NZR34Z3
+ DEVELOPMENT_TEAM = <YOUR_NEW_TEAM_ID>
```

Leave `APNS_ENVIRONMENT = development` (Local uses the APNs **sandbox**, which is
correct for dev builds). Open the project in Xcode, select the **Convos (Local)**
scheme, and confirm under Signing & Capabilities that all three targets (app, NSE,
app clip) resolve signing against the new team with no red errors. Let Xcode create
the provisioning profiles automatically.

### Step 1.4 — Drop the `.p8` into the backend

```bash
mkdir -p backend/secrets
cp ~/Downloads/AuthKey_XXXXXXXXXX.p8 backend/secrets/apns_auth_key.p8
```

`backend/secrets/` is gitignored — don't commit the key.

### Step 1.5 — Configure & enable the notification server

In `backend/docker-compose.yml`, find the `notification-server` service and:

1. Fill in the APNs values:

   ```yaml
   APNS_TOPIC: org.convos.ios-local      # your main bundle id
   APNS_KEY_ID: "ABC123DEF4"             # your key id
   APNS_TEAM_ID: "YOURTEAMID"            # your new team id
   APNS_MODE: development                # sandbox; matches Local.xcconfig
   ```

2. Uncomment the key mount at the bottom of the service:

   ```yaml
   volumes:
     - ./secrets/apns_auth_key.p8:/run/secrets/apns_auth_key.p8:ro
   ```

### Step 1.6 — Start everything

```bash
./dev/start                                   # XMTP node + Postgres + backend + agents
cd backend && docker compose up -d notification-server   # not started by dev/start
docker compose logs -f notification-server    # watch it connect to the XMTP node
```

Healthy logs show it connecting to `xmtp-node:5556` and loading the APNs key. If
`APNS_KEY_ID`/`TEAM_ID` are blank it boots but no-ops on delivery — that's the
"silent no-op" mentioned above.

### Step 1.7 — Run the app and confirm registration

Build/run **Convos (Local)** on a **physical iPhone** (see the simulator caveat
in §0). Accept the notification permission prompt, then verify the chain:

1. **Device console** — look for `Received device token from APNS`
   (`Convos/ConvosAppDelegate.swift`).
2. **Backend** — `POST /v2/device/register` arrives with `pushTokenType: "apns"`
   and `apnsEnv: "sandbox"`; a row lands in the `devices` table
   (`push_token` is stored encrypted).
3. **Subscription** — `POST /v2/notifications/subscribe` writes rows to
   `installations` + `subscriptions` (topic + HMAC keys).

### Step 1.8 — End-to-end test

From a second account/sim, send a message into a conversation the device is
subscribed to. The flow: XMTP node receives the envelope → `notification-server`
matches the topic, verifies the HMAC, decrypts via the device token → pushes to
APNs → the **NotificationService extension** decrypts the payload and renders the
message. Watch `docker compose logs -f notification-server` for the send, and the
NSE logs on-device for the decrypt.

### Step 1.9 — Simulator-only shortcut (optional)

To exercise just the **NSE decrypt + display** without Apple's servers, push a
payload straight to the Simulator:

```bash
xcrun simctl push booted org.convos.ios-local payload.apns
```

This is great for iterating on `NotificationService.swift` but it **bypasses** the
XMTP → notification-server → APNs path, so it doesn't validate the backend wiring.

---

## Part 2 — Apple Payments

Good news: the app supports **two** payment paths, and one of them needs no Apple
account at all to test locally.

### What's actually built

- **Stripe (card)** — *fully implemented*, end-to-end. Backend routes under
  `/v2/billing/*` + `/v2/stripe/webhook` credit a prepaid balance. This is the
  fastest thing to get working locally.
- **Apple IAP (StoreKit 2)** — iOS side is wired (`GoldilocksStore.swift`,
  products `com.goldilocks.deposit.100/200/300`), but the **backend verify route
  is a scaffold**: `POST /v2/billing/apple/verify` currently returns `501
  not_yet_implemented` (`backend/src/routes/apple-billing.ts`). So you can test the
  *purchase UI* locally, but the balance won't be credited until that route is built.

### Step 2.1 — Stripe locally (recommended first)

No Apple account required.

1. Grab **test-mode** keys from
   [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys).
2. In `backend/.env.dev`:

   ```bash
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=        # filled in by the next step
   ```

3. Forward webhooks to the backend and paste the printed `whsec_…` into
   `STRIPE_WEBHOOK_SECRET`:

   ```bash
   stripe listen --forward-to localhost:4000/api/v2/stripe/webhook
   ```

4. Restart the backend. Trigger a deposit from the app (amounts must be multiples
   of $100), pay with a Stripe test card (`4242 4242 4242 4242`), and watch the
   `checkout.session.completed` webhook reconcile and credit
   `clients.billing_balance_cents`.

### Step 2.2 — Apple IAP locally with a StoreKit config

This tests the **iOS purchase flow** in the Simulator with no App Store Connect
products and no sandbox Apple ID.

1. In Xcode: **File → New → File → StoreKit Configuration File**. Save it as e.g.
   `Convos/Goldilocks.storekit` (none exists yet).
2. Add three consumable products matching `GoldilocksProductID.all`:
   `com.goldilocks.deposit.100`, `.200`, `.300`, priced $100 / $200 / $300 USD.
3. **Product → Scheme → Edit Scheme → Run → Options → StoreKit Configuration** →
   select your `.storekit` file.
4. Run and tap through a purchase. StoreKit returns a signed transaction and the
   app calls `POST /v2/billing/apple/verify`.

Expect a `501` from that call until the backend is implemented — that's the next
chunk of work, not a misconfiguration.

### Step 2.3 — When you're ready to finish Apple IAP (backend)

To make Apple purchases actually credit the balance you'll need to:

1. App Store Connect → **Keys → In-App Purchase**: create an API key, download the
   `.p8`, and note Key ID + Issuer ID.
2. Fill the Apple block in `backend/.env.dev`:

   ```bash
   APPLE_BUNDLE_ID=org.convos.ios-local
   APPLE_TEAM_ID=<your team id>
   APPLE_KEY_ID=<app store connect key id>
   APPLE_ISSUER_ID=<issuer uuid>
   APPLE_PRIVATE_KEY=<.p8 contents, newlines as \n>
   APPLE_ENVIRONMENT=sandbox
   ```

3. `npm i @apple/app-store-server-library` in `backend/`.
4. Implement the `TODO`s in `backend/src/routes/apple-billing.ts` (JWS verify,
   decode, idempotency, credit balance) and `apple-webhook.ts` (renewals/refunds).

Creating real sandbox products and a sandbox Apple ID is App-Store-Connect /
TestFlight-adjacent work — fine to defer with the rest of the deploy work.

---

## Quick checklist

**Notifications**
- [ ] App IDs registered (app + NSE) with Push + App Groups + Keychain
- [ ] APNs `.p8` created; Key ID / Team ID / Topic noted
- [ ] `DEVELOPMENT_TEAM` swapped in `Local.xcconfig`; signing clean in Xcode
- [ ] `.p8` at `backend/secrets/apns_auth_key.p8`
- [ ] `notification-server` env filled + `.p8` volume uncommented
- [ ] `./dev/start` then `docker compose up -d notification-server`
- [ ] Token registers on a **physical device**; subscribe rows appear
- [ ] End-to-end message delivers a push

**Payments**
- [ ] Stripe test keys + `stripe listen`; card deposit credits balance
- [ ] `.storekit` config added; purchase UI works in Simulator
- [ ] (later) Apple backend env + `@apple/app-store-server-library` + implement verify
