import { describe, expect, it } from 'vitest';
import { projectRelative, relPath, safePath, toContainerPath, toVirtualPath, WORK_DIR, WORKSPACE_ROOT } from './path';
import { countLines, getFileRevision, numberLines, replaceLines, replaceText, validateProjectSource } from './sourceCheck';
import { getProgress, completionProblems, nextInstruction, lineDiff, MAX_GATE_NUDGES, type AgentPlan } from './loop';
import { allToolDefsForProvider, parseToolArguments, AGENT_TOOL_NAMES, PROJECT_TOOL_NAMES } from './projectTools';
import { reasoningOnly } from './provider';

describe('path jail', () => {
  it('accepts both spellings of the project root', () => {
    expect(safePath('src/app.ts')).toBe('/workspace/src/app.ts');
    expect(safePath('/workspace/src/app.ts')).toBe('/workspace/src/app.ts');
    expect(safePath('/home/project/src/app.ts')).toBe('/workspace/src/app.ts');
    expect(safePath('./src//app.ts')).toBe('/workspace/src/app.ts');
  });

  it('refuses escapes and control characters', () => {
    expect(() => safePath('../etc/passwd')).toThrow(/unsafe path/);
    expect(() => safePath('/workspace/../../etc')).toThrow(/unsafe path/);
    expect(() => safePath('/etc/passwd')).toThrow(/unsafe path/);
    expect(() => safePath('src/\u0000bad')).toThrow(/control characters/);
    expect(() => safePath('   ')).toThrow(/empty/);
  });

  it('maps between the virtual root and the container workdir', () => {
    expect(toContainerPath('/workspace')).toBe(WORK_DIR);
    expect(toContainerPath('src/a.ts')).toBe(`${WORK_DIR}/src/a.ts`);
    expect(toVirtualPath(`${WORK_DIR}/src/a.ts`)).toBe('/workspace/src/a.ts');
    expect(toVirtualPath(WORK_DIR)).toBe(WORKSPACE_ROOT);
    expect(relPath('/workspace/src/a.ts')).toBe('src/a.ts');
    expect(projectRelative('/workspace')).toBe('.');
    expect(projectRelative('/workspace/src/a.ts')).toBe('src/a.ts');
  });
});

describe('source checks', () => {
  it('numbers lines the way the model is told to read them', () => {
    const content = 'a\nb\nc';
    expect(numberLines(content)).toEqual(['1: a', '2: b', '3: c']);
    expect(countLines('a\nb\n')).toBe(2);
  });

  it('replaces an inclusive line range and keeps the trailing newline', () => {
    const content = 'one\ntwo\nthree\n';
    expect(replaceLines(content, { start: 2, end: 2 }, 'TWO')).toBe('one\nTWO\nthree\n');
    expect(replaceLines(content, { start: 2, end: 3 }, 'tail')).toBe('one\ntail\n');
    expect(replaceLines(content, { start: 2, end: 2 }, '')).toBe('one\nthree\n');
  });

  it('rejects a range past the end of the file instead of silently clamping', () => {
    expect(() => replaceLines('one\ntwo\n', { start: 1, end: 9 }, 'x')).toThrow(/lineCount/);
    expect(() => replaceLines('one\ntwo\n', { start: 2, end: 1 }, 'x')).toThrow(/lineCount/);
  });

  it('requires oldText to match exactly once', () => {
    expect(replaceText('a b c', 'b', 'B')).toBe('a B c');
    expect(() => replaceText('a a', 'a', 'b')).toThrow(/ambiguous/);
    expect(() => replaceText('a b', 'zz', 'b')).toThrow(/was not found/);
  });

  it('hashes content stably', async () => {
    const one = await getFileRevision('export const x = 1;\n');
    const two = await getFileRevision('export const x = 1;\n');
    const three = await getFileRevision('export const x = 2;\n');
    expect(one).toBe(two);
    expect(one).not.toBe(three);
    expect(one).toMatch(/^[a-f0-9]{64}$/);
  });

  it('parses valid source and refuses broken source with a hint', async () => {
    await expect(validateProjectSource('a.ts', 'export const x: number = 1;\n')).resolves.toMatchObject({
      content: 'export const x: number = 1;\n',
    });
    await expect(validateProjectSource('a.tsx', 'export const A = () => <div>;\n')).rejects.toThrow(
      /Syntax check failed for a\.tsx/,
    );
    // Non-source files are never parsed.
    await expect(validateProjectSource('a.css', 'body { color: ')).resolves.toMatchObject({ content: 'body { color: ' });
  });
});

