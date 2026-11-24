// ============================================================================
// One model turn, through this app's own proxy.
//
// Why the server and not the provider directly: the API key must not be used from
// a page the user may have open on a shared machine with a permissive CORS
// endpoint, and `/api/sandbox/turn` already forwards `tools` / `tool_calls`
// verbatim (the plain chat route does not — it coerces roles, which destroys
// assistant.tool_calls and role:'tool' results).
//
// This module is deliberately thin: it owns the wire shape and the error text, and
// nothing about the agent's behaviour.
// ============================================================================

export type ToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};

export type ProviderTurnRequest = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ type: 'function'; function: unknown }>;
  maxTokens?: number;
  /**
   * Ask for several tool calls in ONE response instead of one per round: five file
   * writes become one request instead of five. Sent explicitly because gateways differ
   * on the default; the server drops it and retries if a provider rejects the field.
   */
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
  /** Called for every streamed delta so the panel can render tokens as they arrive. */
  onDelta?: (delta: { text?: string; reasoning?: string; toolName?: string }) => void;
  /** Server-side remarks that are not part of the answer (e.g. a dropped parameter). */
  onNote?: (note: string) => void;
};

export type ProviderTurnAnswer = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  reasoning?: string;
  usage?: {
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    [key: string]: unknown;
  } | null;
};

/**
 * Was the budget spent on thinking rather than on an answer? Measured on real
 * providers: a reasoning model given a generous max_tokens can emit 30k of
 * reasoning, zero content and no tool call, and `finish_reason` stays "stop". The
 * loop has to recognise that, because retrying the same request unchanged produces
 * the same nothing.
 */
export function reasoningOnly(answer: ProviderTurnAnswer): boolean {
  if (answer.content.trim() || answer.toolCalls.length > 0) {
    return false;
  }
  const completion = Number(answer.usage?.completion_tokens ?? 0);
  const reasoning = Number(answer.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
  return Boolean(answer.reasoning?.trim()) || reasoning > 0 || completion > 0;
}

/**
 * Streamed turn. Falls back to the blocking route when streaming is unavailable
 * (an old proxy, a provider that ignores `stream: true`, a failed EventSource-shaped
 * fetch) so a workspace keeps working instead of failing on a capability.
 */
export async function callModel(request: ProviderTurnRequest): Promise<ProviderTurnAnswer> {
  try {
    return await callModelStreamed(request);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw error;
    }
    request.onDelta?.({ reasoning: `(stream unavailable, retrying without it: ${String((error as Error)?.message ?? error)})` });
    return await callModelBlocking(request);
  }
}

/** Consume `data: {...}` frames as they arrive instead of waiting for the whole body. */
async function callModelStreamed(request: ProviderTurnRequest): Promise<ProviderTurnAnswer> {
  const response = await fetch('/api/sandbox/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      baseUrl: request.baseUrl,
      apiKey: request.apiKey,
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      toolChoice: 'auto',
      parallelToolCalls: request.parallelToolCalls !== false,
      ...(Number(request.maxTokens) > 0 ? { maxTokens: Math.round(Number(request.maxTokens)) } : {}),
    }),
    signal: request.signal,
  });

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `streaming endpoint answered ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer: ProviderTurnAnswer | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (!payload) {
          continue;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type === 'text') {
          request.onDelta?.({ text: String(event.text ?? '') });
        } else if (event.type === 'reasoning') {
          request.onDelta?.({ reasoning: String(event.text ?? '') });
        } else if (event.type === 'tool_delta') {
          request.onDelta?.({ toolName: String(event.name ?? '') });
        } else if (event.type === 'note') {
          request.onNote?.(String(event.text ?? ''));
        } else if (event.type === 'error') {
          throw new Error(String(event.error ?? 'provider error'));
        } else if (event.type === 'done') {
          answer = {
            content: String(event.content ?? ''),
            toolCalls: (Array.isArray(event.toolCalls) ? event.toolCalls : []) as ToolCall[],
            finishReason: (event.finishReason as string | null) ?? null,
            reasoning: typeof event.reasoning === 'string' ? event.reasoning : undefined,
            usage: (event.usage ?? null) as ProviderTurnAnswer['usage'],
          };
        }
      }
    }
  }

  if (!answer) {
    throw new Error('the streaming endpoint closed without a done event');
  }
  return answer;
}

async function callModelBlocking(request: ProviderTurnRequest): Promise<ProviderTurnAnswer> {
  const response = await fetch('/api/sandbox/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: request.baseUrl,
      apiKey: request.apiKey,
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      toolChoice: 'auto',
      parallelToolCalls: request.parallelToolCalls !== false,
      ...(Number(request.maxTokens) > 0 ? { maxTokens: Math.round(Number(request.maxTokens)) } : {}),
    }),
    signal: request.signal,
  });

  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    ok?: boolean;
    message?: { content?: string; tool_calls?: ToolCall[] };
    finishReason?: string | null;
    reasoningContent?: string;
    usage?: unknown;
  };

  if (!response.ok || body.ok === false) {
    const detail = body.error || `the provider answered ${response.status}`;
    throw new Error(detail);
  }

  const message = body.message;
  if (!message) {
    throw new Error('the provider returned no assistant message');
  }

  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    finishReason: body.finishReason ?? null,
    reasoning: body.reasoningContent,
    usage: (body.usage ?? null) as ProviderTurnAnswer['usage'],
  };
}
