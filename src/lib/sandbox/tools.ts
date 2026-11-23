// ============================================================================
// Sandbox tool loop: model -> tool_calls -> execute -> feed results -> repeat.
//
// Why a dedicated /api/sandbox/turn endpoint instead of reusing /api/chat:
// that route rebuilds the upstream payload from whitelisted fields and coerces
// every message role to user|assistant (see formatMessagesForOpenAI), which
// silently destroys assistant.tool_calls and role:'tool' results. Rewriting the
// text path to preserve them would have touched the code that every normal chat
// turn depends on, so this loop gets its own verbatim passthrough instead.
// ============================================================================
import { runShell } from './runner';
import { drainPreviewIssues, listDir, readTextFile, writeTextFile } from './container';
import { relPath, safePath } from './path';
import { clampRounds } from './mode';
import { ensureWorkspace } from './project';

export const MAX_TOOL_ROUNDS = 12;

type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export const SANDBOX_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a shell command in the sandbox. Returns exit code + output.',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string', description: 'Shell command run with `sh -c`. The working directory IS the workspace root, so use bare relative paths (src/app.js), never /workspace/src/app.js.' } },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from /workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace root, e.g. src/app.js (a leading /workspace/ is accepted).' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in /workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root, e.g. src/app.js (a leading /workspace/ is accepted).' },
          content: { type: 'string', description: 'Full file contents.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List a directory in /workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Defaults to /workspace.' } },
      },
    },
  },
];

// --- approval round trip -----------------------------------------------------
// The loop pauses on a promise; the panel resolves it from a click. Kept here so
// the loop never has to know about React.
type Pending = { resolve: (ok: boolean) => void };
const pendingApprovals = new Map<string, Pending>();
let approvalSink: ((request: { id: string; tool: string; detail: string }) => void) | null = null;

export function setApprovalSink(sink: typeof approvalSink): void {
  approvalSink = sink;
}

export function resolveApproval(id: string, ok: boolean): void {
  pendingApprovals.get(id)?.resolve(ok);
  pendingApprovals.delete(id);
}

function askApproval(tool: string, detail: string): Promise<boolean> {
  if (!approvalSink) {
    // No panel attached (e.g. panel closed mid-run): fail closed.
    return Promise.resolve(false);
  }
  const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(id, { resolve });
    approvalSink?.({ id, tool, detail });
  });
}

// --- tool execution ----------------------------------------------------------
export type ToolOutcome = { ok: boolean; output: string };

// Models drift on argument names even when the schema is explicit: `command` for `cmd`,
// `file_path` for `path`, `text` for `content`. Accepting the common aliases costs four
// lines and avoids a whole round of "the model got confused" retries.
function firstStr(args: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = args?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}
const commandOf = (args: Record<string, unknown>) => firstStr(args, ['cmd', 'command', 'script']);
const pathOf = (args: Record<string, unknown>) => firstStr(args, ['path', 'file_path', 'filepath', 'file']);
const contentOf = (args: Record<string, unknown>) =>
  firstStr(args, ['content', 'text', 'data', 'contents']);

function previewWrite(path: string, content: string): string {
  const head = content.split('\n').slice(0, 40).join('\n');
  return `write ${relPath(safePath(path))} (${content.length} chars)\n${head}${
    content.split('\n').length > 40 ? '\n…' : ''
  }`;
}

async function execute(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    if (name === 'shell') {
      const res = await runShell(commandOf(args));
      return { ok: res.exitCode === 0, output: `exit ${res.exitCode}\n${res.output}` };
    }
    if (name === 'read_file') {
      const text = await readTextFile(pathOf(args));
      return { ok: true, output: text.slice(0, 60_000) };
    }
    if (name === 'write_file') {
      const written = await writeTextFile(pathOf(args), contentOf(args));
      return { ok: true, output: `wrote ${written}` };
    }
    if (name === 'list_dir') {
      const entries = await listDir(pathOf(args) || '/workspace');
      return {
        ok: true,
        output: entries.map((e) => `${e.dir ? 'd' : '-'} ${relPath(e.path)}`).join('\n') || '(empty)',
      };
    }
    return { ok: false, output: `unknown tool: ${name}` };
  } catch (err) {
    return { ok: false, output: `error: ${String((err as Error)?.message ?? err)}` };
  }
}

// The jail lives here, once, for every write path — fs entry points are not
// reachable by any other route.
export async function runApprovedTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  return execute(name, args);
}

// --- loop -------------------------------------------------------------------
export type ChatTurn = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  /** Must round-trip: an assistant message that omits its own tool_calls makes the
   *  model re-issue the identical call forever (found by running a live loop). */
  tool_calls?: unknown[];
};