describe('completion gate', () => {
  const plan: AgentPlan = {
    goal: 'add a counter',
    steps: ['edit', 'run', 'check'],
    criteria: [{ id: 'c1', description: 'counter renders' }],
    requiresPreview: true,
  };

  // A call log that models one full successful task.
  const calls = (overrides: { skipTest?: boolean } = {}) => [
    {
      id: '1',
      name: 'agent_plan',
      args: {},
      failed: false,
      position: 1,
      result: { content: [], structuredContent: { plan } },
    },
    {
      id: '2',
      name: 'project_write_file',
      args: {},
      failed: false,
      position: 2,
      result: { content: [], structuredContent: { written: true, changed: true, path: 'src/App.tsx' } },
    },
    {
      id: '3',
      name: 'project_run_command',
      args: { purpose: 'run' },
      failed: false,
      position: 3,
      result: {
        content: [],
        structuredContent: { processId: 'p-1', purpose: 'run', status: 'running', previewReady: true },
      },
    },
    ...(overrides.skipTest
      ? []
      : [
          {
            id: '4',
            name: 'project_run_command' as const,
            args: { purpose: 'test' },
            failed: false,
            position: 4,
            result: {
              content: [],
              structuredContent: { processId: 'p-2', purpose: 'test', status: 'exited', exitCode: 0 },
            },
          },
        ]),
    {
      id: '5',
      name: 'agent_complete',
      args: {},
      failed: false,
      position: 5,
      result: { content: [], structuredContent: { completed: true, summary: 'done' } },
    },
  ];

  it('accepts a task that planned, edited, ran, checked and completed', () => {
    const progress = getProgress(calls(), 'add a counter', 5, false);
    expect(progress).toMatchObject({ status: 'ready', edited: true, ran: true, tested: true, previewReady: true });
    expect(completionProblems(progress)).toEqual([]);
  });

  it('rejects completion when the check ran before the last edit', () => {
    const log = calls();
    // Move the check ahead of the edit: the gate must notice the staleness.
    log[3].position = 1;
    const progress = getProgress(log, 'add a counter', 5, false);
    expect(progress.tested).toBe(false);
    expect(progress.status).toBe('pending');
    expect(completionProblems(progress).join(' ')).toMatch(/purpose "test"/);
  });

  it('refuses to call a task done with no plan, no run and no check', () => {
    const progress = getProgress(
      [{ id: '1', name: 'project_write_file', args: {}, failed: false, position: 1, result: { content: [], structuredContent: { written: true, changed: true } } }],
      'build me an app',
      1,
      false,
    );
    expect(progress.status).toBe('pending');
    expect(completionProblems(progress)).toHaveLength(3);
  });

  it('tells the model exactly what to do next at every stage', () => {
    expect(nextInstruction(getProgress([], 'build me an app', 0, false)).next).toBe('agent_plan');
    expect(getProgress([], 'what does src/App.tsx do?', 0, false).status).toBe('inactive');
    const installing = getProgress(
      [
        { id: '1', name: 'agent_plan', args: {}, failed: false, position: 1, result: { content: [], structuredContent: { plan } } },
        {
          id: '2',
          name: 'project_run_command',
          args: { purpose: 'install' },
          failed: false,
          position: 2,
          result: { content: [], structuredContent: { processId: 'p-9', purpose: 'install', status: 'running' } },
        },
      ],
      'add a dependency',
      2,
      false,
    );
    expect(nextInstruction(installing)).toMatchObject({ next: 'poll install' });
  });

  it('stops the model when the user denied an action', () => {
    const progress = getProgress([], 'build me an app', 1, true);
    expect(progress.status).toBe('blocked');
    expect(nextInstruction(progress).text).toMatch(/Explain the blocker/);
  });
});

// ============================================================================
// Regressions from a real session transcript: five runs in a row, every one of
// which reported "no final answer" and one of which was told by the gate to call a
// tool the harness itself rejected.
// ============================================================================

