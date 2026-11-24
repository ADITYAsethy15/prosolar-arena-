// ============================================================================
// The agent loop: model -> tools -> model, with a completion gate.
//
// What changed from this app's previous loop (a bare "call tools up to N times"):
// the model no longer decides on its own that it is finished. Ported from
// bolt.diy's app/lib/common/agentLoop.ts + app/lib/.server/llm/agent-loop.ts, the
// loop keeps a *progress record* of what actually happened — plan recorded, files
// edited, command run, checks passing after the last edit, preview up — and turns
// "I'm done" into a question it can answer only from evidence:
//
//   * `agent_plan` must be called before any edit (goal, steps, criteria).
//   * `agent_complete` is rejected unless a check has passed *after* the latest
//     edit and a failure, and unless every planned criterion is reported by id.
//   * After every completed answer the loop re-derives the next required action
//     and, if the gate is unsatisfied, appends it as a system-style instruction so
//     the model cannot quietly stop at "the code looks right".
//
// That is what makes a small model usable for real work: the sequence lives in the
// harness, not in the model's willingness to follow a 40-line prompt.
// ============================================================================
import { callModel, reasoningOnly, type ProviderTurnAnswer, type ProviderTurnRequest } from './provider';
import { callProjectTool, parseToolArguments, type ToolResult } from './projectMcp';
import { allToolDefsForProvider } from './projectTools';
import { projectStore } from './project';
import { drainPreviewIssues, listPreviews } from './container';
import { clampBatch, clampRounds } from './mode';

export const MAX_AGENT_STEPS = 32;
/** How many times the gate may hand the model a "NEXT REQUIRED ACTION" it ignored. */
export const MAX_GATE_NUDGES = 2;

/**
 * Added to the prompt in single-shot mode. It rewrites the tool order the rest of the
 * system prompt asks for, because the default order (plan, then edit, then run, then
 * verify) cannot fit in one round.
 */
const SINGLE_SHOT_BRIEF = [
  'SINGLE-SHOT MODE: you have ONE response to do the whole job. In that response, emit',
  'agent_plan first, then every project_write_file / project_replace_lines needed, then the',
  'first project_run_command, all as tool calls in the same response. Then, when asked,',
  'answer in prose. Do not read files whose contents are already listed in the workspace',
  'section, and do not poll anything you started — the harness reports process output back.',
].join(' ');

/**
 * Tool calls allowed in one model response. The ceiling is a guard-rail, not a
 * capability: one response carrying 16 writes is 16 approval prompts and a very long
 * single answer, and a model that batches badly runs out of `max_tokens` mid-call and
 * loses the whole batch. 8 is the default because that is a whole small scaffold.
 */
export { MIN_BATCH, MAX_BATCH, DEFAULT_BATCH, clampBatch } from './mode';

export type AgentEvent =
  | { kind: 'round'; round: number; limit: number }
  | { kind: 'tool'; round: number; tool: string; detail: string; output: string; ok: boolean }
  | { kind: 'denied'; tool: string; detail: string }
  | { kind: 'text'; text: string }
  | { kind: 'log'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'gate'; problems: string[]; next: string }
  /** A file/command change worth showing as a diff or a line, with the byte sizes involved. */
  | { kind: 'change'; path: string; action: 'created' | 'updated' | 'deleted' | 'unchanged'; added: number; removed: number; diff: string }
  /**
   * What the task has cost so far. Emitted after every turn (so the counter moves while
   * the agent works) and once at the end with the final totals.
   */
  | {
      kind: 'usage';
      toolCalls: number;
      requests: number;
      promptTokens: number;
      completionTokens: number;
      reasoningTokens: number;
      /** Prompt tokens served from the provider's prefix cache, when it reports them. */
      cachedTokens: number;
      totalTokens: number;
      /** False when the provider sent no `usage` at all — the count is a floor, not a total. */
      reported: boolean;
    }
  /** Live token deltas for the round in flight; `reset` starts a new assistant message. */
  | { kind: 'stream'; text: string; reset?: boolean }
  | { kind: 'thinking'; text: string; reset?: boolean };

export type AgentPlan = {
  goal: string;
  steps: string[];
  criteria: Array<{ id: string; description: string }>;
  requiresPreview: boolean;
};

export type Progress = {
  status: 'inactive' | 'pending' | 'blocked' | 'limited' | 'ready';
  plan?: AgentPlan;
  edited: boolean;
  needsRepair: boolean;
  needsCommandRepair: boolean;
  retryCreatePath?: string;
  installingProcessId?: string;
  ran: boolean;
  tested: boolean;
  previewReady: boolean;
  steps: number;
  evidence: string[];
  completed: boolean;
  blocked: boolean;
};

type Turn = { role: 'user' | 'assistant'; content: string };

type CallRecord = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  failed: boolean;
  position: number;
};

function isAgentPlan(value: unknown): value is AgentPlan {
  const plan = value as Partial<AgentPlan> | null;
  return Boolean(
    plan &&
      typeof plan.goal === 'string' &&
      Array.isArray(plan.steps) &&
      plan.steps.every((step) => typeof step === 'string') &&
      Array.isArray(plan.criteria) &&
      plan.criteria.length > 0 &&
      plan.criteria.every((c) => typeof c?.id === 'string' && typeof c.description === 'string') &&
      typeof plan.requiresPreview === 'boolean',
  );
}

