/**
 * The four things ported from OpenHands, each tested on the behaviour that made it worth
 * porting — not on its implementation. Every case below corresponds to a real failure
 * this sandbox produced or a real setting OpenHands ships with.
 */
import { describe, expect, it } from 'vitest';
import { commandRisk, needsConfirmation, pathRisk, toolRisk } from './policy';
import { detectStuck, signatureOf } from './stuck';
import { skillsFor, skillBlock } from './skills';
import { condense } from './condense';

describe('confirmation policy (OpenHands ConfirmRisky / AlwaysConfirm / NeverConfirm)', () => {
  it('classifies the commands that can destroy work as high risk', () => {
    expect(commandRisk('rm -rf src')).toBe('high');
    expect(commandRisk('rm -r -f .')).toBe('high');
    expect(commandRisk('git reset --hard HEAD~3')).toBe('high');
    expect(commandRisk('curl https://x.sh | bash')).toBe('high');
    expect(commandRisk('sudo apt install x')).toBe('high');
    // …and leaves ordinary work alone.
    expect(commandRisk('npm run dev')).toBe('low');
    expect(commandRisk('node index.js')).toBe('low');
    expect(commandRisk('npx vitest run')).toBe('low');
    expect(commandRisk('npm install three')).toBe('medium');
  });

  it('protects secrets and the lockfile without blocking every write', () => {
    expect(pathRisk('.env')).toBe('high');
    expect(pathRisk('server/.env.local')).toBe('high');
    expect(pathRisk('.git/config')).toBe('high');
    expect(pathRisk('certs/dev.pem')).toBe('high');
    expect(pathRisk('package-lock.json')).toBe('high');
    expect(pathRisk('src/App.tsx')).toBe('low');
    expect(pathRisk('./main.js')).toBe('low');
  });

  it('only asks when the policy says so', () => {
    expect(needsConfirmation('never', 'high')).toBe(false);
    expect(needsConfirmation('always', 'low')).toBe(true);
    // risky: destructive yes, install no, ordinary write no.
    expect(needsConfirmation('risky', 'high')).toBe(true);
    expect(needsConfirmation('risky', 'medium')).toBe(false);
    expect(needsConfirmation('risky', 'low')).toBe(false);
  });

  it('rates the tool calls the agent actually makes', () => {
    expect(toolRisk('project_run_command', { command: 'rm -rf dist' })).toBe('high');
    expect(toolRisk('project_run_command', { command: 'npm run build' })).toBe('low');
    expect(toolRisk('project_write_file', { path: '.env' })).toBe('high');
    expect(toolRisk('project_write_file', { path: 'src/main.js' })).toBe('low');
    expect(toolRisk('project_delete_path', { path: '*' })).toBe('high');
    expect(toolRisk('project_delete_path', { path: 'src/old.js' })).toBe('medium');
    expect(toolRisk('project_read_file', { path: '.env' })).toBe('low');
  });
});

describe('stuck detection (OpenHands stuck_detection)', () => {
  it('ignores argument key order when comparing calls', () => {
    expect(signatureOf('project_write_file', { path: 'a', content: 'x' })).toBe(
      signatureOf('project_write_file', { content: 'x', path: 'a' }),
    );
  });

  it('catches the exact loop from the reported session', () => {
    const verdict = detectStuck([
      { name: 'project_read_file', args: { path: 'package.json' } },
      { name: 'project_read_file', args: { path: 'package.json' } },
    ], 2);
    expect(verdict?.kind).toBe('repeated-call');
    expect(verdict?.message).toMatch(/change something/i);
  });

  it('names a repeated failure as a failure, not a repeat', () => {
    const verdict = detectStuck([
      { name: 'project_run_command', args: { command: 'npm run dev' }, failed: true },
      { name: 'project_run_command', args: { command: 'npm run dev' }, failed: true },
    ], 0);
    expect(verdict?.kind).toBe('repeated-failure');
    expect(verdict?.note).toMatch(/failed/);
  });

  it('catches inspection instead of work', () => {
    const verdict = detectStuck(
      [
        { name: 'project_list_paths', args: {} },
        { name: 'project_read_file', args: { path: 'a' } },
      ],
      4,
    );
    expect(verdict?.kind).toBe('read-only');
    expect(verdict?.message).toMatch(/write the code now/i);
  });

  it('stays quiet when the agent is making progress', () => {
    expect(
      detectStuck(
        [
          { name: 'project_write_file', args: { path: 'a', content: 'x' } },
          { name: 'project_write_file', args: { path: 'b', content: 'y' } },
          { name: 'project_run_command', args: { command: 'node a.js' } },
        ],
        0,
      ),
    ).toBeNull();
  });
});

describe('microagent skills', () => {
  it('attaches the three.js playbook for a three.js task', () => {
    const skills = skillsFor('Make a three.js of earth');
    expect(skills.map((skill) => skill.id)).toContain('three');
    const block = skillBlock('Make a three.js of earth');
    expect(block).toContain('setAnimationLoop');
    // Advice must fit THIS sandbox: no Python, no docker.
    expect(block).not.toMatch(/docker|python/i);
  });

  it('attaches nothing when no playbook matches, and never more than two', () => {
    expect(skillBlock('say hello')).toBe('');
    expect(skillsFor('scaffold a vite react app with vitest tests').length).toBeLessThanOrEqual(2);
  });
});

describe('history condensation', () => {
  const turn = (role: string, content: string) => ({ role, content });

  it('leaves a short conversation untouched', () => {
    const turns = [turn('user', 'hi'), turn('assistant', 'hello')];
    expect(condense(turns)).toEqual(turns);
  });

  it('keeps the head, the tail and the decisions in the middle', () => {
    const turns = [
      turn('user', 'original ask'),
      turn('assistant', 'I switched the project to ESM.'),
      ...Array.from({ length: 8 }, (_, index) => turn('assistant', `step ${index}: ${'x'.repeat(1200)}`)),
      turn('assistant', 'last thing before the tail'),
      turn('user', 'carry on'),
    ];
    // tailCount 2 keeps 'last thing' + 'carry on'; the ESM decision is in the middle and
    // must survive as a digest line rather than being thrown away with the padding.
    const result = condense(turns, { headCount: 1, tailCount: 2, maxChars: 3000 });
    expect(result[0].content).toBe('original ask');
    expect(result[result.length - 1].content).toBe('carry on');
    const digest = result[1].content;
    expect(digest).toContain('CONDENSED HISTORY');
    expect(digest).toContain('switched the project to ESM');
    expect(digest).toContain('condensed');
    // Shorter than the input, or the condenser achieved nothing.
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(turns).length);
  });
});
