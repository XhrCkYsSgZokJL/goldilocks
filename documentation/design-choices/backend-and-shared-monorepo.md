# Backend & Shared Monorepo

**Category:** Platform · **Primary strategy:** OWN (replays clean — ~64% of our delta)

## What

Goldilocks is a **monorepo**: the iOS app plus a Node/TypeScript **backend** (`backend/`) and a **shared** layer (`shared/`) that codegens types across the two. Upstream `convos-ios` is iOS-only. This is the single largest part of the Goldilocks delta — and the cheapest, because it's entirely **additive** (no upstream equivalent to reconcile).

## Why

Goldilocks needs server-side logic upstream doesn't have: our auth/accounts, roles, billing/credits, managed-channel provisioning, the backend agents (admins-agent, reports-agent), audit events, and observability. Co-locating the backend with the app and sharing types via codegen keeps the API contract honest (one source of truth → Swift + Zod/TS).

## Structure

| Path | Contents |
|------|----------|
| `backend/src/agent/` | Backend agents (admins-agent, reports-agent) + report-agent (Venice) plumbing |
| `backend/src/auth/` | SIWE / accounts / tokens (the backend side of [[auth-against-goldilocks-backend]]) |
| `backend/src/billing/` | Credits / subscriptions ([[goldilocks-billing-credits]]) |
| `backend/src/xmtp/`, `crypto/`, `storage/`, `db/` | Messaging, crypto, storage, persistence |
| `backend/src/observability/`, `audit-events.ts` | Server-side logging / audit |
| `backend/migrations/` | DB migrations |
| `shared/codegen/`, `shared/brand.json`, `shared/api-types.ts` | Type codegen + brand source of truth |

## The report-agent (Venice) — plumbing, not enabled

The backend has report-agent plumbing wired to **Venice** (not Claude) as the LLM, intentionally **disabled** (`REPORTS_LLM_ENABLED=false` default). It's scaffolding for a future "talk to an agent about your report results" feature — present so the wiring exists, off so nothing calls an LLM yet. See `backend/src/llm/venice.ts`, `backend/src/agent/report-assistant.ts`, `backend/src/config.ts`, `backend/.env.example`.

## Files affected

- **Owned, additive:** all of `backend/` (~130+ files: `src/` ~70, `migrations/` ~28, `scripts/` ~20, `dev/`), all of `shared/` (codegen, `brand.json`, `api-types.ts`), backend CI (`.github/`).
- These have **no upstream equivalent** — they bring over wholesale and never conflict.

## Markers

The `backend/` and `shared/` trees themselves; `REPORTS_LLM_ENABLED`, `venice`, `report-assistant`; codegen outputs consumed by `BrandConfig` and `ConvosAPIClient`.

## Upstream-sync guidance

- **Free at sync time.** Because upstream has no backend, nothing here ever conflicts with an upstream merge. A sync touches `backend/`/`shared/` only when *we* change them.
- **Codegen is the coupling point.** The one place backend meets app is shared types ([[auth-against-goldilocks-backend]], [[goldilocks-billing-credits]], [[branding]]). After changing a shared type, run `npm run codegen` and rebuild so the Swift/Zod sides stay aligned. Add `npm run codegen:check` to the sync gate.
- **Keep Venice disabled** until the product decision to enable it is made; don't let a refactor flip `REPORTS_LLM_ENABLED`.

## Related

[[auth-against-goldilocks-backend]] · [[goldilocks-billing-credits]] · [[roles-and-managed-groups]] (channel provisioning) · [[gated-agents]] (our agents) · [[branding]] (`brand.json`)