/**
 * Derive the progress record from the calls actually executed. This is the whole
 * trick: it reads evidence, never the model's claims.
 */
export function getProgress(calls: CallRecord[], userText: string, stepCount: number, denied: boolean): Progress {
  const informational =
    /^(?:(?:please|can you|could you)\s+)*(?:explain|tell me|what|where|when|why|how|which|who|find|search|research)\b/i.test(
      userText,
    ) &&
    !/\b(?:build|create|implement|make|add|change|edit|fix|update|remove|move|replace|refactor)\b/i.test(userText);

  let plan: AgentPlan | undefined;
  let lastEdit = -1;
  let lastFailure = -1;
  let lastCommandFailure = -1;
  let lastRun = -1;
  let lastPassingCheck = -1;
  let lastPlan = -1;
  let completedAt = -1;
  let previewReady = false;
  let installingProcessId: string | undefined;
  let retryCreatePath: string | undefined;
  let blocked = false;
  const evidence: string[] = [];

  for (const call of calls) {
    const output = (call.result?.structuredContent ?? {}) as Record<string, unknown>;

    if (call.name === 'agent_complete' && output.blocked === true) {
      blocked = true;
    }
    if (call.failed) {
      lastFailure = call.position;
      if (call.name === 'project_run_command' || call.name === 'project_get_process_output') {
        lastCommandFailure = call.position;
      }
      if (call.name === 'project_write_file' && typeof output.retryCreatePath === 'string') {
        retryCreatePath = output.retryCreatePath;
      }
      continue;
    }

    if (call.name === 'agent_plan' && isAgentPlan(output.plan)) {
      plan = output.plan as AgentPlan;
      lastPlan = call.position;
    }
    if (call.name === 'agent_complete' && output.completed === true) {
      completedAt = call.position;
    }

    const written = ['project_write_file', 'project_replace_lines', 'project_patch_file', 'project_delete_path'];
    if (written.includes(call.name) && output.changed !== false) {
      lastEdit = call.position;
    }
    if (written.includes(call.name) && typeof output.path === 'string' && output.path === retryCreatePath) {
      retryCreatePath = undefined;
    }

    if (typeof output.previewReady === 'boolean') {
      previewReady = output.previewReady;
    }
    if (call.name === 'project_stop_process' && output.stopped === true && output.purpose === 'run') {
      previewReady = false;
    }

    const commandResult = call.name === 'project_run_command' || call.name === 'project_get_process_output';
    const purpose = (output.purpose ?? call.args.purpose) as string | undefined;
    const processId = typeof output.processId === 'string' ? output.processId : undefined;

    if (commandResult && purpose === 'install' && output.status === 'running' && processId) {
      installingProcessId = processId;
    }
    if (commandResult && output.status === 'waiting-for-install' && typeof output.installProcessId === 'string') {
      installingProcessId = output.installProcessId;
    }
    if (call.name === 'project_stop_process' && output.stopped === true && processId === installingProcessId) {
      installingProcessId = undefined;
    }

    if (commandResult && purpose === 'run' && output.status === 'running') {
      lastRun = call.position;
    }
    if (
      commandResult &&
      purpose === 'test' &&
      output.status === 'exited' &&
      output.exitCode === 0 &&
      call.position > lastEdit &&
      call.position > lastFailure
    ) {
      lastPassingCheck = call.position;
    }

    if (call.result && !call.result.isError) {
      evidence.push(call.id);
    }
  }

  const ran = lastRun > lastEdit || previewReady;
  const tested = lastPassingCheck > lastEdit && lastPassingCheck > lastFailure && lastPassingCheck >= 0;
  const completed =
    completedAt > lastPlan && completedAt > lastEdit && completedAt > lastFailure && Boolean(plan);
  const active = !informational;

  const status: Progress['status'] = !active
    ? 'inactive'
    : blocked || denied
      ? 'blocked'
      : completed && tested && ran && (!plan?.requiresPreview || previewReady)
        ? 'ready'
        : stepCount >= MAX_AGENT_STEPS
          ? 'limited'
          : 'pending';

  return {
    status,
    plan,
    edited: lastEdit >= 0,
    needsRepair: lastFailure > Math.max(lastEdit, lastPassingCheck),
    needsCommandRepair: lastCommandFailure > Math.max(lastEdit, lastPassingCheck),
    retryCreatePath,
    installingProcessId,
    ran,
    tested,
    previewReady,
    steps: stepCount,
    evidence,
    completed,
    blocked,
  };
}

export function completionProblems(progress: Progress): string[] {
  const problems: string[] = [];
  if (!progress.plan) {
    problems.push('Record a plan with explicit completion criteria using agent_plan.');
  }
  if (!progress.ran) {
    problems.push('Run the app or requested program and inspect its output with purpose "run".');
  }
  if (progress.plan?.requiresPreview && !progress.previewReady) {
    problems.push('Confirm a running preview before completing.');
  }
  if (!progress.tested) {
    problems.push('Run a relevant check with purpose "test" and confirm exit code 0 after the latest edit or failure.');
  }
  return problems;
}

