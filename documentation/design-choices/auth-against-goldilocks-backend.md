# Auth Against Goldilocks Backend

**Category:** Product/Security · **Primary strategy:** REPLACE-EXTEND (don't adopt upstream SIWE)

## What

Goldilocks authenticates against **our backend**, not upstream's. The API client targets Goldilocks endpoints, uses our SIWE (Sign-In With Ethereum) flow and account model, carries a **refresh-token** chain, and pins certs. Upstream has since grown its own SIWE — we must **keep ours** and not let a merge silently adopt theirs.

## Why

Goldilocks has its own backend (`backend/`) with its own auth, accounts, roles, billing, and agent provisioning. The app must talk to it. Auth is also security-sensitive (cert pinning, token lifecycle), so it's reconciled with the same care as [Identity recovery & hardening](identity-recovery-and-hardening.md).

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks |
|--------|----------|------------|
| Backend | Convos backend | Goldilocks `backend/` |
| SIWE | upstream's | ours (against our backend) |
| Token model | JWT | JWT + **refresh-token** chain (`refreshToken(deviceId:)`) |
| Account keys | `siweJwt` / `siweAccountId` | same keychain accounts **plus** our refresh slot |
| Transport | — | cert pinning |
| App Check | Firebase | removed (see [No telemetry / no-egress](no-telemetry-no-egress.md)) |

## Files affected

### Extended (REPLACE-EXTEND)
- `ConvosCore/Sources/ConvosCore/API/ConvosAPIClient.swift` — Goldilocks endpoints, SIWE-against-our-backend, cert pinning, `reAuthenticate` (no Firebase App Check), refresh-token retry. **The crux.**
- `ConvosCore/Sources/ConvosCore/API/ConvosAPIClient+Models.swift` — our request/response models (e.g. `InviteCodeStatus`, redeem responses).
- `ConvosCore/Sources/ConvosCore/API/MockAPIClient.swift` — mock parity.
- `ConvosCore/Sources/ConvosCore/Shared/ConvosKeychainItem.swift` — union of upstream `siweJwt`/`siweAccountId` accounts **and** our `refreshToken` account.
- `Convos/Config/config.{local,dev,prod}.json` — backend URLs, SIWE domains, and `xmtpNetwork`. **`"xmtpNetwork": "local"` in `config.local.json` is load-bearing**: the local backend validates SIWE registration against the local node's inbox ledger, so a Local build on any other XMTP network gets `address_not_bound` 401s and never provisions channels (upstream's value is `"dev"` — a merge regression waiting to happen; `ConvosApp` logs a config-drift error at launch if it recurs).
- `Convos/Config/*.xcconfig`, `ConfigManager` overrides — Goldilocks API base URL, gateway, XMTP host.

## Markers

`ConvosAPIClient`, `refreshToken(deviceId:)`, `siweJwt` / `siweAccountId` (kept) + `refreshToken` (ours), `reAuthenticate`, cert-pinning config, `CONVOS_API_BASE_URL` / `GATEWAY_URL` overrides.

## Upstream-sync guidance

- **Keep ours; don't adopt upstream's SIWE by accident.** When upstream refactors its API client or SIWE, re-apply our endpoints + refresh-token chain + cert pinning on top. A 3-way diff that "cleanly" takes upstream's auth is a regression — verify the endpoints still point at the Goldilocks backend.
- **`ConvosKeychainItem` is a union** — preserve both upstream's SIWE accounts and our refresh-token account; a take-ours or take-upstream resolution drops one set.
- **No Firebase App Check** — `reAuthenticate` must not reintroduce it (see [No telemetry / no-egress](no-telemetry-no-egress.md)).
- Endpoints the app calls but the backend doesn't implement yet should `throw APIError.notImplementedInGoldilocks` rather than hit a missing route.
- Keep request/response models in sync with the backend via shared codegen ([Backend & shared monorepo](backend-and-shared-monorepo.md)).

## Related

[Identity recovery & hardening](identity-recovery-and-hardening.md) (cert pinning, keychain) · [Backend & shared monorepo](backend-and-shared-monorepo.md) · [Goldilocks billing & credits](goldilocks-billing-credits.md) · [No telemetry / no-egress](no-telemetry-no-egress.md)
