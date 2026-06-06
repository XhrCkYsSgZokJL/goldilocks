# Security Hardening Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the twelve security gaps identified in the May 2026 audit. The existing crypto foundation (XMTP E2E, F1–F5 layered encryption, SIWE auth, AES-256-GCM image encryption) is strong; this plan covers the operational hardening, edge defenses, and unauthenticated-surface work that remain.

**Scope:** Spans `goldilocks-ios` and `goldilocks-backend`. Each item is independently shippable. Phases group by effort and dependency, not by repo.

**Out of scope:** Jailbreak/anti-debug detection, mTLS Postgres, idempotency keys, SAST tooling, pasteboard hygiene — these are noted in the audit as lower-priority and can be a follow-up plan.

---

## Phasing

| Phase | Theme | Items | Rough effort |
|-------|-------|-------|--------------|
| 1 | Quick wins — one-file diffs, no design decisions | 1, 2, 3, 4, 5, 6 | ~1 day each |
| 2 | Focused changes — require design + testing | 7, 8, 9, 10, 11 | 2–5 days each |

Phase 1 ships as one Graphite stack (six PRs on top of the plan PR). Phase 2 items each get their own stack since they cross subsystems. Item 12 (SQLCipher) was originally Phase 3 and has been dropped — see "Out of scope" below.

---

## Phase 1 — Quick Wins

### 1. Dockerfile non-root user (backend)

**Problem:** `Dockerfile` runs as root in the runtime stage. Container escape blast radius is unbounded.

**Change:** Add a `node` user in the runtime stage, `chown` the app dir, `USER node` before `CMD`. Verify volume mounts (attachments, agent data) still writable; adjust mode bits in `docker-compose*.yml` if needed.

**Files:** `Dockerfile`, possibly `docker-compose.yml`, `docker-compose.prod.yml`.

**Acceptance:** Container starts, `whoami` inside is `node`, all writes to mounted volumes succeed, push/attachment flows work end-to-end in `dev/start`.

---

### 2. Pino log redaction (backend)

**Problem:** Pino logger has no `redact` config. Auth headers, signatures, push tokens, and request bodies can land in logs.

**Change:** Configure `redact: { paths: [...], remove: false, censor: '[redacted]' }` on the Pino instance. Minimum paths: `req.headers.authorization`, `req.headers["x-firebase-appcheck"]`, `req.body.signature`, `req.body.message`, `*.pushToken`, `*.privateKey`, `*.upgradeCode`.

**Files:** `src/server.ts` (logger config block, ~lines 24–29).

**Library:** Native Pino redaction (no new dep).

**Acceptance:** Unit test that logs a synthetic request with each redacted path and asserts `[redacted]` appears. Run a representative request locally and grep the log output.

---

### 3. Sentry screenshot attachment (iOS)

**Problem:** `SentryConfiguration.swift` enables `attachScreenshot` for non-prod builds. Conversation UI in a crash report leaks plaintext message content.

**Change:** Set `options.attachScreenshot = false` for all environments. Keep `attachViewHierarchy` if useful — it doesn't capture rendered text. If screenshots are needed for triage, gate behind a build flag that's off in TestFlight.

**Files:** `ConvosCore/Sources/ConvosCore/Logging/SentryConfiguration.swift` (~line 24).

**Acceptance:** Trigger a crash in a TestFlight build, confirm Sentry event has no screenshot attachment. Existing crash grouping/symbolication still works.

---

### 4. Dependabot + audit in CI (both repos)

**Problem:** No automated dependency monitoring. `npm audit` and Swift package vulnerability scans never run.