/** The one instruction the model gets after each of its own turns. */
export function nextInstruction(progress: Progress): { text: string; next: string } {
  if (progress.status === 'blocked') {
    return {
      text: 'Stop using tools. Explain the blocker or denied operation and list unmet completion criteria without claiming success.',
      next: 'report the blocker',
    };
  }
  if (progress.status === 'limited') {
    return {
      text: `The ${MAX_AGENT_STEPS}-step task limit was reached. Stop using tools and report actual progress, unmet criteria and checks that did not pass.`,
      next: 'report partial progress',
    };
  }
  if (progress.status === 'ready') {
    return {
      text: 'The completion gate accepted this task. Summarize the changed files, the passing checks and how each criterion was met. Do not start unrelated work.',
      next: 'summarize',
    };
  }
  if (!progress.plan) {
    return {
      text: 'Inspect the project with project_list_paths / project_read_file if you need context. Then call agent_plan with a concise plan and observable completion criteria BEFORE editing or running commands.',
      next: 'agent_plan',
    };
  }
  if (progress.installingProcessId) {
    return {
      text: `Poll the dependency install with project_get_process_output and processId ${JSON.stringify(progress.installingProcessId)}. Wait for exit code 0 before starting the app or running checks.`,
      next: 'poll install',
    };
  }
  if (progress.needsCommandRepair) {
    return {
      text: 'Recover the failed command: read its output, fix the cause, then retry it with project_run_command. Do not run the completion gate yet.',
      next: 'repair the command',
    };
  }
  if (progress.needsRepair) {
    return {
      text: progress.retryCreatePath
        ? `Create ${JSON.stringify(progress.retryCreatePath)} again with project_write_file. Its earlier write failed validation before saving, so no file exists yet. Send the path and complete valid content with real line breaks.`
        : 'Repair the latest failed project tool action using its exact error. Re-read the file if needed. Do not run the completion gate yet.',
      next: progress.retryCreatePath ? `rewrite ${progress.retryCreatePath}` : 'repair the failed call',
    };
  }
  if (!progress.edited) {
    return {
      text: 'Implement the requested changes now. For targeted edits read the file with numbered: true then project_replace_lines with its revision; for new files use project_write_file.',
      next: 'edit files',
    };
  }
  if (!progress.ran) {
    return {
      text: 'Run the changed app or program now with project_run_command and purpose "run". Inspect its output.',
      next: 'run it',
    };
  }
  if (!progress.tested) {
    return {
      text: 'Run the smallest relevant check now with project_run_command and purpose "test" (an existing script, a typecheck, or a focused assertion). Wait for exit code 0 and repair failures before continuing.',
      next: 'run a check',
    };
  }
  if (progress.plan?.requiresPreview && !progress.previewReady) {
    return {
      text: 'Start or inspect the app preview now and confirm it is running before completing.',
      next: 'start the preview',
    };
  }
  return {
    text: 'Call agent_complete alone, reporting every recorded criterion by its exact ID. A plan or a started process alone is not completion.',
    next: 'agent_complete',
  };
}

/**
 * Used when a model produced reasoning but no answer and no tool call. Saying
 * "answer now" is not enough — the useful instruction names the constraint that
 * caused it: a huge thinking budget.
 */
const NO_ANSWER_NUDGE = [
  'Your previous turn spent the whole budget on internal reasoning and returned neither an answer nor a tool call.',
  'Do not deliberate further: either call ONE tool now with the arguments its schema requires, or reply in prose with what you know so far.',
  'Keep reasoning to a sentence or two. If you were trying to plan, call agent_plan with goal, steps, criteria and requiresPreview instead of describing the plan.',
].join('\n');

const SYSTEM_PROMPT = [
  'You are a coding agent operating a real Node.js sandbox in the user\u2019s browser, rooted at the project (tools call it /workspace, the shell sees the project root).',
  'Use the tools to inspect, write and run code instead of describing what you would do. Never print tool-call JSON as a substitute for calling a tool.',
  'Project paths in tool arguments are relative to the project root: src/App.tsx, package.json. Never /home/project or /workspace.',
  'Before a targeted edit, read the file with numbered: true and then call project_replace_lines with the returned revision. When a patch conflicts, read the file again instead of repeating the stale patch.',
  'Node.js only: no Python, no apt. Tests: `npm i -D vitest` then `npx vitest run`.',
  'Commands time out after 120s (300s for installs) and output is capped at 100k chars. Keep steps small; run installs as their own command with purpose "install" and poll them.',
  'Treat tool output as the source of truth. Report failed commands as failed and do not claim a file changed until a tool result confirms it.',
  'Keep runtime load light: do not run a production build unless asked, and only run install when package.json changed or node_modules is missing.',
  'Give brief progress updates in plain text between tool calls. Be concise: decide, then act.',
  'BATCH. One response = one request = one thing the user pays for. Put every independent call in the SAME response: all files of a scaffold together, then install, then run. Never spend a round on project_list_paths or on reading files whose contents are listed below — you have them. If a file is listed as truncated, read only that file.',
  'For a NEW feature, write the code first and only then run it. If the workspace already has a page and an entry script, edit them in one batch; do not re-read them one at a time to decide.',
].join('\n');

/**
 * Sum one turn's `usage` into the running totals. Providers report `prompt_tokens` /
 * `completion_tokens`; some proxies omit usage entirely on streams, which is why the
 * panel labels the number "≥" when `reported` is false rather than showing a confident 0.
 */
