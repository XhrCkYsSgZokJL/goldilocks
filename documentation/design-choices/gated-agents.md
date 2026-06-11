# Gated Agents

**Category:** Product · **Primary strategy:** GATE (keep upstream, hide entry) — **not** adopt

## What

Upstream's **Agents** product — the Agents tab, the agent-builder (compose / voice-memo authoring), agent-templates, and agent-contacts — is **gated**, not adopted. Goldilocks instead uses its own **backend-provisioned agents** (admins-agent, reports-agent) that appear as members of [managed channels](roles-and-managed-groups.md). Agent-facing UI like "Files & Links" (`AgentFilesLinksView`) is kept because Goldilocks' own agents share files; the *authoring/marketplace* surfaces are gated.

## Why

Goldilocks doesn't want users building or browsing arbitrary agents — its agents are curated and server-side. But upstream's agent code is large and interwoven; **gating (hide the entry points, keep the files) is far cheaper than excising it** and keeps upstream's files mergeable. We adopt upstream's *agent-aware data/UI primitives* (verified-agent flags, files/links, pending-agent avatar) because our own agents use them.

## Upstream vs Goldilocks

| Aspect | Upstream | Goldilocks |
|--------|----------|------------|
| Agents tab | in `MainTabView` | no tab (shell dropped — see [App shell: direct root](app-shell-direct-root.md)) |
| Agent builder | composer + voice-memo authoring | gated (not surfaced) |
| Agent templates / agent-contacts | browse + spawn | gated |
| Source of agents | user-built / marketplace | backend (admins-agent, reports-agent) |
| Agent-aware primitives (verified flag, files/links, pending avatar) | used | **adopted** (our agents use them) |

## Files affected

### Gated (kept, entry points not surfaced)
- The agent-builder cluster (`Convos/Agent Builder/*`, `AgentBuilderBar`, `AgentBuilderViewModel`) — compiles; reachable only from the dropped tab shell / unsurfaced entry points.
- Agent-templates + agent-contacts UI — kept, not surfaced.

### Adopted (we use these upstream primitives)
- `Convos/Conversation Detail/AgentFilesLinksView.swift`, `AgentFilesLinksNavigatorImpl.swift` + `ConvosCore/.../Storage/Repositories/AgentFilesLinksRepository.swift` — "Files & Links" for our agents (replaced our older `AssistantFilesLinks*`).
- `Conversation.hasEverHadVerifiedConvosAgent`, `ConversationAvatarType.pendingAgent` (+ `PendingAgentAvatarView`) — agent-aware rendering.
- `GoldilocksAgentTrust` auto-allow for our agents (see [Roles & managed groups](roles-and-managed-groups.md)).

### Owned (our backend agents)
- `backend/src/agent/*` — admins-agent, reports-agent, and the report-agent (Venice) plumbing (see [Backend & shared monorepo](backend-and-shared-monorepo.md)).

## Markers

`AgentBuilder*` (gated), `AgentFilesLinks*` (adopted), `hasEverHadVerifiedConvosAgent`, `pendingAgent` / `PendingAgentAvatarView`, `GoldilocksAgentTrust`, `requestAgentJoins`, `presentAgentBuilder`.

## Upstream-sync guidance

- **Gate at the entry point, keep the files.** Take upstream's agent-builder/template/contacts files (TAKE-UPSTREAM) and ensure they're simply not surfaced in our [app shell](app-shell-direct-root.md). Don't excise them — that's a permanent tax.
- **Keep adopting agent-aware primitives** — when upstream improves verified-agent rendering, files/links, or agent avatars, take it; our agents benefit.
- **Verify gated agent code is inert** — it must not call an absent agent-pool endpoint at launch.
- **Our backend agents are the real agents** — keep `backend/src/agent/` and the channel-provisioning flow as the source of truth.
- The report-agent LLM (Venice) is **plumbing only, not enabled** (`REPORTS_LLM_ENABLED=false`). See [Backend & shared monorepo](backend-and-shared-monorepo.md).

## Related

[App shell: direct root](app-shell-direct-root.md) (no Agents tab) · [Roles & managed groups](roles-and-managed-groups.md) (our agents provision channels) · [Backend & shared monorepo](backend-and-shared-monorepo.md) (report-agent / Venice) · [Cloud Connections gated](cloud-connections-gated.md)
