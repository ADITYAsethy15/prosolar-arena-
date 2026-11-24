// ============================================================================
// Snapshot the workspace into one self-contained document.
//
// The preview URL cannot leave this tab (it is a StackBlitz proxy bound to the live
// container), but the files behind it can, so we resolve them here and inline them.
// A production build is preferred over the source entry, because that is the version
// with no dev-server dependencies left in it.
//
// `import './style.css'` and bare specifiers are bundler features. A Vite project that
// has never been built therefore cannot be snapshotted from source no matter how good
// the inliner is — so the panel is allowed to build it first, in the container, and
// snapshot the result. The build deliberately goes through `shell.run`, which means it
// shows up in the terminal exactly like an agent-initiated build.
// ============================================================================
import { readBytes } from './container';
import { buildStandaloneHtml, type SnapshotResult } from './snapshot';
import { runShell } from './runner';
import { WORKSPACE_ROOT } from './path';

const CANDIDATES = [
  `${WORKSPACE_ROOT}/dist/index.html`,
  `${WORKSPACE_ROOT}/build/index.html`,
  `${WORKSPACE_ROOT}/index.html`,
  `${WORKSPACE_ROOT}/public/index.html`,
];

async function readOrNull(abs: string): Promise<Uint8Array | null> {
  try {
    return await readBytes(abs);
  } catch {
    return null;
  }
}

async function buildCommandFor(pkgJsonText: string | null): Promise<string> {
  if (!pkgJsonText) {
    return 'npx vite build';
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgJsonText) as Record<string, unknown>;
  } catch {
    return 'npx vite build';
  }
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  if (typeof scripts.build === 'string' && scripts.build.trim()) {
    return 'npm run build';
  }
  const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) };
  if (deps && typeof deps === 'object' && 'vite' in deps) {
    return 'npx vite build';
  }
  return '';
}

export async function snapshotWorkspace(opts: { buildFirst?: boolean } = {}): Promise<SnapshotResult> {
  if (opts.buildFirst) {
    const pkgBytes = await readOrNull(`${WORKSPACE_ROOT}/package.json`);
    const cmd = await buildCommandFor(pkgBytes ? new TextDecoder().decode(pkgBytes) : null);
    if (!cmd) {
      throw new Error(
        'no "build" script in package.json and no vite dependency — nothing to build. Snapshot from source still works for plain JS.',
      );
    }
    const built = await runShell(cmd, { timeoutMs: 240_000 });
    if (built.exitCode !== 0) {
      throw new Error(
        `build failed (${cmd}, exit ${built.exitCode}):\n${built.output.slice(-3000) || 'no output'}`,
      );
    }
  }

  let entry = '';
  let text = '';
  for (const candidate of CANDIDATES) {
    const bytes = await readOrNull(candidate);
    if (bytes) {
      entry = candidate;
      text = new TextDecoder().decode(bytes);
      break;
    }
  }
  if (!entry) {
    throw new Error(
      'nothing to snapshot yet: the workspace has no index.html (or dist/index.html). Ask the agent to build one, or use serve to view it in this tab.',
    );
  }

  const result = await buildStandaloneHtml(entry, text, readOrNull);
  if (result.needsBuild && !opts.buildFirst) {
    // Not a failure — the page will simply be missing whatever needed a bundler. Say so in a
    // way the panel can turn into a button, instead of shipping a blank-looking copy.
    result.skipped.push({
      ref: 'build',
      path: entry,
      reason: 'this entry needs a bundler — press "build then open" for a faithful copy',
    });
  }
  return result;
}