function accumulateUsage(
  totals: { prompt: number; completion: number; reasoning: number; total: number; cached: number },
  usage: ProviderTurnAnswer['usage'] | undefined,
): boolean {
  if (!usage || typeof usage !== 'object') {
    return false;
  }
  const pick = (value: unknown) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
  const prompt = pick(usage.prompt_tokens ?? (usage as Record<string, unknown>).input_tokens);
  // Prefix-cache hits. Field names differ by gateway (OpenAI's prompt_tokens_details,
  // DeepSeek's prompt_cache_hit_tokens, Anthropic's cache_read_input_tokens), and the
  // number is the difference between "your per-round cost is flat" and "it triples".
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cachedRaw =
    details.cached_tokens ??
    (usage as Record<string, unknown>).prompt_cache_hit_tokens ??
    (usage as Record<string, unknown>).cache_read_input_tokens;
  const cached = pick(cachedRaw);
  const completion = pick(usage.completion_tokens ?? (usage as Record<string, unknown>).output_tokens);
  const reasoning = pick(usage.completion_tokens_details?.reasoning_tokens);
  const total = pick(usage.total_tokens) || prompt + completion;
  if (prompt + completion + total === 0) {
    return false;
  }
  totals.cached += Math.min(cached, prompt);
  totals.prompt += prompt;
  totals.completion += completion;
  totals.reasoning += reasoning;
  totals.total += total;
  return true;
}

/**
 * What is already in the workspace, as a stable text block for the system prompt.
 *
 * Two hard limits, both learned from real prompts: the block is capped in characters
 * (a 60-file project must not triple every request's input tokens) and each file is
 * capped in length (a listed 3 000-line file would be re-sent on every single round).
 * Files over the per-file cap are listed with their line count and marked TRUNCATED so
 * the model knows to read them properly instead of guessing from the head.
 */
const INVENTORY_MAX_CHARS = 24_000;
const INVENTORY_MAX_FILE_CHARS = 4_000;

export function workspaceInventory(): string {
  let files: Record<string, { type?: string; content?: string; isBinary?: boolean } | undefined> = {};
  try {
    files = projectStore.files as never;
  } catch {
    return 'WORKSPACE: (unavailable)';
  }
  const paths = Object.keys(files)
    .filter((path) => files[path]?.type === 'file')
    .sort();
  if (paths.length === 0) {
    return 'WORKSPACE: empty. There is nothing to read — create the files you need.';
  }
  const lines: string[] = [`WORKSPACE (${paths.length} file${paths.length === 1 ? '' : 's'}), most of it below:`];
  let used = 0;
  const omitted: string[] = [];
  for (const path of paths) {
    const entry = files[path];
    const display = path.replace(/^\/workspace\/?/, '');
    if (!entry || entry.isBinary) {
      lines.push(`- ${display} (binary)`);
      continue;
    }
    const content = String(entry.content ?? '');
    const lineCount = content === '' ? 0 : content.split('\n').length;
    if (used > INVENTORY_MAX_CHARS) {
      omitted.push(`${display} (${lineCount} lines)`);
      continue;
    }
    let body = content;
    let truncated = false;
    if (body.length > INVENTORY_MAX_FILE_CHARS) {
      body = body.slice(0, INVENTORY_MAX_FILE_CHARS);
      truncated = true;
    }
    used += body.length;
    lines.push(
      `- ${display} (${lineCount} line${lineCount === 1 ? '' : 's'}${truncated ? `, TRUNCATED — read it with project_read_file` : ''}):\n${body}`,
    );
  }
  if (omitted.length) {
    lines.push(`Not shown (size budget): ${omitted.join(', ')}. Read these only if the task needs them.`);
  }
  return lines.join('\n');
}

export type RunOptions = {
  prompt: string;
  history: Turn[];
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  maxRounds?: number;
  /**
   * Tool calls the model may put in ONE response (1–16). This is the knob that decides
   * how many round trips a task costs: 5 file writes either arrive as one request with
   * five calls, or as five requests with one call each. It is separate from
   * `maxRounds` (how many requests the task may spend) and from `maxTokens` (how big
   * any single answer may be), because those answer different questions.
   */
  maxToolCallsPerRound?: number;
  /**
   * Spend ONE tool-calling round on the whole job, then ask for the summary.
   *
   * Measured on a real 3-request budget: the agent spent round 1 on project_list_paths,
   * round 2 reading package.json, round 3 reading main.js, and never wrote a file. Batching
   * alone cannot fix that, because the ceiling that bites is the REQUEST budget, not the
   * calls per request. In this mode the plan, every write and the first run go out in a
   * single response; the loop then stops stepping and asks for prose. Verification is what
   * is traded away, so the transcript says so instead of implying the gate ran.
   */
  singleShot?: boolean;
  /** Let the gateway batch calls in one response. Off = one call per round, always. */
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** Stream the model's reasoning trace into the activity log (off by default: it is noise for most users). */
  showThinking?: boolean;
  onStats?: (stats: {
    roundsUsed: number;
    roundsAllowed: number;
    upstreamCalls: number;
    toolCalls: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
    totalTokens: number;
  }) => void;
};

