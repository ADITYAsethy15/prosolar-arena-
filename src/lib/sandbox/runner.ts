// ============================================================================
// One shell command, one process, with a hard wall on time and volume.
//
// The agent's `project_run_command` goes through here (the project MCP bridge owns
// the process *registry*; this owns a single spawn). bolt.diy's ActionRunner does
// the same split. Two details are load-bearing:
//
//   * Timeouts and truncation are reported in-band, in the text the model reads,
//     so a killed command cannot be mistaken for a clean exit code 0.
//   * The abort signal kills the process. Until this existed, Stop only cancelled
//     the provider fetch and a `npm i` kept running for its full 300 s — which is
//     exactly how "the stop button does not work" got reported.
// ============================================================================
import type { WebContainerProcess } from '@webcontainer/api';
import { getContainer } from './container';
import { toContainerPath, WORKSPACE_ROOT } from './path';

export const OUTPUT_CAP = 100_000;
/** 45s was the original default and too tight: `npm i -D vitest` measured ~38-40s. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const PACKAGE_MANAGER_TIMEOUT_MS = 300_000;
export const BACKGROUND_GRACE_MS = 2_500;

const PYTHON_LIKE = /^(python3?|pip3?|pipx|pytest|conda)\b/;
const PACKAGE_MANAGER = /^(npm|npx|pnpm|yarn|bun)\b/;

export type RunResult = {
  exitCode: number;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  background: boolean;
};

/**
 * bolt.diy's action runner turns raw shell failures into a hint the *model* reads,
 * which stops agents from re-issuing the same doomed command. Same idea, populated
 * with what this sandbox actually measured (no egress, Node-only).
 */
const ERROR_HINTS: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /command not found/i,
    hint: 'this shell is jsh: only Node, npm/npx and basic sh builtins exist — there is no apt and no `timeout` or `curl` for external hosts. Background with `&`, and use `node -e` instead of shell utilities.',
  },
  {
    pattern: /No such file or directory/i,
    hint: 'the shell starts inside the project, so use bare relative paths (`src/app.js`), not `/workspace/src/app.js`; run `ls` to see what is actually here.',
  },
  {
    pattern: /require is not defined|Cannot use import statement outside a module|Must use import to load ES Module/i,
    hint: 'this project is an ES module (package.json has "type":"module"): use `import http from \'node:http\'`, or name the file server.cjs to keep require().',
  },
  {
    pattern: /EAI_AGAIN|ENOTFOUND|getaddrinfo|ERR_NAME_NOT_RESOLVED|NetworkError|Failed to fetch|socket hang up|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i,
    hint: 'the sandbox cannot reach external hosts (measured: blocked) — only npm installs work, via the registry proxy. But loopback IS reachable: `curl -s localhost:3000` against your own dev server works (measured), so test your server locally instead of giving up.',
  },
  {
    pattern: /Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i,
    hint: 'run `npm i <package>` first, or reference a local file with a ./ prefix.',
  },
  { pattern: /missing script: (test|dev|build)/i, hint: 'add it to package.json, or call the tool directly (`npx vitest run`).' },
  { pattern: /Is a directory/i, hint: 'use `ls <dir>` instead of reading it as a file.' },
  { pattern: /Permission denied/i, hint: 'run it through its interpreter, e.g. `node script.js`.' },
  { pattern: /429|rate limit|too many requests/i, hint: 'the model provider is throttling; wait a few seconds before retrying.' },
];

export function hintFor(cmd: string, output: string): string | null {
  for (const { pattern, hint } of ERROR_HINTS) {
    if (pattern.test(output)) {
      return hint;
    }
  }
  if (PACKAGE_MANAGER.test(cmd)) {
    return 'npm/npx failures here are usually a missing `npm install` or a package needing native binaries, which WebContainer cannot build.';
  }
  return null;
}

/**
 * WebContainer resolves fs paths *and* spawn cwd relative to its workdir, so
 * `/workspace/x` inside a command is a dead end even when the file is right there.
 * Models write that prefix constantly, so translate it and report the translation
 * instead of doing it silently.
 */
function normalizeShellPaths(cmd: string): { cmd: string; rewrites: number } {
  let rewrites = 0;
  const parts = cmd.split(/('[^']*'|"[^"]*")/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/(^|[\s;|(=>])\/workspace(\/|\b)/g, (_m, pre: string, sep: string) => {
      rewrites += 1;
      return sep === '/' ? `${pre}./` : `${pre}.`;
    });
  }
  return { cmd: parts.join(''), rewrites };
}

/**
 * A backgrounded command (`node server.js &`) keeps the spawn open even after `sh`
 * exits — measured: such a round hung for 80+ s and the timeout killer then killed
 * the very server the user wanted to preview. So detect them and return early.
 */
