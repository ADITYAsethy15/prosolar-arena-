/**
 * The loop, driven by a scripted provider.
 *
 * This exists because of a real session: five runs in a row whose only output was
 * "no final answer", because the harness advertised `agent_plan` to the model and
 * then refused to execute it ("Unknown project tool"), making the completion gate
 * unsatisfiable. A unit test on the gate would not have caught that — the bug was in
 * the seam between the advertised tool list, the argument validator and the
 * dispatcher. So this test drives `runAgentTask` with a fake model and a fake bridge
 * and asserts on what the model was TOLD, not just on the final string.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_GATE_NUDGES } from './loop';

const script: Array<{ content?: string; tool_calls?: unknown[]; reasoning?: string; usage?: unknown }> = [];
const sentMessages: Array<Array<Record<string, unknown>>> = [];
const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
let executable = new Set<string>();

vi.mock('./provider', async () => {
  const actual = await vi.importActual<typeof import('./provider')>('./provider');
  return {
    ...actual,
    callModel: vi.fn(async (request: { messages: Array<Record<string, unknown>> }) => {
      sentMessages.push(JSON.parse(JSON.stringify(request.messages)));
      const next = script.shift();
      if (!next) {
        throw new Error('script exhausted');
      }
      return {
        content: next.content ?? '',
        toolCalls: (next.tool_calls ?? []) as never,
        finishReason: next.tool_calls ? 'tool_calls' : 'stop',
        reasoning: next.reasoning,
        usage: next.usage ?? null,
      };
    }),
  };
});

vi.mock('./projectMcp', async () => {
  const actual = await vi.importActual<typeof import('./projectMcp')>('./projectMcp');
  return {
    ...actual,
    callProjectTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (!executable.has(name)) {
        throw new Error(`Unknown project tool: ${name}`);
      }
      executed.push({ name, args });
      const structured =
        name === 'project_write_file'
          ? { path: args.path, written: true, changed: true }
          : name === 'project_run_command'
            ? { processId: 'p-1', purpose: args.purpose, status: args.purpose === 'run' ? 'running' : 'exited', exitCode: 0, previewReady: true }
            : {};
      return { content: [{ type: 'text' as const, text: JSON.stringify(structured) }], structuredContent: structured };
    }),
  };
});

vi.mock('./container', () => ({
  drainPreviewIssues: () => [],
  clearPreviewIssues: () => undefined,
  listPreviews: () => [{ port: 5173, url: 'http://preview', ready: true }],
  getContainer: () => Promise.reject(new Error('no container in unit tests')),
}));

vi.mock('./project', () => ({
  projectStore: {
    generation: 1,
    files: {},
    requestTerminal: () => undefined,
    writeToTerminal: () => undefined,
    ensureLoaded: async () => undefined,
    drain: async () => undefined,
    subscribe: () => () => undefined,
    bumpGeneration: () => 2,
    isFileLocked: () => ({ locked: false }),
    isFolderLocked: () => ({ locked: false }),
  },
}));

const run = (overrides: Partial<Parameters<typeof import('./loop').runAgentTask>[0]> = {}) => {
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  return import('./loop').then(({ runAgentTask }) =>
    runAgentTask({
      prompt: 'build a solar system scene',
      history: [],
      baseUrl: 'http://provider',
      apiKey: 'k',
      model: 'm',
      maxRounds: 8,
      emit: (event) => events.push(event as never),
      ...overrides,
    }).then((text) => ({ text, events })),
  );
};

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: `call-${name}-${executed.length}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

describe('agent loop end to end', () => {
  beforeEach(() => {
    script.length = 0;
    sentMessages.length = 0;
    executed.length = 0;
    executable = new Set([
      'project_read_file',
      'project_write_file',
      'project_list_paths',
      'project_run_command',
      'project_get_process_output',
      'project_stop_process',
      'project_replace_lines',
    ]);
  });

  it('executes the plan -> edit -> run -> check -> complete sequence the gate asks for', async () => {
    script.push(
      {
        reasoning: 'I need to look at the project first.',
        tool_calls: [call('project_list_paths')],
      },
      {
        tool_calls: [
          call('agent_plan', {
            goal: 'a rotating earth',
            steps: ['write index.html', 'run the dev server', 'check it loads'],
            criteria: [{ id: 'c1', description: 'page renders a rotating earth' }],
            requiresPreview: true,
          }),
        ],
      },
      { tool_calls: [call('project_write_file', { path: 'index.html', content: '<html></html>' })] },
      { tool_calls: [call('project_run_command', { command: 'npm run dev', purpose: 'run' })] },
      { tool_calls: [call('project_run_command', { command: 'npm run check', purpose: 'test' })] },
      { tool_calls: [call('agent_complete', { outcome: 'complete', summary: 'done', criteria: [{ id: 'c1' }] })] },
      { content: 'The earth is rendering in the preview.' },
    );

    const { text, events } = await run();

    expect(text).toBe('The earth is rendering in the preview.');
    // Every tool the model was handed is callable — the failure that broke the gate.
    expect(executed.map((entry) => entry.name)).toEqual([
      'project_list_paths',
      'project_write_file',
      'project_run_command',
      'project_run_command',
    ]);
    expect(events.some((event) => event.kind === 'gate')).toBe(false);
    expect(events.some((event) => event.kind === 'error')).toBe(false);
    // No "no final answer" noise on working tool-calling turns.
    expect(events.filter((event) => event.kind === 'log' && String(event.text).includes('no final answer'))).toEqual([]);
  });

  it('refuses agent_complete until a check has passed, then lets it through', async () => {
    script.push(
      { tool_calls: [call('agent_plan', { goal: 'g', steps: ['s'], criteria: [{ id: 'c1', description: 'd' }], requiresPreview: true })] },
      { tool_calls: [call('project_write_file', { path: 'a.js', content: 'x' })] },
      // Premature: no run and no check yet.
      { tool_calls: [call('agent_complete', { outcome: 'complete', summary: 'looks fine', criteria: [{ id: 'c1' }] })] },
      { tool_calls: [call('project_run_command', { command: 'node a.js', purpose: 'run' })] },
      { tool_calls: [call('project_run_command', { command: 'node --check a.js', purpose: 'test' })] },
      { tool_calls: [call('agent_complete', { outcome: 'complete', summary: 'verified', criteria: [{ id: 'c1' }] })] },
      { content: 'Done and verified.' },
    );

    const { text, events, } = await run();
    expect(text).toContain('Done and verified.');
    const rejections = events.filter(
      (event) => event.kind === 'tool' && String(event.output).includes('purpose "run"'),
    );
    expect(rejections.length).toBeGreaterThan(0);
  });

  it('nudges at most MAX_GATE_NUDGES times, then stops with a truthful message', async () => {
    // A model that keeps answering in prose without ever calling a tool.
    for (let i = 0; i < 12; i += 1) {
      script.push({ content: `Alright, working on it (${i}).` });
    }

    const { text, events } = await run({ maxRounds: 12 });
    const nudges = events.filter((event) => event.kind === 'gate');
    expect(nudges).toHaveLength(MAX_GATE_NUDGES + 1); // the last one is terminal
    expect(text).toContain('Stopped before the task was verified');
    // And the nudge actually reached the model as the next required action.
    const lastUser = sentMessages.at(-1)?.at(-1);
    expect(JSON.stringify(lastUser)).toContain('NEXT REQUIRED ACTION');
  });

  it('diagnoses a reasoning-only turn instead of silently reporting nothing', async () => {
    script.push(
      {
        content: '',
        reasoning: 'Let me plan this carefully: first, second, third…',
        usage: { completion_tokens: 30000, completion_tokens_details: { reasoning_tokens: 30000 } },
      },
      { tool_calls: [call('project_list_paths')] },
      { content: 'Here is the project.' },
    );

    const { text, events } = await run({ maxRounds: 4 });
    expect(events.some((event) => event.kind === 'log' && String(event.text).includes('reasoned without answering'))).toBe(
      true,
    );
    expect(text).toBe('Here is the project.');
  });

  it('reports each upstream request once, so the quota shown is real', async () => {
    script.push(
      { content: 'Thinking about it.' },
      { tool_calls: [call('project_list_paths')] },
      { content: 'Listing done.' },
      { content: 'Listing done again.' },
      { content: 'And again.' },
      { content: 'And again.' },
      { content: 'And again.' },
      { content: 'And again.' },
    );
    let stats: { roundsUsed: number; roundsAllowed: number; upstreamCalls: number } | undefined;
    const { events } = await run({ maxRounds: 8, onStats: (next) => (stats = next) });
    const roundsSeen = events.filter((event) => event.kind === 'round').length;
    expect(stats?.upstreamCalls).toBe(roundsSeen);
    expect(stats?.roundsUsed).toBe(roundsSeen);
  });
});

describe('batching: many tool calls per request', () => {
  beforeEach(() => {
    script.length = 0;
    sentMessages.length = 0;
    executed.length = 0;
    executable = new Set([
      'project_write_file',
      'project_run_command',
      'project_list_paths',
      'agent_plan',
    ]);
  });

  it('runs every call in one response without asking the model again', async () => {
    script.push(
      { tool_calls: [call('project_list_paths')] },
      {
        tool_calls: [
          call('agent_plan', {
            goal: 'three files',
            steps: ['write a', 'write b', 'write c', 'run'],
            criteria: [{ id: 'c1', description: 'files exist' }],
            requiresPreview: false,
          }),
        ],
      },
      // One response, three writes: this is the whole point. Three requests become one.
      {
        tool_calls: [
          call('project_write_file', { path: 'a.txt', content: 'a' }),
          call('project_write_file', { path: 'b.txt', content: 'b' }),
          call('project_write_file', { path: 'c.txt', content: 'c' }),
        ],
      },
      { tool_calls: [call('project_run_command', { command: 'npm test', purpose: 'test' })] },
      { tool_calls: [call('agent_complete', { outcome: 'complete', summary: 'ok', criteria: [{ id: 'c1' }] })] },
      { content: 'done' },
    );

    const { events } = await run({ maxToolCallsPerRound: 8 });

    expect(executed.filter((entry) => entry.name === 'project_write_file')).toHaveLength(3);
    // The three writes were dispatched from a single assistant turn, in the order asked.
    const writeTurn = sentMessages.find((messages) =>
      messages.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)),
    );
    const assistantTurns = sentMessages
      .flat()
      .filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls));
    const batched = assistantTurns.find((turn) => (turn.tool_calls as unknown[]).length === 3);
    expect(batched).toBeTruthy();
    expect(writeTurn).toBeTruthy();
    expect(events.some((event) => event.kind === 'log' && String(event.text).includes('request'))).toBe(true);
  });

  it('respects the per-response ceiling and says so instead of truncating silently', async () => {
    script.push(
      { tool_calls: [call('project_list_paths')] },
      {
        tool_calls: [
          call('agent_plan', {
            goal: 'two files',
            steps: ['write a', 'write b', 'run'],
            criteria: [{ id: 'c1', description: 'files exist' }],
            requiresPreview: false,
          }),
        ],
      },
      {
        tool_calls: [
          call('project_write_file', { path: 'a.txt', content: 'a' }),
          call('project_write_file', { path: 'b.txt', content: 'b' }),
        ],
      },
      { content: 'I ran out of room for the second file.' },
    );

    const { events } = await run({ maxToolCallsPerRound: 1 });

    expect(executed.filter((entry) => entry.name === 'project_write_file')).toHaveLength(1);
    expect(
      events.some(
        (event) => event.kind === 'log' && String(event.text).includes('asked for 2 tool calls'),
      ),
    ).toBe(true);
  });

  it('drops parallel tool calls when the caller turns batching off', async () => {
    const { callModel } = await import('./provider');
    script.push({ content: 'nothing to do' });
    await run({ parallelToolCalls: false });
    // The provider mock is module-level, so its call list spans every test in this file.
    const calls = (callModel as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const request = calls[calls.length - 1][0];
    expect(request.parallelToolCalls).toBe(false);
  });
});

describe('token accounting', () => {
  beforeEach(() => {
    script.length = 0;
    sentMessages.length = 0;
    executed.length = 0;
    executable = new Set(['project_list_paths']);
  });

  it('counts tokens across every turn, including reasoning tokens', async () => {
    script.push(
      {
        tool_calls: [call('project_list_paths')],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          completion_tokens_details: { reasoning_tokens: 25 },
        },
      },
      { content: 'nothing here', usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 } },
    );

    const { events } = await run({ maxRounds: 2 });
    const usage = events.filter((event) => event.kind === 'usage').pop() as unknown as {
      promptTokens: number;
      completionTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      requests: number;
      toolCalls: number;
      reported: boolean;
    };

    expect(usage.reported).toBe(true);
    expect(usage.totalTokens).toBe(300);
    expect(usage.promptTokens).toBe(250);
    expect(usage.completionTokens).toBe(50);
    expect(usage.reasoningTokens).toBe(25);
    expect(usage.toolCalls).toBe(1);
    expect(usage.requests).toBeGreaterThanOrEqual(2);
  });

  it('marks the count as a floor when the provider reports no usage', async () => {
    script.push({ content: 'no usage field here' });
    const { events } = await run({ maxRounds: 1 });
    const usage = events.filter((event) => event.kind === 'usage').pop() as unknown as {
      reported: boolean;
      totalTokens: number;
    };
    expect(usage.reported).toBe(false);
    expect(usage.totalTokens).toBe(0);
  });

  it('clamps the batch ceiling into a sane range', async () => {
    const { clampBatch, MIN_BATCH, MAX_BATCH, DEFAULT_BATCH } = await import('./mode');
    expect(clampBatch(0)).toBe(DEFAULT_BATCH);
    expect(clampBatch('nonsense')).toBe(DEFAULT_BATCH);
    expect(clampBatch(2)).toBe(2);
    expect(clampBatch(999)).toBe(MAX_BATCH);
    expect(clampBatch(-4)).toBe(DEFAULT_BATCH);
    expect(MIN_BATCH).toBe(1);
  });
});