/** One job of the whole loop. Returns the final prose the model produced. */
export async function runAgentTask(options: RunOptions): Promise<string> {
  const rounds = clampRounds(options.maxRounds);
  const tools = toolDefinitions();
  // The workspace inventory, written into the FIRST message. Round 1 used to burn a
  // whole request on `project_list_paths` for information the harness already holds in
  // `projectStore.files`, and — on a 3-request budget — that was a third of the task
  // spent discovering a file list. A model that can already see the tree writes code
  // instead of asking what is there.
  const inventory = workspaceInventory();
  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}\n\n${options.singleShot ? `${SINGLE_SHOT_BRIEF}\n\n` : ''}${inventory}`,
    },
    ...options.history.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: options.prompt },
  ];

  const calls: CallRecord[] = [];
  /** Model requests spent, which is what a caller's provider quota is charged for. */
  let stepCount = 0;
  /** Rounds in which the model asked for at least one tool. */
  let toolRounds = 0;
  /** Gate nudges appended so the model gets a bounded number of second chances. */
  let nudges = 0;
  /** One extra request when the model reasoned without answering. */
  let reasoningRetried = false;
  /** The next prose answer is the task summary the gate asked for. */
  let gateSummaryPending = false;
  let finalText = '';
  let upstreamCalls = 0;
  let denied = false;
  let stopped = false;
  // Token accounting, summed from each turn's `usage`. Nothing else in the app knows
  // what a task cost, and on a metered key that is the number people actually want.
  const tokens = { prompt: 0, completion: 0, reasoning: 0, total: 0, cached: 0 };
  let toolCallsRun = 0;
  const batchSize = clampBatch(options.maxToolCallsPerRound);
  /** Did any turn actually report usage? If not the counter understates, and says so. */
  let usageReported = false;
  const emitUsage = () =>
    options.emit({
      kind: 'usage',
      toolCalls: toolCallsRun,
      requests: upstreamCalls,
      promptTokens: tokens.prompt,
      completionTokens: tokens.completion,
      reasoningTokens: tokens.reasoning,
      cachedTokens: tokens.cached,
      totalTokens: tokens.total,
      reported: usageReported,
    });

  options.emit({
    kind: 'log',
    text:
      `budget: ${rounds} model request(s)${options.singleShot ? ' (single-shot: one tool round, then a summary)' : ''}, ` +
      `up to ${batchSize} tool call(s) per request, ${(options.maxTokens ?? 8192).toLocaleString()} tokens per answer` +
      `${options.singleShot ? '' : ` — plus at most ${MAX_GATE_NUDGES} gate nudge(s) and 1 summary request`}`,
  });

  for (let round = 1; round <= rounds; round++) {
    if (options.signal?.aborted) {
      stopped = true;
      break;
    }

    // Anything the running preview complained about since the last round goes to the
    // model with the next request. This is the only way it learns its own page is
    // broken: the command exited 0 and the HTML rendered, yet `boom is not defined`
    // is fatal.
    if (round > 1) {
      const issues = drainPreviewIssues();
      if (issues.length > 0) {
        options.emit({ kind: 'log', text: `preview reported ${issues.length} problem(s)` });
        messages.push({
          role: 'user',
          content: `The running preview reported these problems:\n${issues
            .map((line) => `- ${line}`)
            .join('\n')}\nThese are real exceptions from the page currently being served, but they may predate your latest edits — check the file before changing it, and fix them if they are still reproducible.`,
        });
      }
    }

    stepCount += 1;
    options.emit({ kind: 'round', round, limit: rounds });

    let answer;
    // Live deltas, so a 20-second round is visibly working instead of looking hung.
    // The panel buffers them into one growing bubble and replaces it with the final
    // `text` event, which is why a stream never has to be reconciled with the answer.
    options.emit({ kind: 'stream', text: '', reset: true });
    const request: ProviderTurnRequest = {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      messages,
      tools,
      maxTokens: options.maxTokens,
      parallelToolCalls: options.parallelToolCalls !== false,
      signal: options.signal,
      onNote: (note) => options.emit({ kind: 'log', text: note }),
      onDelta: (delta) => {
        if (delta.text) {
          options.emit({ kind: 'stream', text: delta.text });
        } else if (delta.reasoning && options.showThinking) {
          options.emit({ kind: 'thinking', text: delta.reasoning });
        }
      },
    };
    try {
      upstreamCalls += 1;
      answer = await callModel(request);
    } catch (error) {
      if (options.signal?.aborted) {
        stopped = true;
        break;
      }
      const message = String((error as Error)?.message ?? error);
      // One automatic retry for a throttled turn: free tiers cap at a few requests
      // per minute and a 12s pause is the difference between "the agent works" and
      // a red box.
      if (/429|rate limit|throttl/i.test(message) && round > 0) {
        options.emit({ kind: 'log', text: 'provider throttled this turn — waiting 12s and retrying once' });
        await new Promise((r) => setTimeout(r, 12_000));
        if (options.signal?.aborted) {
          stopped = true;
          break;
        }
        try {
          upstreamCalls += 1;
          answer = await callModel(request);
        } catch (retryError) {
          options.emit({ kind: 'error', text: String((retryError as Error)?.message ?? retryError) });
          if (round === 1) {
            throw retryError;
          }
          break;
        }
      } else {
        options.emit({ kind: 'error', text: message });
        if (round === 1) {
          throw error;
        }
        break;
      }
    }

    if (accumulateUsage(tokens, answer.usage)) {
      usageReported = true;
      emitUsage();
    }

    // Everything the model asked for in this one response, up to the batch ceiling.
    // The previous hard-coded 8 was invisible to the user and silently truncated a
    // batch that a model had already paid to generate.
    const asked = Array.isArray(answer.toolCalls) ? answer.toolCalls : [];
    const toolCalls = asked.slice(0, batchSize);
    if (asked.length > toolCalls.length) {
      options.emit({
        kind: 'log',
        text: `model asked for ${asked.length} tool calls in one response; running the first ${toolCalls.length} (raise "calls/request" to allow more)`,
      });
    }

    // Round-trip the assistant turn WITH its tool_calls: an assistant message that
    // omits them makes the model re-issue the identical call forever.
    messages.push({
      role: 'assistant',
      content: answer.content || '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    if (answer.content.trim()) {
      options.emit({ kind: 'text', text: answer.content });
      finalText = answer.content;
    } else if (answer.reasoning?.trim() && toolCalls.length === 0) {
      // Only worth saying when the model ALSO failed to call a tool. A tool-calling
      // turn that carries reasoning and no prose is normal: every round of a real
      // build looks like that, and printing "no final answer" over it made a working
      // run read like ten errors in a row.
      options.emit({ kind: 'log', text: `(reasoning only, no prose) ${trimReasoning(answer.reasoning)}` });
    }

    if (toolCalls.length === 0) {
      if (gateSummaryPending && answer.content.trim()) {
        // This is the requested summary; it is the answer, not another gate round.
        finalText = answer.content;
        break;
      }
      if (!answer.content.trim()) {
        // Three distinct failures used to share one unhelpful message. They need
        // different advice, because only one of them is fixed by raising max tokens.
        if (reasoningOnly(answer)) {
          if (reasoningRetried) {
            options.emit({
              kind: 'error',
              text: `Model spent its budget on reasoning and produced no answer or tool call (reasoning tokens: ${
                answer.usage?.completion_tokens_details?.reasoning_tokens ?? 'unknown'
              }). Retry with a SMALLER max-tokens budget in the sandbox panel — reasoning models often answer only when the budget forces them to stop deliberating — or pick a non-reasoning model.`,
            });
            break;
          }
          reasoningRetried = true;
          options.emit({ kind: 'log', text: 'model reasoned without answering — asking it once more, harder' });
          messages.push({ role: 'user', content: `${NO_ANSWER_NUDGE}\n\nNEXT REQUIRED ACTION: ${
            nextInstruction(getProgress(calls, options.prompt, toolRounds, denied)).next
          }` });
          continue;
        }
        const why =
          answer.finishReason === 'length'
            ? 'ran out of tokens (finish_reason=length) — raise max tokens'
            : `returned no content and no tool calls${answer.finishReason ? ` (finish_reason=${answer.finishReason})` : ''}`;
        options.emit({ kind: 'error', text: `Model ${why}. The turn was not completed.` });
        break;
      }
      // An answer with prose and no call is not necessarily done: re-derive the next
      // required step and push it back. This is the gate that stops "looks right".
      const progress = getProgress(calls, options.prompt, toolRounds, denied);
      if (progress.status === 'inactive' || progress.status === 'ready' || progress.status === 'blocked') {
        break;
      }
      const { text, next } = nextInstruction(progress);
      // A nudge costs this harness one request, not a tool call — but it must be
      // bounded, and it must never be issued when there is no round left to act on it.
      // (The old code nudged on the last round too and reported a budget-exhausted
      // answer as if the agent had simply stopped.)
      if (round >= rounds || nudges >= MAX_GATE_NUDGES) {
        options.emit({ kind: 'gate', problems: completionProblems(progress), next });
        finalText = `${finalText}\n\n_Stopped before the task was verified — next required step was: ${next}_`.trim();
        break;
      }
      nudges += 1;
      options.emit({ kind: 'gate', problems: completionProblems(progress), next });
      messages.push({ role: 'user', content: `${text}\n\nNEXT REQUIRED ACTION: ${next}` });
      continue;
    }

    toolRounds += 1;
    for (const call of toolCalls) {
      if (options.signal?.aborted) {
        stopped = true;
        break;
      }
      const name = String(call.function?.name ?? '');
      let args: Record<string, unknown> = {};
      try {
        args = parseToolArguments(name, JSON.parse(String(call.function?.arguments ?? '{}') || '{}'));
      } catch (error) {
        const note = String((error as Error)?.message ?? error);
        options.emit({ kind: 'tool', round, tool: name, detail: note, output: note, ok: false });
        messages.push({ role: 'tool', tool_call_id: call.id, content: note });
        continue;
      }

      const record: CallRecord = { id: call.id, name, args, failed: false, position: calls.length + 1 };
      calls.push(record);
      toolCallsRun += 1;

      const before = snapshotBefore(name, args);
      const outcome = await runOneTool(name, args, options, calls);
      const change = buildChange(name, args, before, outcome);
      if (change) {
        options.emit(change);
      }
      record.result = outcome.result;
      record.failed = Boolean(outcome.result.isError);
      if (outcome.denied) {
        denied = true;
      }
      options.emit({
        kind: 'tool',
        round,
        tool: name,
        detail: outcome.detail,
        output: outcome.text.slice(0, 8000),
        ok: !outcome.result.isError,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text.slice(0, 60_000) });
    }

    const progress = getProgress(calls, options.prompt, toolRounds, denied);

    if (options.singleShot) {
      // The one tool round is spent. Ask for the summary, and say plainly what was NOT
      // verified — the alternative is a transcript that looks gated when it was not.
      const problems = completionProblems(progress);
      if (problems.length > 0) {
        options.emit({ kind: 'gate', problems, next: 'summarize honestly' });
      }
      if (round < rounds) {
        messages.push({
          role: 'user',
          content:
            'Single-shot round complete. Reply now in prose — no tool calls — with what you wrote, what you ran, and what you did NOT verify. Be specific and short.',
        });
        gateSummaryPending = true;
        continue;
      }
      break;
    }

    if (progress.status === 'ready') {
      options.emit({ kind: 'log', text: 'completion gate accepted the task' });
      // One more request for the summary the user actually reads. Breaking here used
      // to leave the chat with an empty answer after a successful task: the gate was
      // satisfied, the work was done, and the transcript said nothing at all.
      if (round < rounds) {
        messages.push({
          role: 'user',
          content:
            'The completion gate accepted this task. Reply now in prose — no tool calls — with a short summary: files changed, checks that passed, and how each criterion was met.',
        });
        gateSummaryPending = true;
        continue;
      }
      break;
    }
    if (progress.status === 'blocked') {
      break;
    }
    if (toolRounds >= MAX_AGENT_STEPS) {
      options.emit({ kind: 'log', text: `step limit reached (${MAX_AGENT_STEPS})` });
      break;
    }
  }

  if (stopped) {
    options.emit({ kind: 'log', text: 'stopped' });
    finalText = finalText ? `${finalText}\n\n_stopped by you_` : 'Stopped by you.';
  }

  emitUsage();
  options.onStats?.({
    roundsUsed: stepCount,
    roundsAllowed: rounds,
    upstreamCalls,
    toolCalls: toolCallsRun,
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
    reasoningTokens: tokens.reasoning,
    cachedTokens: tokens.cached,
    totalTokens: tokens.total,
  });
  return finalText;
}

/** Execute `agent_plan` / `agent_complete` locally, everything else through MCP. */
async function runOneTool(
  name: string,
  args: Record<string, unknown>,
  options: RunOptions,
  calls: CallRecord[],
): Promise<{ result: ToolResult; text: string; detail: string; denied: boolean }> {
  if (name === 'agent_plan') {
    const result: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ plan: args }) }],
      structuredContent: { plan: args },
    };
    return {
      result,
      text: `Plan recorded:\n${String(args.goal ?? '')}\n${(args.steps as string[] | undefined)
        ?.map((step, index) => `${index + 1}. ${step}`)
        .join('\n')}`,
      detail: String(args.goal ?? 'plan'),
      denied: false,
    };
  }

  if (name === 'agent_complete') {
    // The gate is evaluated against what actually happened, not against the claim.
    const progress = getProgress(calls, options.prompt, calls.length, false);
    if (args.outcome === 'blocked') {
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify({ completed: false, blocked: true, reason: args.summary }) }],
          structuredContent: { completed: false, blocked: true, reason: args.summary },
        },
        text: `Blocked: ${String(args.summary ?? '')}`,
        detail: 'blocked',
        denied: false,
      };
    }
    const problems = completionProblems(progress);
    const reported = (args.criteria as Array<{ id?: string }> | undefined) ?? [];
    const plannedIds = new Set((progress.plan?.criteria ?? []).map((criterion) => criterion.id));
    const reportedIds = reported.map((criterion) => cameraId(criterion.id));
    if (progress.plan) {
      const missing = [...plannedIds].filter((id) => !reportedIds.includes(id));
      if (missing.length) {
        problems.push(`Report planned criteria ${missing.map((id) => JSON.stringify(id)).join(', ')} by their exact ids.`);
      }
      const unknown = reportedIds.filter((id) => !plannedIds.has(id));
      if (unknown.length) {
        problems.push(`Criteria ${unknown.join(', ')} are not in the recorded plan.`);
      }
    }
    if (problems.length > 0) {
      const text = problems.join(' ');
      return {
        result: {
          isError: true,
          content: [{ type: 'text', text }],
          structuredContent: { completed: false, problems, error: text, plannedCriteria: [...plannedIds] },
        },
        text,
        detail: 'completion rejected',
        denied: false,
      };
    }
    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify({ completed: true, summary: args.summary }) }],
        structuredContent: {
          completed: true,
          summary: args.summary,
          criteria: (progress.plan?.criteria ?? []).map((criterion) => ({
            id: criterion.id,
            evidence: progress.evidence.slice(0, 5),
          })),
        },
      },
      text: `Task accepted as complete: ${String(args.summary ?? '')}`,
      detail: 'complete',
      denied: false,
    };
  }

  // Anything the user must approve is asked once, here, and the answer is honoured
  // for the rest of the turn: re-prompting for the 6th `npm install` trains people
  // to click approve without reading, which is worse than one considered decision.
  const detail =
    name === 'project_run_command'
      ? `run: ${String(args.command ?? '')}`
      : name === 'project_write_file'
        ? `write: ${String(args.path ?? '')}`
        : name === 'project_replace_lines' || name === 'project_patch_file'
          ? `edit: ${String(args.path ?? '')}`
          : name === 'project_delete_path'
            ? `delete: ${String(args.path ?? '')}`
            : `${name}: ${String(args.path ?? args.query ?? '')}`;

  if (requiresApproval(name) && approvalSink) {
    const ok = await approvalSink({ tool: name, detail, signal: options.signal });
    if (!ok) {
      const text = 'The user rejected this action. Do not retry it unchanged; pick another approach or explain why it is required.';
      return {
        result: { isError: true, content: [{ type: 'text', text }], structuredContent: { error: text, denied: true } },
        text,
        detail,
        denied: true,
      };
    }
  }

  try {
    const result = await callProjectTool(name, args, { signal: options.signal });
    return { result, text: result.content.map((part) => part.text).join('\n'), detail, denied: false };
  } catch (error) {
    const text = `error: ${String((error as Error)?.message ?? error)}`;
    return {
      result: { isError: true, content: [{ type: 'text', text }], structuredContent: { error: text } },
      text,
      detail,
      denied: false,
    };
  }
}

/**
 * Content of the file a write/patch is about to touch, so a diff can be shown.
 * Read from the store the tools themselves write to, which is why it is synchronous
 * and free — no extra round trip to the container.
 */
function snapshotBefore(name: string, args: Record<string, unknown>): string | null {
  if (name !== 'project_write_file' && name !== 'project_replace_lines' && name !== 'project_patch_file') {
    return null;
  }
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) {
    return null;
  }
  try {
    const virtual = path.startsWith('/') ? path : `/workspace/${path.replace(/^\.\//, '')}`;
    const entry = projectStore.files[virtual];
    return entry?.type === 'file' ? entry.content : null;
  } catch {
    return null;
  }
}

