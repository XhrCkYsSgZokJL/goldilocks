// Venice LLM client.
//
// Thin wrapper over Venice's OpenAI-compatible chat-completions API
// (https://venice.ai). Venice is privacy-first and zero-retention — chosen
// so client report fragments are not stored by the provider. See
// docs/plans/report-agent-llm-venice.md.
//
// This module is pure: it makes no network calls and has no side effects
// unless `veniceChat()` is invoked. The report-answering feature that calls
// it is gated behind REPORTS_LLM_ENABLED (default false), so importing this
// file does nothing on its own.

import { config } from '../config.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ module: 'venice' });

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface VeniceChatOptions {
  /** Sampling temperature. Low by default for grounded, factual answers. */
  temperature?: number;
  /** Hard cap on completion length. */
  maxTokens?: number;
  /** Per-call timeout override (ms). Falls back to VENICE_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface VeniceUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface VeniceChatResult {
  text: string;
  usage: VeniceUsage | null;
  model: string;
}

/** Thrown for any Venice call failure (config, transport, or API error). */
export class VeniceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'VeniceError';
  }
}

/**
 * True only when a key and a model are both set. The feature flag
 * (REPORTS_LLM_ENABLED) is checked separately by the caller — a deployment
 * that never sets a key can never make a call regardless of the flag.
 */
export function isVeniceConfigured(): boolean {
  return Boolean(config.VENICE_API_KEY && config.VENICE_MODEL);
}

interface VeniceCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * Send a chat completion to Venice and return the assistant's text.
 *
 * `venice_parameters` pins privacy-relevant behavior: no web search (client
 * report fragments never trigger outbound egress) and thinking stripped from
 * the response so chain-of-thought can't leak into a chat message.
 *
 * Throws VeniceError on misconfiguration, timeout, or a non-2xx response.
 * Callers in the agent path catch this and fall back to the canned reply.
 */
export async function veniceChat(
  messages: ChatMessage[],
  options: VeniceChatOptions = {},
): Promise<VeniceChatResult> {
  if (!isVeniceConfigured()) {
    throw new VeniceError('Venice is not configured (VENICE_API_KEY / VENICE_MODEL unset)');
  }

  const model = config.VENICE_MODEL as string;
  const timeoutMs = options.timeoutMs ?? config.VENICE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.VENICE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.VENICE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 600,
        venice_parameters: {
          enable_web_search: 'off',
          strip_thinking_response: true,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new VeniceError(
        `Venice returned ${response.status}: ${body.slice(0, 200)}`,
        response.status,
      );
    }

    const data = (await response.json()) as VeniceCompletionResponse;
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) {
      throw new VeniceError('Venice returned an empty completion');
    }

    const usage: VeniceUsage | null = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : null;

    return { text, usage, model: data.model ?? model };
  } catch (err) {
    if (err instanceof VeniceError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new VeniceError(`Venice request timed out after ${timeoutMs}ms`);
    }
    throw new VeniceError(`Venice request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
