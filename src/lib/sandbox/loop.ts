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
import { callModel, type ProviderTurnRequest } from './provider';
import { callProjectTool, parseToolArguments, type ToolResult } from './projectMcp';
import { toolDefsForProvider } from './projectTools';
import { projectStore } from './project';
import { drainPreviewIssues, listPreviews } from './container';
import { clampRounds } from './mode';

export const MAX_AGENT_STEPS = 32;

export type AgentEvent =
  | { kind: 'round'; round: number; limit: number }
  | { kind: 'tool'; round: number; tool: string; detail: string; output: string; ok: boolean }
  | { kind: 'denied'; tool: string; detail: string }
  | { kind: 'text'; text: string }
  | { kind: 'log'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'gate'; problems: string[]; next: string };

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

const PLAN_TOOL = {
  type: 'function' as const,
  function: {
    name: 'agent_plan',
    description:
      'Record a concise task plan and observable completion criteria before editing. Each criterion has an id and a description. Use unique, stable ids. Require a preview for a web app, and preserve the existing project on follow-up requests.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' } },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, description: { type: 'string' } },
            required: ['id', 'description'],
          },
        },
        requiresPreview: { type: 'boolean' },
      },
      required: ['goal', 'steps', 'criteria', 'requiresPreview'],
    },
  },
};

const COMPLETE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'agent_complete',
    description:
      'Finish the current task only after running it and passing relevant checks after the latest edit. Report every planned criterion by its exact id. Evidence from successful project tool calls is attached automatically. Use outcome "blocked" with a concrete reason if completion is impossible.',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['complete', 'blocked'] },
        summary: { type: 'string' },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
            required: ['id'],
          },
        },
      },
      required: ['outcome', 'summary'],
    },
  },
};

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
].join('\n');

export type RunOptions = {
  prompt: string;
  history: Turn[];
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  maxRounds?: number;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
  onStats?: (stats: { roundsUsed: number; roundsAllowed: number; upstreamCalls: number }) => void;
};

/** One job of the whole loop. Returns the final prose the model produced. */
export async function runAgentTask(options: RunOptions): Promise<string> {
  const rounds = clampRounds(options.maxRounds);
  const tools = [PLAN_TOOL, COMPLETE_TOOL, ...toolDefinitions()];
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...options.history.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: options.prompt },
  ];

  const calls: CallRecord[] = [];
  let stepCount = 0;
  let finalText = '';
  let upstreamCalls = 0;
  let denied = false;
  let stopped = false;

  options.emit({
    kind: 'log',
    text: `budget: ${rounds} tool call(s), up to ${(options.maxTokens ?? 8192).toLocaleString()} tokens per turn`,
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
            .join('\n')}\nFix them if you can instead of only reporting them.`,
        });
      }
    }

    options.emit({ kind: 'round', round, limit: rounds });

    let answer;
    const request: ProviderTurnRequest = {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      messages,
      tools,
      maxTokens: options.maxTokens,
      signal: options.signal,
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

    const toolCalls = Array.isArray(answer.toolCalls) ? answer.toolCalls.slice(0, 8) : [];

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
    } else if (answer.reasoning?.trim()) {
      options.emit({
        kind: 'log',
        text: `no final answer; last reasoning: ${answer.reasoning.slice(-400).trim()}`,
      });
    }

    if (toolCalls.length === 0) {
      if (!answer.content.trim()) {
        const why =
          answer.finishReason === 'length'
            ? 'ran out of tokens (finish_reason=length) — raise max tokens'
            : `returned no content and no tool calls${answer.finishReason ? ` (finish_reason=${answer.finishReason})` : ''}`;
        options.emit({ kind: 'error', text: `Model ${why}. The turn was not completed.` });
        break;
      }
      // An answer with prose and no call is not necessarily done: re-derive the next
      // required step and push it back. This is the gate that stops "looks right".
      const progress = getProgress(calls, options.prompt, stepCount, denied);
      if (progress.status === 'inactive' || progress.status === 'ready' || progress.status === 'blocked') {
        break;
      }
      const { text, next } = nextInstruction(progress);
      if (round === rounds) {
        options.emit({ kind: 'gate', problems: completionProblems(progress), next });
        finalText = `${finalText}\n\n_Stopped at the tool budget before: ${next}_`.trim();
        break;
      }
      options.emit({ kind: 'gate', problems: completionProblems(progress), next });
      messages.push({ role: 'user', content: `${text}\n\nNEXT REQUIRED ACTION: ${next}` });
      stepCount += 1;
      continue;
    }

    for (const call of toolCalls) {
      if (options.signal?.aborted) {
        stopped = true;
        break;
      }
      const name = String(call.function?.name ?? '');
      stepCount += 1;
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

      const outcome = await runOneTool(name, args, options, calls);
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

    const progress = getProgress(calls, options.prompt, stepCount, denied);
    if (progress.status === 'ready') {
      options.emit({ kind: 'log', text: 'completion gate accepted the task' });
      break;
    }
    if (progress.status === 'blocked') {
      break;
    }
    if (stepCount >= MAX_AGENT_STEPS) {
      options.emit({ kind: 'log', text: `step limit reached (${MAX_AGENT_STEPS})` });
      break;
    }
  }

  if (stopped) {
    options.emit({ kind: 'log', text: 'stopped' });
    finalText = finalText ? `${finalText}\n\n_stopped by you_` : 'Stopped by you.';
  }

  options.onStats?.({ roundsUsed: stepCount, roundsAllowed: rounds, upstreamCalls });
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
  return toolDefsForProvider();
}

function cameraId(value: unknown): string {
  return String(value ?? '').trim();
}