function hasBackgroundOperator(cmd: string): boolean {
  for (const seg of cmd.split(/('[^']*'|"[^"]*")/).filter((_v, i) => i % 2 === 0)) {
    if (/&/.test(seg.replace(/&&|&>|\d*>&\d/g, ' '))) {
      return true;
    }
  }
  return false;
}

const DEV_SERVER =
  /^\s*(?:npm|pnpm|yarn|bun)\s+run\s+(?:dev|start|serve|watch)\b|^\s*npx\s+(?:vite|next|nodemon|http-server)\b|\b(?:node|deno|bun)\s+[^;&|]*\b(?:serve|server|dev|watch)\b/i;

export function looksLikeDevServer(cmd: string): boolean {
  return DEV_SERVER.test(cmd);
}

export type RunOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Mirror output into the panel terminal as it arrives. */
  onOutput?: (chunk: string) => void;
  /** Resolve as soon as the process is up instead of waiting for it to exit. */
  background?: boolean;
};

export async function runShell(cmd: string, opts: RunOptions = {}): Promise<RunResult> {
  const trimmed = String(cmd ?? '').trim();
  const empty: RunResult = { exitCode: 1, output: 'empty command', timedOut: false, truncated: false, background: false };
  if (!trimmed) {
    return empty;
  }
  if (PYTHON_LIKE.test(trimmed)) {
    return { ...empty, output: 'Python is not available in this sandbox (Node.js only).' };
  }
  if (opts.signal?.aborted) {
    return { ...empty, exitCode: 130, output: 'stopped before the command started' };
  }

  const { cmd: shellCmd } = normalizeShellPaths(trimmed);
  const background = opts.background ?? (hasBackgroundOperator(shellCmd) || looksLikeDevServer(shellCmd));
  const timeoutMs =
    opts.timeoutMs ?? (PACKAGE_MANAGER.test(shellCmd) && !background ? PACKAGE_MANAGER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  const container = await getContainer();
  const proc: WebContainerProcess = await container.spawn('sh', ['-c', shellCmd], {
    cwd: toContainerPath(WORKSPACE_ROOT),
    env: { FORCE_COLOR: '0', NO_COLOR: '1', npm_config_yes: 'true', TERM: 'dumb' },
  });

  let output = '';
  let truncated = false;
  const collect = (chunk: string) => {
    opts.onOutput?.(chunk);
    if (truncated) {
      return;
    }
    output += chunk;
    if (output.length > OUTPUT_CAP) {
      output = output.slice(0, OUTPUT_CAP);
      truncated = true;
    }
  };
  void proc.output.pipeTo(new WritableStream<string>({ write: collect })).catch(() => undefined);

  let aborted = false;
  let releaseAbort = () => {};
  const abortRace = new Promise<'aborted'>((resolve) => {
    releaseAbort = () => resolve('aborted');
  });
  const onAbort = () => {
    aborted = true;
    try {
      proc.kill();
    } catch {
      // already exited on its own
    }
    releaseAbort();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const detach = () => {
    try {
      opts.signal?.removeEventListener('abort', onAbort);
    } catch {
      // no-op
    }
  };

  let timedOut = false;
  const killer =
    background || aborted
      ? null
      : setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            // already exited
          }
        }, timeoutMs);

  try {
    if (background) {
      // No killer: a long-lived server is the whole point. But it must not hold the
      // round open, so settle after a short grace unless it already crashed.
      const exited = proc.exit.then((code) => Number(code));
      const grace = new Promise<'grace'>((resolve) => setTimeout(() => resolve('grace'), BACKGROUND_GRACE_MS));
      const first = await Promise.race([exited, grace, abortRace]);
      if (first === 'grace') {
        // Let the last chunks land: the server's own "listening on 3000" line is
        // usually what the model needs to see next.
        await new Promise((r) => setTimeout(r, 250));
        return { exitCode: 0, output: output.trim(), timedOut: false, truncated, background: true };
      }
      return {
        exitCode: first === 'aborted' ? 130 : first,
        output: output.trim(),
        timedOut: false,
        truncated,
        background: true,
      };
    }

    const code = await Promise.race([proc.exit.then((value) => Number(value)), abortRace]);
    await new Promise((r) => setTimeout(r, 60));
    const exitCode = code === 'aborted' ? 130 : code;
    let text = output.trim();
    if (timedOut) {
      text += `\n[killed after ${Math.round(timeoutMs / 1000)}s — the command did not finish]`;
    } else if (aborted) {
      text += '\n[stopped by the user]';
    }
    const hint = hintFor(shellCmd, text);
    if (hint) {
      text += `\n\n[hint] ${hint}`;
    }
    return { exitCode, output: text, timedOut, truncated, background: false };
  } finally {
    if (killer) {
      clearTimeout(killer);
    }
    detach();
  }
}
