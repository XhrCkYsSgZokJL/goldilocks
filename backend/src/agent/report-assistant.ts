// Report-answering assistant.
//
// Composes report-context retrieval → prompt → Venice completion into a
// single `generateReportReply()` the reports-agent can call when a client
// asks a question in their feed.
//
// Disabled by default: `generateReportReply` returns null unless
// REPORTS_LLM_ENABLED is true AND Venice is configured, so the reports-agent
// falls back to its canned auto-reply and runtime behavior is unchanged.
// See docs/plans/report-agent-llm-venice.md.

import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reportJobs } from '../db/schema.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { isVeniceConfigured, veniceChat, type ChatMessage } from '../llm/venice.js';

const log = logger.child({ module: 'report-assistant' });

// How many recent report jobs to fold into the context, and a rough cap on
// the assembled context length (characters) so we never send an unbounded
// blob to the model.
const MAX_REPORT_JOBS = 8;
const MAX_CONTEXT_CHARS = 8_000;

export interface ReportReplyInput {
  clientId: string;
  clientNumber: number;
  /** The text the client wrote into their feed. */
  question: string;
}

/**
 * Generate a grounded answer to a client's question about their reports, or
 * null when the feature is off / unconfigured / fails — in which case the
 * caller posts the canned reply. Never throws.
 *
 * Short-circuits before any retrieval or network call when disabled, so with
 * the default config this is effectively a no-op that returns null.
 */
export async function generateReportReply(input: ReportReplyInput): Promise<string | null> {
  if (!config.REPORTS_LLM_ENABLED) return null;
  if (!isVeniceConfigured()) {
    log.warn('REPORTS_LLM_ENABLED is true but Venice is not configured — falling back to canned reply');
    return null;
  }

  try {
    const context = await gatherReportContext(input.clientId);
    const messages = buildReportPrompt(input.clientNumber, input.question, context);
    const result = await veniceChat(messages);
    log.info(
      { clientNumber: input.clientNumber, totalTokens: result.usage?.totalTokens ?? null },
      'generated report reply',
    );
    return result.text;
  } catch (err) {
    log.warn({ clientNumber: input.clientNumber, err: (err as Error).message }, 'report reply failed; using canned reply');
    return null;
  }
}

/**
 * Assemble the grounding context for one client. Hard-scoped to a single
 * clientId — never reads another client's data.
 *
 * Current source: the client's `report_jobs.payload` rows (newest first).
 * TODO when enabling (see design doc): also fold in recent messages from the
 * client's Reports group (the agent is a member) and extracted text from
 * posted PDF reports. Both are deferred so the spike stays inert + buildable.
 */
async function gatherReportContext(clientId: string): Promise<string> {
  const jobs = await db
    .select({ payload: reportJobs.payload, scheduledAt: reportJobs.scheduledAt, status: reportJobs.status })
    .from(reportJobs)
    .where(eq(reportJobs.clientId, clientId))
    .orderBy(desc(reportJobs.scheduledAt))
    .limit(MAX_REPORT_JOBS);

  if (jobs.length === 0) {
    return 'No report material is on file for this client yet.';
  }

  const blocks = jobs.map((job, i) => {
    const when = job.scheduledAt instanceof Date ? job.scheduledAt.toISOString() : String(job.scheduledAt);
    return `Report ${i + 1} (${when}, status=${job.status}):\n${JSON.stringify(job.payload)}`;
  });

  const assembled = blocks.join('\n\n');
  return assembled.length > MAX_CONTEXT_CHARS
    ? `${assembled.slice(0, MAX_CONTEXT_CHARS)}\n…[truncated]`
    : assembled;
}

/**
 * Build the system + user messages. The system prompt hard-constrains the
 * model to answer only from the supplied material and to defer to a human
 * advisor when the answer isn't present.
 */
function buildReportPrompt(clientNumber: number, question: string, context: string): ChatMessage[] {
  const system = [
    'You are the Goldilocks Digital back-office assistant.',
    `You are answering a question from client #${clientNumber} about their own report results.`,
    'Answer only using the report material provided below. Do not invent findings, figures, or recommendations.',
    "If the answer is not in the material, say so plainly and offer to escalate to a human advisor.",
    'Be concise and factual.',
  ].join(' ');

  const user = `Client question:\n${question.trim()}\n\n---\nReport material:\n${context}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
