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
