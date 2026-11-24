// ============================================================================
// Workspace bootstrap.
//
// A fresh WebContainer has an empty workdir. A project that begins with a
// package.json, a README that states the rules of this sandbox, and an
// .npmrc keeps the model from burning rounds on avoidable mistakes (and keeps
// `npm install` quiet about update checks).
// ============================================================================
import { getContainer, mkdir, pathExists, writeTextFile } from './container';
import { loadProject } from './persist';
import { projectStore } from './project';
import { WORKSPACE_ROOT } from './path';

const PACKAGE_JSON = {
  name: 'solara-project',
  private: true,
  version: '0.0.0',
  type: 'module',
  scripts: {
    dev: 'vite',
    build: 'vite build',
    preview: 'vite preview',
  },
};

const NPMRC = ['fund=false', 'audit=false', 'update-notifier=false', 'progress=false', ''].join('\n');

const README = [
  '# Solara project',
  '',
  'This workspace is a WebContainer: Node.js running in your browser tab.',
  '',
  '- Nothing here is stored on the Solara server, and nothing survives clearing site data.',
  '- `npm install` fetches through StackBlitz\u2019s registry proxy, so it needs a network connection.',
  '- Only Node.js is available \u2014 no Python, no system packages, no persistent disk.',
  '- `package.json` sets `"type": "module"`, so use `import` in `.js` files (or `require` in a `.cjs` file).',
  '- The shell already starts inside the project: run `cat proof.txt`, not `cat /workspace/proof.txt`.',
  '- Same rule inside your code: `fs.readFileSync(\'index.html\')`, not `\'/workspace/index.html\'` \u2014 that path',
  '  does not exist at runtime. The project root is this directory; the tools call it `/workspace`.',
  '',
].join('\n');

/** Idempotent: package.json, README.md and .npmrc exist after this returns. */
export async function ensureWorkspace(): Promise<void> {
  await getContainer();
  await mkdir(WORKSPACE_ROOT);
  if (!(await pathExists(`${WORKSPACE_ROOT}/package.json`))) {
    await writeTextFile(`${WORKSPACE_ROOT}/package.json`, `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`);
  }
  if (!(await pathExists(`${WORKSPACE_ROOT}/README.md`))) {
    await writeTextFile(`${WORKSPACE_ROOT}/README.md`, README);
  }
  if (!(await pathExists(`${WORKSPACE_ROOT}/.npmrc`))) {
    await writeTextFile(`${WORKSPACE_ROOT}/.npmrc`, NPMRC);
  }
}

/**
 * The one entry point the panel calls on open. Order is load-bearing:
 *   1. restore the persisted project (a reload must not look like an empty sandbox),
 *   2. scaffold package.json / README / .npmrc only where nothing exists,
 *   3. index the result into the store the tools work from.
 * Restoring first means a project the agent built is never overwritten by the
 * scaffold defaults.
 */
export async function bootWorkspace(): Promise<{ restored: number; tracked: number }> {
  const stored = await loadProject();
  if (stored && Object.keys(stored.files).length > 0) {
    await projectStore.replaceAll(stored.files);
    for (const [path, content] of Object.entries(stored.files)) {
      try {
        await writeTextFile(path, content);
      } catch {
        // a path the store accepted but the fs rejected: skip it, keep booting
      }
    }
  }
  await ensureWorkspace();
  await projectStore.refresh();
  projectStore.loadLocks();
  return { restored: Object.keys(stored?.files ?? {}).length, tracked: Object.keys(projectStore.files).length };
}