describe('agent tools are callable through the same path as project tools', () => {
  it('parses agent_plan instead of answering "Unknown project tool"', () => {
    const args = parseToolArguments('agent_plan', {
      goal: 'add a counter',
      steps: ['edit', 'run', 'check'],
      criteria: [{ id: 'c1', description: 'counter increments' }],
      requiresPreview: true,
    });
    expect(args.goal).toBe('add a counter');
    expect(args.requiresPreview).toBe(true);
  });

  it('parses agent_complete, including the blocked outcome', () => {
    expect(parseToolArguments('agent_complete', { outcome: 'complete', summary: 'done' }).outcome).toBe('complete');
    expect(parseToolArguments('agent_complete', { outcome: 'blocked', summary: 'no network' }).outcome).toBe('blocked');
  });

  it('still validates the schema and names the available tools on a typo', () => {
    expect(() => parseToolArguments('agent_plan', { goal: 'x' })).toThrow(/Invalid arguments for agent_plan/);
    expect(() => parseToolArguments('agent_plann', {})).toThrow(/Available tools: agent_plan, agent_complete/);
  });

  it('advertises every tool it can execute, and nothing else', () => {
    const advertised = allToolDefsForProvider().map((def) => def.function.name);
    const executable = [...AGENT_TOOL_NAMES, ...PROJECT_TOOL_NAMES];
    expect(advertised.slice().sort()).toEqual(executable.slice().sort());
    // The provider schema is generated from the same zod object the validator uses.
    const writeSchema = allToolDefsForProvider().find((def) => def.function.name === 'project_write_file');
    expect(JSON.stringify(writeSchema?.function.parameters)).toContain('"required":["path","content"]');
  });
});

describe('reasoning-only turns are diagnosed, not retried blindly', () => {
  it('recognises a turn that spent the budget thinking', () => {
    expect(
      reasoningOnly({
        content: '',
        toolCalls: [],
        finishReason: 'stop',
        reasoning: 'Let me think about the file layout…',
        usage: { completion_tokens: 30000, completion_tokens_details: { reasoning_tokens: 30000 } },
      }),
    ).toBe(true);
  });

  it('does not mistake prose, a tool call, or a plain empty turn for it', () => {
    expect(reasoningOnly({ content: 'here you go', toolCalls: [], finishReason: 'stop' })).toBe(false);
    expect(
      reasoningOnly({
        content: '',
        toolCalls: [{ id: '1', function: { name: 'project_list_paths', arguments: '{}' } }],
        finishReason: 'tool_calls',
      }),
    ).toBe(false);
    expect(reasoningOnly({ content: '', toolCalls: [], finishReason: 'stop', usage: null })).toBe(false);
  });
});

describe('diffs are what a user actually reads', () => {
  it('classifies added, removed and unchanged lines', () => {
    const diff = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(diff.filter((line) => line.kind === 'add').map((line) => line.text)).toEqual(['B']);
    expect(diff.filter((line) => line.kind === 'remove').map((line) => line.text)).toEqual(['b']);
    expect(diff.filter((line) => line.kind === 'same').map((line) => line.text)).toEqual(['a', 'c']);
  });

  it('collapses long unchanged stretches so the change stays visible', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 20', 'line 20 changed');
    const diff = lineDiff(before, after);
    // Two unchanged runs collapse to 3 lines + marker + 3 lines each, so the whole
    // rendering stays around a dozen rows no matter how long the file is.
    expect(diff.length).toBeLessThanOrEqual(18);
    expect(diff.some((line) => line.text.includes('unchanged line(s)'))).toBe(true);
    expect(diff.find((line) => line.kind === 'add')?.text).toBe('line 20 changed');
  });

  it('treats a brand-new file as all additions and an empty file as no diff', () => {
    expect(lineDiff('', 'x\ny').filter((line) => line.kind === 'add')).toHaveLength(2);
    expect(lineDiff('', '')).toEqual([]);
    expect(lineDiff('same', 'same')).toEqual([]);
  });

  it('does not hang on a pathologically large file', () => {
    const big = Array.from({ length: 2000 }, (_, index) => `l${index}`).join('\n');
    const started = Date.now();
    const diff = lineDiff(big, `${big}\nextra`);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(diff[diff.length - 1]).toEqual({ kind: 'add', text: 'extra' });
  });
});