export type AgentEvent =
  | { kind: 'round'; round: number }
  | { kind: 'tool'; round: number; tool: string; detail: string; output: string; ok: boolean }
  | { kind: 'denied'; tool: string; detail: string }
  | { kind: 'text'; text: string }
  | { kind: 'log'; text: string }
  | { kind: 'error'; text: string };

const SYSTEM_PROMPT = [
  'You operate a real Node.js sandbox in the user\u2019s browser, rooted at /workspace.',
  'Use the tools to write files and run commands instead of describing them.',
  'Node.js only: no Python, no apt. Tests: `npm i -D vitest` then `npx vitest run`.',
  'Commands time out after 120s (300s for npm/npx installs) and output is capped at 100k chars. Keep steps small.',
  'Every shell command and file write needs the user\u2019s approval; expect rejections.',
  'Never read or exfiltrate credentials; you have no access to them, do not ask for them.',
  'Be concise in reasoning: decide, then act — call a tool in your first turn when the task needs one.',
'When the task is done, answer in prose without another tool call.',
].join('\n');

export type AgentRunOptions = {
  prompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Tool-call budget for this task; clamped to MIN/MAX_ROUNDS in mode.ts. */
  maxRounds?: number;
  /** Reports real usage once, so the transcript can say "7 of 12". */
  onStats?: (stats: { roundsUsed: number; roundsAllowed: number }) => void;
  /** 'length' + no tool_calls means the reasoning budget was too small. */
  finishReason?: string | null;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
};

type UpstreamToolCall = { id?: string; function?: { name?: string; arguments?: string } };

/** Raised for any failed turn; `status` lets the caller decide whether a retry is worth it. */
class RateLimited extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RateLimited';
  }
}