**Change:**
- `goldilocks-backend`: Add `.github/dependabot.yml` (npm + docker ecosystems, weekly). Add `.github/workflows/audit.yml` running `npm ci && npm audit --production --audit-level=high` on PR + weekly cron.
- `goldilocks-ios`: Add `.github/dependabot.yml` (swift + github-actions ecosystems). Add a workflow running `swift package show-dependencies` and any vulnerability checker available (consider `osv-scanner` since Swift's first-party tooling is thin).

**Files:** `.github/dependabot.yml`, `.github/workflows/audit.yml` in each repo.

**Acceptance:** Workflow runs green on a baseline PR. A deliberately-introduced known-vuln dep (in a draft PR) fails the check. Dependabot opens its first PR within a week.

---

### 5. `sops exec-env` for compose (backend)

**Problem:** Deploy path decrypts SOPS bundle to plaintext `.env.<env>` on disk before `docker compose up`. Plaintext window is short but real.

**Change:** Replace `--env-file .env.prod` invocations with `sops exec-env secrets/prod.env.enc 'docker compose -f docker-compose.prod.yml up -d'`. Remove the plaintext-decrypt step from deploy docs. Verify all referenced env vars resolve.

**Files:** `scripts/` (deploy scripts), `SECURITY.md` (rotation/setup procedures), README sections that reference the old flow.

**Acceptance:** Deploy succeeds without ever writing `.env.prod` to disk. `ps auxe` on the host shows env vars only on the container process, not in a file.

---

### 6. Encrypt subscription HMAC keys (backend)

**Problem:** `subscriptions.hmac_keys` (jsonb) is plaintext at rest. Already flagged as v2 in `SECURITY.md`. The F4 codec is in place — extending it is mechanical.

**Change:** Wrap `subscriptions.hmac_keys` with the existing `encryptedText` / `encryptedJson` codec from `src/crypto/encrypted-text.ts`. Add a migration that re-encrypts existing rows. Confirm the read path tolerates both encrypted and plaintext during rollout (the codec already does this per the audit).

**Files:** `src/db/schema.ts` (subscriptions table), new file in `migrations/`, `src/crypto/at-rest.ts` if a new HKDF info string is needed.

**Acceptance:** New rows store ciphertext. Existing rows decrypt correctly. Push delivery using HMAC envelopes works end-to-end. Migration is idempotent.

---

## Phase 2 — Focused Changes

### 7. Remove Firebase App Check stub (both)

**Decision:** Path B — remove the inherited Firebase App Check stub. Goldilocks does not use Firebase, so the `X-Firebase-AppCheck` header is dead weight on every request and the backend ignores it. The unauth surface (`/v2/auth/token`, `/v2/device/register`) is defended by per-route rate limits (Item 8) and SIWE signature verification.

Native App Attest may be revisited later as a separate plan once Items 8 and 11 are deployed and we have data on whether rate-limits alone are sufficient against scripted abuse.

**Change:**
- iOS: Delete `FirebaseHelper.swift` App Check stub. Remove `X-Firebase-AppCheck` header from `ConvosAPIClient` request construction. Audit `Package.swift` for any Firebase deps that were only there for App Check and remove them (keep anything still used elsewhere).
- Backend: Remove the explicit "we don't verify this" comment and any header-reading code in `src/routes/auth.ts:12-14`. Strip the header from request schemas if it's listed.
- Docs: Add a short note in `SECURITY.md` under "Known limitations" documenting that the unauth endpoints rely on rate-limiting + SIWE for abuse mitigation, with App Attest noted as a future option.

**Files:** iOS: `ConvosCore/Sources/ConvosCore/Networking/FirebaseHelper.swift` (delete), `ConvosCore/Sources/ConvosCore/Networking/ConvosAPIClient.swift`, `ConvosCore/Package.swift`. Backend: `src/routes/auth.ts`, `SECURITY.md`.

**Library:** None added, possibly some Firebase SPM packages removed.

**Acceptance:** No `X-Firebase-AppCheck` header in any outbound request (verify via Charles or a single curl-like test). Backend logs show no "App Check header present but ignored" notices. App still authenticates and registers devices normally. `SECURITY.md` updated.

---

### 8. Per-route rate limits (backend)

**Problem:** Global limit (120 req/min/IP) lets an attacker spend the full budget on a single sensitive endpoint — `/v2/auth/token`, admin upgrade-code routes, `/v2/device/register`.

**Change:** Use `@fastify/rate-limit` route-level config to tighten:
- `/v2/auth/token`: 10/min per IP
- `/v2/device/register`: 5/min per IP
- Admin upgrade-code endpoints: 3/min per IP and 5/hour per IP (dual-window)
- Stripe webhook: skip (signature-verified)

Keep global 120/min as a backstop. Add a custom `keyGenerator` for endpoints that have a device/inbox ID, so limits are per-device once authenticated.

**Files:** `src/server.ts` (rate-limit registration), individual route files for per-route overrides.

**Acceptance:** Load test confirms the new limits trigger. Legitimate auth/registration flows still succeed. Limit-exceeded responses log enough to investigate without leaking PII.

---

### 9. iOS certificate pinning (iOS)

**Problem:** Relies on OS-default TLS validation. No defense against CA compromise or corporate MITM (which can be legitimate but undesirable for a messaging app).

**Note:** Goldilocks uses the Convos sample-app framework but is a separate product. The pinned host is the Goldilocks backend, not `convos.org`. No Firebase endpoints are in scope.

**Change:** Implement SPKI hash pinning via a custom `URLSessionDelegate` that:
- Pins the leaf and intermediate SPKI hashes of `api.goldilocksdigital.xyz` (and any other Goldilocks-controlled hosts the client talks to)
- Holds at least two pins per host (current + backup) so a single key rotation doesn't brick the app
- Reports pin failures to Sentry without breaking the connection in "shadow mode" for the first release, then flips to enforce mode after one full TestFlight cycle confirms no false positives
- Does not pin third-party hosts (XMTP nodes, etc.) — pinning hosts you don't control means an outage when their cert rotates

**Files:** New `ConvosCore/Sources/ConvosCore/Networking/CertificatePinner.swift`, wire into `ConvosAPIClient` URLSession config. Pin material lives in a checked-in `.plist` with SPKI hashes (hashes are public, not secret).

**Library:** Hand-rolled. Roughly 120 lines: a `URLSessionDelegate` that extracts the server's SPKI via `SecCertificateCopyKey` + `SecKeyCopyExternalRepresentation`, hashes with SHA-256, and compares against the pinned set. This gives clean control over the shadow→enforce rollout, Sentry reporting, and avoids depending on TrustKit (last meaningful release 2021).

**Acceptance:** Connections to `api.goldilocksdigital.xyz` succeed with current cert. MITM proxy (Charles with custom CA installed on device) fails to intercept. Pin rotation procedure documented in backend `SECURITY.md`. Sentry-only "report mode" lands first; enforce mode after a TestFlight cycle.

---

### 10. App-wide screenshot/screen-recording block (iOS)

**Problem:** Any screen in the app is screenshot- and screen-recording-visible. Goldilocks wants the entire app blocked, not just sensitive screens.

**Important constraint:** iOS does not provide a real "disable screenshots" API. The only technique that actually blocks both screenshots and screen recordings system-wide is the **secure text field trick**: wrap the app's root window in a `UITextField` with `isSecureTextEntry = true` and add the app's view hierarchy as a subview of the text field's hidden secure canvas. When secure entry is active, iOS blanks the view in screenshots and screen recordings at the compositor level. This is the technique banking apps (Robinhood, Wealthfront, Cash App) use.

**Change:**
1. Implement `SecureWindow` — a `UIWindow` subclass that hosts the app inside a hidden `UITextField` with `isSecureTextEntry = true`. Inject in `SceneDelegate` so the entire app is wrapped from launch.
2. Add `@Observable CaptureMonitor` listening to `UIScreen.capturedDidChangeNotification` and `userDidTakeScreenshotNotification` for telemetry: log to Sentry when a screenshot is attempted (the system still fires the notification even though the resulting image is blank) so we can see if users are trying.
3. Provide a debug-only build flag to disable the wrap so engineers can capture screenshots for bug reports during development.

**Caveats to document:**
- The trick relies on private layer behavior that has held since iOS 13 but is not formally guaranteed. Test thoroughly on each iOS version bump.
- Some accessibility tools may interact oddly with the secure-entry wrap; verify VoiceOver and Dynamic Type still work.
- AirPlay/external display mirroring is also blocked, which is desirable here but worth noting.

**Files:** New `Convos/Window/SecureWindow.swift`, modify `Convos/SceneDelegate.swift` to use it, new `Convos/Utilities/CaptureMonitor.swift`. Add `DEBUG_DISABLE_SECURE_WINDOW` build flag in `Dev.xcconfig`.

**Acceptance:** Screenshots taken from any screen produce a blank/black image. Screen recordings show black for the app's content while recording other apps normally. AirPlay mirroring shows black. Debug builds can still screenshot for bug reports. VoiceOver navigation works normally.

---

### 11. Token refresh lifecycle (both)

**Problem:** Neither codebase shows explicit short-lived access tokens + refresh rotation. If access tokens are long-lived, a leaked JWT is bad for hours or days.

**Change:**
- Backend: confirm `src/auth/jwt.ts` access-token TTL and shorten to ≤1h.
- Backend: add a new `refresh_tokens` table — separate from `sessions`, which keeps doing access-token JTI revocation. Columns: `id`, `family_id`, `parent_id`, `device_id`, `inbox_id`, `issued_at`, `expires_at` (~30 days), `revoked_at`, `used_at`. This shape supports proper rotation with theft detection (RFC 6819 §5.2.2.3): if a refresh token is used twice, the entire family is revoked because a replay means someone has an old copy.
- Backend: new `/v2/auth/refresh` endpoint that consumes a refresh token, issues a new access+refresh pair (rotation), marks the old refresh `used_at`, and on replay nukes the family.
- Backend: issue both tokens on SIWE login (`/v2/me`).
- iOS: confirm `ConvosAPIClient` handles 401 → refresh → retry once, with single-flight gate (an actor or a `Task` deduplication pattern) so concurrent requests during refresh don't trigger multiple refreshes.

**Files:** `src/auth/jwt.ts`, `src/middleware/jwt.ts`, `src/routes/auth.ts` (new `/v2/auth/refresh`), `src/db/schema.ts` (new `refresh_tokens` table), new migration. iOS: `ConvosCore/Sources/ConvosCore/Networking/ConvosAPIClient.swift`, session state machine, keychain storage for the refresh token (same access class as identity keys).

**Library:** Native — no new deps.

**Acceptance:** Access token expires after configured TTL. Client transparently refreshes on 401. Concurrent requests during refresh don't trigger multiple refreshes. Logout revokes the active refresh token server-side. Replay of a used refresh token is rejected and invalidates the family (verify with an integration test that simulates token theft).

---

## Out of scope (originally Phase 3)

**Item 12 — GRDB SQLCipher migration: dropped.** XMTP encrypts message content and `NSFileProtectionComplete` already covers the locked-device case. The remaining cleartext (metadata, drafts, cached profile fields) does not justify the 5–15% perf overhead, larger binary, more complex SPM setup, and migration risk. Revisit only if a future audit finds substantial sensitive plaintext in the local DB; the lighter-weight alternative is to AES-256-GCM individual sensitive columns using the existing `Profiles/` pattern.

---

## Tracking

Each phase opens its own Graphite stack. Suggested branch names:

- Phase 1: `security-p1-dockerfile`, `security-p1-pino-redact`, `security-p1-sentry-screenshot`, `security-p1-dependabot`, `security-p1-sops-exec`, `security-p1-hmac-encrypt`
- Phase 2: `security-p2-remove-appcheck`, `security-p2-rate-limits`, `security-p2-cert-pinning`, `security-p2-secure-window`, `security-p2-token-refresh`

Mark each PR description with the corresponding item number from this plan.

## Decisions locked

- **Item 7** — Path B: remove the Firebase App Check stub. Native App Attest deferred to a future plan, revisited after Items 8 and 11 ship and we have data on whether rate-limits alone are sufficient.
- **Item 9** — hand-rolled certificate pinning, no TrustKit.
- **Item 11** — new `refresh_tokens` table separate from `sessions`, with family-based theft detection.
- **Item 12** — dropped (see "Out of scope" above).

Pull `swift-architect` into Items 9 and 11 before implementation.
