import { getContainer } from './container';

export const OUTPUT_CAP = 100_000;
// 45s was the original default and is too tight: a real `npm i -D vitest` inside
// a WebContainer measured ~38-40s (33 packages), so the cap would have killed a
// successful install by a 5s margin and handed the model a mystery timeout.
// Installs get their own budget; everything else stays capped so a runaway
// watcher/dev-server can't hang the panel forever.
export const DEFAULT_TIMEOUT_MS = 120_000;
export const PACKAGE_MANAGER_TIMEOUT_MS = 300_000;
const PYTHON_LIKE = /^(python3?|pip3?|pipx|pytest|conda)\b/;
const PACKAGE_MANAGER = /^(npm|npx|pnpm|yarn|bun)\b/;

export type RunResult = { exitCode: number; output: string };

/**
 * One shell command, inside /workspace, with a hard wall on both time and
 * volume. Truncation and timeout are reported in-band so the model can see them
 * and adjust, instead of the UI swallowing them.
 */
// Bolt.diy's action runner turns raw shell failures into a hint the *model*
// reads, which stops agents from re-issuing the same doomed command. Same idea,
// populated with what this sandbox actually measured (no egress, Node-only).
const ERROR_HINTS: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /command not found/i,
    hint:
      'this shell is jsh: only Node, npm/npx and basic sh builtins exist — there is no apt and no `sleep`, `nohup`, `timeout` or `curl` for external hosts. Background with `&`, and use `node -e` instead of shell utilities.',
  },
  {
    pattern: /No such file or directory/i,
    hint:
      'the shell starts inside the workspace, so use bare relative paths (`src/app.js`), not `/workspace/src/app.js`; run `ls` to see what is actually here.',
  },
  {
    // The scaffold sets "type": "module", and `require(...)` is still the most common thing
    // a model writes for a quick server or script — so this one costs a round on every run
    // unless it is named. Both escapes are stated so the model can just pick one.
    pattern: /require is not defined|Cannot use import statement outside a module|Must use import to load ES Module/i,
    hint:
      'this workspace is an ES module (package.json has "type":"module"): use `import http from \'node:http\'`, or name the file server.cjs to keep require().',
  },
  {
    pattern: /EAI_AGAIN|ENOTFOUND|getaddrinfo|ERR_NAME_NOT_RESOLVED|NetworkError|Failed to fetch|socket hang up|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i,
    hint:
      'the sandbox cannot reach external hosts (measured: blocked) — only npm installs work, via the registry proxy. But loopback IS reachable: `curl -s localhost:3000` against your own dev server works (measured), so test your server locally instead of giving up.',
  },
  {
    pattern: /Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i,
    hint: 'run `npm i <package>` first, or reference a local file with a ./ prefix.',
  },
  { pattern: /missing script: (test|dev|build)/i, hint: 'add it to /workspace/package.json, or call the tool directly (`npx vitest run`).' },
  { pattern: /Is a directory/i, hint: 'use `ls <dir>` instead of reading it as a file.' },
  { pattern: /Permission denied/i, hint: 'run it through its interpreter, e.g. `node script.js`.' },
  { pattern: /429|rate limit|too many requests/i, hint: 'the model provider is throttling; wait a few seconds before retrying.' },
];

function hintFor(cmd: string, output: string): string | null {
  for (const { pattern, hint } of ERROR_HINTS) {
    if (pattern.test(output)) {
      return hint;
    }
  }
  if (/^(npm|npx)\b/.test(cmd)) {
    return 'npm/npx failures here are usually a missing `npm i` or a package needing native binaries, which WebContainer cannot build.';
  }
  return null;
}

/**
 * The jail's virtual root is NOT a path the shell can see. WebContainer resolves fs paths
 * *and* spawn cwd relative to `workdir`, so `/workspace/x` inside a command is a dead end
 * even when the file is sitting right there — measured in-browser: `cat /workspace/probe.txt`
 * fails with ENOENT in the same round where `cat probe.txt` returns its contents. Models
 * write that prefix constantly (one Kilo task burned 6 rounds on it), so translate it to the
 * shell's real cwd and report the translation instead of doing it silently.
 */