function buildChange(
  name: string,
  args: Record<string, unknown>,
  before: string | null,
  outcome: { result: ToolResult },
): Extract<AgentEvent, { kind: 'change' }> | null {
  const structured = (outcome.result.structuredContent ?? {}) as Record<string, unknown>;
  if (name === 'project_delete_path' && structured.deleted === true) {
    return {
      kind: 'change',
      path: String(structured.path ?? args.path ?? ''),
      action: 'deleted',
      added: 0,
      removed: before ? before.split('\n').length : 0,
      diff: '',
    };
  }
  const isWrite = name === 'project_write_file' || name === 'project_replace_lines' || name === 'project_patch_file';
  if (!isWrite || outcome.result.isError || structured.changed === false) {
    return null;
  }
  const path = String(structured.path ?? args.path ?? '');
  if (!path) {
    return null;
  }
  const virtual = path.startsWith('/') ? path : `/workspace/${path.replace(/^\.\//, '')}`;
  const entry = projectStore.files[virtual];
  const after = entry?.type === 'file' ? entry.content : null;
  if (after === null && name !== 'project_write_file') {
    return null;
  }
  const diff = lineDiff(before ?? '', after ?? String(args.content ?? ''));
  return {
    kind: 'change',
    path,
    action: before === null ? 'created' : 'updated',
    added: diff.filter((line) => line.kind === 'add').length,
    removed: diff.filter((line) => line.kind === 'remove').length,
    diff: diff
      .map((line) => `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`)
      .join('\n')
      .slice(0, 20_000),
  };
}