async function callModel(
  opts: AgentRunOptions,
  messages: ChatTurn[],
  signal?: AbortSignal,
): Promise<{
    content: string;
    tool_calls?: UpstreamToolCall[];
    finishReason?: string | null;
    reasoningContent?: string;
  }> {
  const res = await fetch('/api/sandbox/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    signal,
    body: JSON.stringify({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      maxTokens: opts.maxTokens,
      tools: SANDBOX_TOOLS,
      messages,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    finishReason?: string | null;
    reasoningContent?: string;
    message?: { content?: string; tool_calls?: UpstreamToolCall[] };
  };
  if (!res.ok || json.error) {
    throw new RateLimited(json.error || `sandbox turn failed (HTTP ${res.status})`, res.status);
  }
  return {
    content: json.message?.content ?? '',
    tool_calls: json.message?.tool_calls,
    finishReason: json.finishReason ?? null,
    reasoningContent: json.reasoningContent,
  };
}

export async function runAgentTurn(opts: AgentRunOptions): Promise<string> {
  // ensureWorkspace() is idempotent, and without this await a task typed during boot can
  // list a half-created workspace (seen live: list_dir returned empty, then package.json).
  await ensureWorkspace();

  const messages: ChatTurn[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const turn of opts.history.slice(-10)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: opts.prompt });

  // The ceiling used to be this module's constant. It is now the user's, inside
  // mode.ts's bounds, because the cost of a task is rounds x requests and free keys
  // meter requests, not usefulness.
  const rounds = clampRounds(opts.maxRounds ?? MAX_TOOL_ROUNDS);
  let roundsUsed = 0;
  let finalText = '';

  let revived = false;

  for (let round = 1; round <= rounds; round++) {
    roundsUsed = round;
    if (opts.signal?.aborted) {
      opts.emit({ kind: 'log', text: 'stopped' });
      break;
    }
    // Anything the running preview complained about since the last round goes to the model
    // with the next request. This is the only way it learns its own page is broken: the
    // command exited 0 and the HTML rendered, yet `boom is not defined` is fatal.
    if (round > 1) {
      const issues = drainPreviewIssues();
      if (issues.length > 0) {
        const note = `The running preview reported these problems:\n${issues
          .map((line) => `- ${line}`)
          .join('\n')}\nFix them if you can instead of just reporting them.`;
        opts.emit({ kind: 'log', text: `preview reported ${issues.length} problem(s)` });
        const last = messages[messages.length - 1];
        if (last && last.role === 'tool') {
          last.content = `${last.content}\n\n${note}`;
        } else {
          messages.push({ role: 'user', content: note });
        }
      }
    }

    opts.emit({ kind: 'round', round });

    let answer: {
      content: string;
      tool_calls?: UpstreamToolCall[];
      finishReason?: string | null;
      reasoningContent?: string;
    };
    try {
      try {
        answer = await callModel(opts, messages, opts.signal);
      } catch (firstErr) {
        // One automatic retry for a throttled turn: free tiers cap at a few requests per
        // minute, and a 12s pause is the difference between "the agent works" and a red box.
        const status = (firstErr as RateLimited)?.status;
        const firstMsg = String((firstErr as Error)?.message ?? '');
        // A refusal is not a throttle — retrying "provider refused" only burns a round.
        const permanent = /provider refused/i.test(firstMsg);
        if (
          !permanent &&
          (status === 429 || status === 504 || /rate limit|timed out/i.test(firstMsg))
        ) {
          opts.emit({ kind: 'log', text: 'provider throttled this turn — waiting 12s and retrying once' });
          await new Promise((r) => setTimeout(r, 12_000));
          if (opts.signal?.aborted) throw firstErr;
          answer = await callModel(opts, messages, opts.signal);
        } else {
          throw firstErr;
        }
      }
    } catch (err) {
      const text = String((err as Error)?.message ?? err);
      opts.emit({ kind: 'error', text });
      if (round === 1) {
        throw err;
      }
      break;
    }

    const calls = Array.isArray(answer.tool_calls) ? answer.tool_calls.slice(0, 8) : [];

    // Round-trip the assistant turn with its tool_calls attached: an assistant message
    // that omits them makes the model re-issue the identical call every round.
    messages.push({
      role: 'assistant',
      content: answer.content,
      ...(calls.length ? { tool_calls: calls } : {}),
    });

    if (answer.content.trim()) {
      opts.emit({ kind: 'text', text: answer.content });
      finalText = answer.content;
    } else if (answer.reasoningContent?.trim()) {
      // A blank final message is the single most confusing failure this app can have;
      // showing the tail of its reasoning tells the user to raise max tokens.
      opts.emit({
        kind: 'log',
        text: `no final answer; last reasoning: ${answer.reasoningContent.slice(-400).trim()}`,
      });
    }

    if (calls.length === 0) {
      // An empty turn is not a finished turn. Reasoning models can exhaust
      // max_tokens before emitting anything, and providers that don't support
      // tools return prose-shaped emptiness — surfacing it beats exiting quietly.
      if (!answer.content.trim()) {
        const why =
          answer.finishReason === 'length'
            ? `ran out of tokens (finish_reason=length) — raise max tokens`
            : `returned no content and no tool calls${answer.finishReason ? ` (finish_reason=${answer.finishReason})` : ''}`;
        opts.emit({ kind: 'error', text: `Model ${why}. The turn was not completed.` });
      }
      // A preview can report a fatal error a beat AFTER the model already decided it was
      // done — the iframe has to load first. Give it exactly one revival, so "looks fine"
      // cannot survive a `boom is not defined` that only shows up once the page runs.
      const late = drainPreviewIssues();
      if (late.length > 0 && !revived && round < rounds) {
        revived = true;
        opts.emit({
          kind: 'log',
          text: `preview reported ${late.length} problem(s) after the answer — one more round to fix them`,
        });
        messages.push({
          role: 'user',
          content: `The running preview reported these problems:\n${late
            .map((line) => `- ${line}`)
            .join('\n')}\nFix them now if you can, then tell me what changed.`,
        });
        continue;
      }
      break;
    }

    for (const call of calls) {
      const name = String(call?.function?.name ?? '');
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(call?.function?.arguments ?? '{}'));
      } catch {
        const note = 'invalid JSON in tool arguments';
        opts.emit({ kind: 'tool', round, tool: name, detail: note, output: note, ok: false });
        messages.push({ role: 'tool', content: note, tool_call_id: call?.id });
        continue;
      }

      const destructive = name === 'shell' || name === 'write_file';
      if (destructive) {
        const detail =
          name === 'shell'
            ? `shell: ${commandOf(args)}`
            : previewWrite(pathOf(args), contentOf(args));
        const okToRun = await askApproval(name, detail);
        if (!okToRun) {
          opts.emit({ kind: 'denied', tool: name, detail });
          messages.push({
            role: 'tool',
            content: 'The user rejected this command. Do not retry it unchanged; pick another approach or explain.',
            tool_call_id: call?.id,
          });
          continue;
        }
      }

      const result = await execute(name, args);
      opts.emit({
        kind: 'tool',
        round,
        tool: name,
        detail: name === 'shell' ? String(args.cmd ?? '') : relPath(safePath(String(args.path ?? '/workspace'))),
        output: result.output.slice(0, 8000),
        ok: result.ok,
      });
      messages.push({ role: 'tool', content: result.output.slice(0, 60_000), tool_call_id: call?.id });
    }

    if (round === rounds) {
      const note = `Stopping: ${rounds}-tool-call limit reached`;
      opts.emit({ kind: 'log', text: note });
      finalText = finalText ? `${finalText}\n\n_${note}_` : note;
    }
  }

  opts.onStats?.({ roundsUsed, roundsAllowed: rounds });
  if (roundsUsed < rounds) {
    opts.emit({ kind: 'log', text: `used ${roundsUsed} of ${rounds} tool calls` });
  }

  return finalText;
}
