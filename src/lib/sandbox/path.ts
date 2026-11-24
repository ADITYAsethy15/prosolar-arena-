// Path jail for every sandbox filesystem and shell entry point.
//
// Two roots exist and the difference matters:
//   WORKSPACE_ROOT — the *virtual* root this app talks about ("/workspace"). Every
//                    tool argument, every UI path and every stored file path uses it.
//   containerRoot() — the *real* workdir inside WebContainer. boot() sets it to
//                    `/home/project` (bolt.diy does the same) because `path.relative`
//                    against `/home/project` yields clean project-relative paths.
//
// WebContainer resolves fs paths *and* spawn cwd relative to that workdir, so the
// jail's job is: accept either spelling from a model, and hand back a path the
// container can actually open.
export const WORKSPACE_ROOT = '/workspace';

/** The real container workdir. Kept in sync with `WORK_DIR_NAME` in container.ts. */
export const WORK_DIR_NAME = 'project';
export const WORK_DIR = `/home/${WORK_DIR_NAME}`;

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Normalise any model-supplied path to the virtual `/workspace/...` form.
 * Rejects control characters, `..` escapes and anything outside the two roots.
 */
export function safePath(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error('unsafe path: empty');
  }
  if (CONTROL.test(raw)) {
    throw new Error('unsafe path: control characters');
  }

  // Translate the container's own workdir spelling into the virtual root first:
  // models read `workdir` from a tool result and then echo `/home/project/src/x`.
  let abs = raw.startsWith('/') ? raw : `${WORKSPACE_ROOT}/${raw}`;
  if (abs === WORK_DIR || abs.startsWith(`${WORK_DIR}/`)) {
    abs = `${WORKSPACE_ROOT}${abs.slice(WORK_DIR.length)}`;
  }

  const parts = abs.split('/').filter(Boolean);
  if (parts[0] !== 'workspace') {
    throw new Error(`unsafe path: ${raw}`);
  }
  const out: string[] = [];
  for (const seg of parts.slice(1)) {
    if (seg === '.') {
      continue;
    }
    if (seg === '..') {
      throw new Error(`unsafe path: ${raw}`);
    }
    out.push(seg);
  }
  return out.length ? `${WORKSPACE_ROOT}/${out.join('/')}` : WORKSPACE_ROOT;
}

/** '/workspace/a/b.ts' -> 'a/b.ts' (display + tool results; never an fs call). */
export function relPath(abs: string): string {
  return abs.replace(/^\/workspace\/?/, '') || '.';
}

export function parentOf(absPath: string): string {
  const idx = absPath.lastIndexOf('/');
  return idx <= 0 ? WORKSPACE_ROOT : absPath.slice(0, idx);
}

/**
 * Virtual -> real. Every `container.fs` call and every `spawn` cwd goes through
 * this, so no caller has to remember the two-root split.
 */
export function toContainerPath(input: unknown): string {
  const virtual = safePath(input);
  return virtual === WORKSPACE_ROOT ? WORK_DIR : `${WORK_DIR}${virtual.slice(WORKSPACE_ROOT.length)}`;
}

/** Real -> virtual, for entries that come back out of the container. */
export function toVirtualPath(real: string): string {
  if (real === WORK_DIR) {
    return WORKSPACE_ROOT;
  }
  if (real.startsWith(`${WORK_DIR}/`)) {
    return `${WORKSPACE_ROOT}${real.slice(WORK_DIR.length)}`;
  }
  return safePath(real);
}

/**
 * A project-relative path, the form bolt.diy's tool schema uses. `undefined`/`.`
 * collapse to the root so "list the whole project" is spelled by omitting a path.
 */
export function projectRelative(input: unknown): string {
  const virtual = safePath(input);
  return virtual === WORKSPACE_ROOT ? '.' : relPath(virtual);
}