/**
 * A minimal line diff (longest-common-subsequence over lines), capped so a 4000-line
 * file cannot stall the tab. bolt.diy renders diffs from `diff`/`diff-match-patch`;
 * this needs no dependency because the only consumer is a monospace block.
 */
export function lineDiff(
  before: string,
  after: string,
): Array<{ kind: 'add' | 'remove' | 'same'; text: string }> {
  if (before === after) {
    return [];
  }
  // `''.split('\n')` is `['']`; an empty file is zero lines, not one blank line.
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const maxCells = 400_000;
  if (a.length * b.length > maxCells) {
    return [...a.map((text) => ({ kind: 'remove' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  // LCS length table (bottom-up), then walk it to classify each line.
  const table: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: Array<{ kind: 'add' | 'remove' | 'same'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'remove', text: a[i] });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: 'remove', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: 'add', text: b[j] });
    j += 1;
  }
  // Collapse the long unchanged stretches: a diff is for seeing what changed.
  const collapsed: typeof out = [];
  let sameRun: Array<{ kind: 'same'; text: string }> = [];
  const flushSame = () => {
    if (sameRun.length > 6) {
      collapsed.push(...sameRun.slice(0, 3));
      collapsed.push({ kind: 'same', text: `… ${sameRun.length - 6} unchanged line(s) …` });
      collapsed.push(...sameRun.slice(-3));
    } else {
      collapsed.push(...sameRun);
    }
    sameRun = [];
  };
  for (const line of out) {
    if (line.kind === 'same') {
      sameRun.push(line as { kind: 'same'; text: string });
    } else {
      flushSame();
      collapsed.push(line);
    }
  }
  flushSame();
  return collapsed;
}

function requiresApproval(name: string): boolean {
  return (
    name === 'project_write_file' ||
    name === 'project_replace_lines' ||
    name === 'project_patch_file' ||
    name === 'project_delete_path' ||
    name === 'project_run_command'
  );
}

export type ApprovalRequest = { tool: string; detail: string; signal?: AbortSignal };
export type ApprovalSink = (request: ApprovalRequest) => Promise<boolean>;

let approvalSink: ApprovalSink | null = null;
/** `null` (panel closed) makes every mutating call fail closed. */
export function setApprovalSink(sink: ApprovalSink | null): void {
  approvalSink = sink;
}

function toolDefinitions() {
  // One list, built from the same zod schemas the argument validator uses: the loop
  // cannot advertise a tool it will refuse to run.
  return allToolDefsForProvider();
}

/** The tail of a reasoning trace, on one line: enough to judge it, short enough to read. */
function trimReasoning(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `…${flat.slice(-max)}` : flat;
}

function cameraId(value: unknown): string {
  return String(value ?? '').trim();
}
