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
  usage?: unknown;
};

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
    usage: body.usage,
  };
}
