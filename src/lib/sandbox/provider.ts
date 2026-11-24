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
  signal?: AbortSignal;
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

export async function callModel(request: ProviderTurnRequest): Promise<ProviderTurnAnswer> {
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