function normalizeShellPaths(cmd: string): { cmd: string; rewrites: number } {
  let rewrites = 0;
  // Split on quoted runs and rewrite only the unquoted ones: a model that writes
  // `echo "see /workspace/x"` means the literal text, and mangling it can corrupt a file
  // it is about to write (measured: an echoed path came back as `./x`).
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
 * A backgrounded command (`node server.js &`, `cmd & sleep 2`) keeps the WebContainer spawn
 * open even after `sh` itself exits — measured: such a round hung for 80+ s and my own
 * timeout killer then killed the very server the user wanted to preview. Same for dev
 * servers, which simply never exit. So detect them and return once they settle.
 */
function hasBackgroundOperator(cmd: string): boolean {
  // Only outside quotes, and after removing `&&`, `&>` and fd redirects like `2>&1`,
  // none of which mean "run this in the background".
  for (const seg of cmd.split(/('[^']*'|"[^"]*")/).filter((_v, i) => i % 2 === 0)) {
    if (/&/.test(seg.replace(/&&|&>|\d*>&\d/g, ' '))) {
      return true;
    }
  }
  return false;
}

const DEV_SERVER = /^\s*(?:npm|pnpm|yarn|bun)\s+run\s+(?:dev|start|serve|watch)\b|^\s*npx\s+(?:vite|next|nodemon|http-server)\b|\b(?:node|deno|bun)\s+[^;&|]*\b(?:serve|server|dev|watch)\b/i;

/** How long a backgrounded command gets to fail loudly (syntax error, port busy). */
const BACKGROUND_GRACE_MS = 2_500;

export async function runShell(
  cmd: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const trimmed = String(cmd ?? '').trim();
  if (!trimmed) {
    return { exitCode: 1, output: 'empty command' };
  }
  if (opts.signal?.aborted) {
    // Stop was pressed while this call was queued behind another round.
    return { exitCode: 130, output: 'stopped before the command started' };
  }
  if (PYTHON_LIKE.test(trimmed)) {
    return {
      exitCode: 1,
      output: 'Python is not available in this sandbox (Node.js only).',
    };
  }

  const { cmd: shellCmd, rewrites } = normalizeShellPaths(trimmed);
  const backgrounded = hasBackgroundOperator(shellCmd) || DEV_SERVER.test(shellCmd);
  const timeoutMs =
    opts.timeoutMs ?? (PACKAGE_MANAGER.test(shellCmd) ? PACKAGE_MANAGER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const container = await getContainer();
  const proc = await container.spawn('sh', ['-c', shellCmd], {
    cwd: '/workspace',
    env: { FORCE_COLOR: '0', NO_COLOR: '1', npm_config_yes: 'true' },
  });

  // WebContainer hands over already-decoded text (output: ReadableStream<string>),
  // stdout and stderr merged, so no manual decoding here.
  let output = '';
  let truncated = false;
  const collect = (chunk: string) => {
    if (truncated) {
      return;
    }
    output += chunk;
    if (output.length > OUTPUT_CAP) {
      output = output.slice(0, OUTPUT_CAP);
      truncated = true;
    }
  };

  // --- the stop button, which used to be inert here ------------------------------------
  // Until v10 the abort signal only reached the provider fetch, so pressing stop during a
  // tool round did nothing until the command finished on its own — up to 120s, or 300s for
  // `npm i`, which is exactly how "the stop button is not working" got reported. Killing the
  // process is the only way to shorten a spawn, and it works (WebContainer has no SIGINT).
  let aborted = false;
  let releaseAbort: () => void = () => {};
  // Same shape as the background grace result, so `settled: false` keeps a stopped
  // backgrounded command from also claiming it was "left running".
  const abortRace = new Promise<{ code: number; settled: boolean }>((resolve) => {
    releaseAbort = () => resolve({ code: -1, settled: false });
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
  const detachAbort = () => {
    try {
      opts.signal?.removeEventListener('abort', onAbort);
    } catch {
      // no-op
    }
  };

  // WebContainer always wires stdout/stderr; piping is the only read path.
  void proc.output.pipeTo(new WritableStream({ write: collect })).catch(() => undefined);

  let timedOut = false;
  // A long-lived server is the whole point of a backgrounded command: no killer for those.
  const killer = backgrounded
    ? null
    : setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          // already exited
        }
      }, timeoutMs);

  let exitCode = -1;
  try {
    if (backgrounded) {
      const exited = proc.exit.then((code) => ({ code: Number(code), settled: false }));
      const grace = new Promise<{ code: number; settled: boolean }>((resolve) => {
        setTimeout(() => resolve({ code: 0, settled: true }), BACKGROUND_GRACE_MS);
      });
      // Even the 2.5s "did it crash on boot?" grace must not hold up a stop.
      const first = await Promise.race([exited, grace, abortRace]);
      exitCode = first.code;
      if (first.settled) {
        // Let the last few chunks land before we read `output` (the server's own
        // "listening on 3000" line is usually what the model needs to see next).
        await new Promise((r) => setTimeout(r, 400));
        output += `\n[backgrounded: left running — the Preview tab follows its port; use \`kill\` to stop it]`;
      }
    } else {
      // A spawn that never exits (an un-backgrounded server) is exactly what a stop is for,
      // so the abort promise races the exit rather than waiting out a timeout nobody wants.
      const raced = await Promise.race([proc.exit, abortRace]);
      exitCode = typeof raced === 'number' ? raced : -1;
    }
  } catch (err) {
    output += `\nspawn error: ${String((err as Error)?.message ?? err)}`;
  }
  if (killer) {
    clearTimeout(killer);
  }
  detachAbort();
  if (aborted) {
    return {
      exitCode: 130,
      output: `${output}\n[stopped: you pressed stop — this command was killed mid-run. A server left\n  running by an earlier round keeps serving; that is deliberate, stopping it would take your preview away]`.trim(),
    };
  }

  let tail = '';
  if (rewrites > 0) {
    // Naming the translation is what makes this debuggable when it surprises someone.
    tail += `\n[note] rewrote ${rewrites} /workspace/ path(s) to . — the shell already starts inside the workspace`;
  }
  if (exitCode !== 0) {
    const hint = hintFor(shellCmd, output);
    if (hint) {
      tail += `\n[hint] ${hint}`;
    }
  }
  if (truncated) {
    tail += `\n[output truncated at ${OUTPUT_CAP} chars]`;
  }
  if (timedOut) {
    tail += `\n[killed: exceeded ${Math.round(timeoutMs / 1000)}s timeout]`;
  }
  return { exitCode: timedOut ? 124 : exitCode, output: (output + tail).trim() || '(no output)' };
}
