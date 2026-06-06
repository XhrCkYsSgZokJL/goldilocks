# Report-Answering Agent — Venice LLM wiring (spike)

_Status: **plumbing only, disabled by default.** No live LLM calls. This doc + the inert modules it references give us the seam; flipping `REPORTS_LLM_ENABLED=true` (with a key configured) is a separate, deliberate decision._

## Goal

Let a client write a question into their feed and get a grounded answer about **their own report results** — "what changed since last month?", "what does this finding mean?" — from a server-owned agent the operator controls. Today `ReportsAgent.handleIncomingMessage` posts a canned _"no one is monitoring this channel"_ reply. This spike adds the machinery to replace that with an LLM-generated answer, **without turning it on**.

## Why Venice (not Claude/OpenAI)

[Venice](https://venice.ai) is a privacy-first, **zero-retention** inference API. For a security concierge that would be sending fragments of a client's report into a third-party model, "the provider does not store prompts or completions" is the deciding property. Venice is **OpenAI-compatible**, so the client is a thin wrapper:

- Base URL: `https://api.venice.ai/api/v1`
- Endpoint: `POST /chat/completions`
- Auth: `Authorization: Bearer $VENICE_API_KEY`
- Body: standard `{ model, messages }` plus a `venice_parameters` extension (we set `enable_web_search: "off"` and `strip_thinking_response: true` — no web egress, no chain-of-thought leakage into the chat).

Model id is configurable (`VENICE_MODEL`); we don't hard-code one because Venice's catalogue rotates. List options via `GET /api/v1/models`.

## Architecture (where it lives)

We already own the substrate. No upstream iOS agent code is involved.

```
client writes into Reports/Advisory group (XMTP)
   │
   ▼
ReportsAgent.startAutoResponder  ──► handleIncomingMessage(message)
   │
   ├─ REPORTS_LLM_ENABLED == false  (DEFAULT)
   │     └─► canned auto-reply  ← exactly today's behavior
   │
   └─ REPORTS_LLM_ENABLED == true AND Venice configured
         │
         ├─ gatherReportContext(clientId)        ── src/agent/report-assistant.ts
         │     • recent messages in the client's Reports group (agent is a member)
         │     • report_jobs rows for the client (payload jsonb)
         │     • [future] extracted text from posted PDF reports
         │
         ├─ buildReportPrompt(context, question)  ── system + user messages
         │
         ├─ veniceChat(messages)                  ── src/llm/venice.ts (OpenAI-compatible)
         │
         └─ group.sendText(answer)
```

New modules (all inert until the flag flips):

| File | Responsibility |
|------|----------------|
| `backend/src/llm/venice.ts` | OpenAI-compatible Venice chat client. `isVeniceConfigured()`, `veniceChat()`. Timeout + AbortController, typed errors, no retries-with-backoff yet. Pure — does nothing unless called. |
| `backend/src/agent/report-assistant.ts` | `gatherReportContext(clientId)`, `buildReportPrompt()`, `generateReportReply()`. Composes retrieval → prompt → `veniceChat`. Returns `null` when disabled/unconfigured so the caller falls back to the canned reply. |
| `config.ts` additions | `VENICE_API_KEY?`, `VENICE_BASE_URL`, `VENICE_MODEL`, `VENICE_TIMEOUT_MS`, `REPORTS_LLM_ENABLED=false`. All optional; feature off by default. |

The only edit to live code is a **behavior-preserving** gated branch in `reports-agent.ts`:

```ts
// in handleIncomingMessage, after the channel lookup + cooldown:
const llmReply = await generateReportReply({
  clientId: channel.clientId,
  clientNumber: channel.clientNumber,
  question: message.content ?? '',
  group,
});
// generateReportReply returns null when REPORTS_LLM_ENABLED is false
// or Venice isn't configured → we post the canned reply, unchanged.
await group.sendText(llmReply ?? REPORTS_AUTO_REPLY);
```

With the flag off (default) `generateReportReply` short-circuits to `null` before any retrieval or network call, so the runtime is identical to today.

## Report retrieval (context grounding)

Reports are delivered as **encrypted PDFs** dropped into `REPORTS_DIR` (see `reports-watcher.ts`), optionally paired with a `.txt` preamble, and posted into the client's `Back Office #N` group. The scheduled `report_jobs` queue (jsonb `payload`) exists but isn't wired yet.

So the text actually available to ground an answer, in priority order:

1. **Recent messages in the client's Reports group** — the agent is a member and can read them. This includes the `.txt` preambles and report titles already posted. Cheapest, already structured as conversation.
2. **`report_jobs.payload`** for `clientId` — structured report data once the scheduled-report loop lands.
3. **[Future] PDF text extraction** — the richest source, but PDFs are binary + encrypted. Out of scope for the spike; flagged as a TODO in `report-assistant.ts`. When added, extract at post time and cache the text alongside the job, so the agent never re-decrypts PDFs at question time.

`gatherReportContext` caps total context size (token budget) and **redacts nothing automatically** — see privacy below.

## Prompt shape

- **System:** role ("You are the Goldilocks Digital back-office assistant"), scope ("answer only from the client's report material below; if the answer isn't in the material, say so and offer to escalate to a human advisor"), tone, and a hard instruction not to invent findings.
- **User:** the client's question + the assembled context block, clearly delimited.
- `venice_parameters: { enable_web_search: "off", strip_thinking_response: true }`.
- Low temperature; cap `max_tokens`.

## Privacy & safety (security-product constraints)

- **Zero-retention provider** is the baseline requirement; Venice qualifies. Re-confirm in their DPA before enabling.
- **Data minimization:** send the smallest context that answers the question. Never send other clients' data — `gatherReportContext` is hard-scoped to one `clientId`.
- **No web egress:** `enable_web_search: "off"` so the client's report fragments never trigger an outbound search.
- **Opt-in, per-deployment:** gated behind `REPORTS_LLM_ENABLED` (default false) **and** a configured key. A deployment that never sets the key can never make a call.
- **Auditability:** every LLM reply should emit an ops event (`agent.report_llm.replied`) with client number + token usage (not content) so operators can see when the agent answered. (Wire when enabling.)
- **Human-escalation fallback:** the prompt instructs the model to defer to a human advisor when unsure; the Advisory channel (`adminsAgent.sendAdvisoryMessage`) already exists for that handoff.
- **Channel question (decide before enabling):** Reports is framed as a one-way feed. Either (a) relax that for Reports, or (b) — recommended — answer in a dedicated **Advisory/Ask** conversational group so the notification feed stays clean. The plumbing hooks Reports for now because that's where `handleIncomingMessage` already runs; moving it to a new group is a small follow-up.

## Failure modes

- Venice unreachable / 5xx / timeout → `veniceChat` throws; `generateReportReply` catches, logs, returns `null` → canned reply. The client never sees an error wall.
- Empty/again-too-soon (cooldown) → existing `AUTO_REPLY_COOLDOWN_MS` logic still applies before we call the model, so a burst can't fan out into many paid calls.
- Oversized context → truncated to the token budget in `gatherReportContext`.

## Cost

One completion per client question, rate-limited by the existing per-group cooldown. Token usage is returned in the Venice response (`usage`) and should be logged for monitoring. No background/polling cost — the agent only calls the model in direct response to a client message.

## What this spike delivers vs. defers

**Delivers now (inert):** config vars, the Venice client, the report-assistant module, the behavior-preserving gated hook, and a unit test for the client's request-shaping + config gating (no network).

**Defers (do when enabling):** PDF text extraction, the ops-event audit line, the dedicated Advisory/Ask channel, retry/backoff policy, and a real model choice after evaluating Venice's catalogue.

## Enabling later (checklist)

1. Confirm Venice DPA / zero-retention terms for the deployment.
2. Set `VENICE_API_KEY`, choose `VENICE_MODEL` (after `GET /models`).
3. Decide the channel (Advisory/Ask vs. Reports) and move the hook if needed.
4. Add the audit ops-event + token logging.
5. Flip `REPORTS_LLM_ENABLED=true` in a staging deployment; test with a seeded client + report.
6. Review answers for grounding/hallucination before production.
